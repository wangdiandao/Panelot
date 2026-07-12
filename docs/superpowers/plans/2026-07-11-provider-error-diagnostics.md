# Provider Error Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve Provider HTTP diagnostics end-to-end and show users the real status, upstream error, and a targeted recovery instruction without exposing request secrets.

**Architecture:** Keep `ProviderErrorKind` as the stable retry taxonomy and add an optional `ProviderErrorDetails` value for status, fine-grained reason, upstream code/message, and sanitized response text. Produce those details in the shared HTTP layer, propagate them through Verify and `AgentEvent`, then use one pure UI presentation helper in both chat and Provider settings.

**Tech Stack:** TypeScript 6, React 19, WXT MV3 messaging, Vitest 4, Zustand, existing i18n helper.

---

## File map

- Modify `src/providers/types.ts`: define diagnostic types and attach them to `ProviderError` and `VerifyResult`.
- Modify `src/providers/http.ts`: sanitize, parse, and classify upstream HTTP errors.
- Modify `tests/providers/http.test.ts`: cover status/reason extraction, JSON/text formats, sanitization, and retry regressions.
- Modify `src/providers/openai.ts`: copy structured details into Verify results and mark response-format failures.
- Modify `tests/providers/adapters.test.ts`: verify details survive adapter/Verify handling.
- Modify `src/messaging/protocol.ts`: add optional Provider details to error events.
- Modify `src/agent/loop.ts`: emit structured Provider details.
- Modify `tests/agent/loop.test.ts`: prove diagnostics cross the engine boundary.
- Modify `src/ui/engineClient.ts`: preserve details in `lastError`.
- Modify `tests/ui/engineClient.test.ts`: prove the client store retains optional details.
- Create `src/ui/providerErrorPresentation.ts`: map kind/reason to localized summary/guidance keys and format safe details.
- Create `tests/ui/providerErrorPresentation.test.ts`: test presentation decisions without rendering React.
- Create `src/ui/components/ProviderErrorNotice.tsx`: render summary, upstream detail, and guidance as plain React text.
- Create `tests/ui/providerErrorNotice.test.ts`: verify server-rendered diagnostic markup without a browser harness.
- Modify `src/ui/i18n.ts`: add summaries and targeted guidance.
- Modify `src/ui/components/ThreadView.tsx`: render two-line chat diagnostics and relevant actions.
- Modify `src/ui/settings/ProvidersPage.tsx`: reuse the same presentation for Verify failures.

### Task 1: Structured HTTP diagnostics

**Files:**
- Modify: `src/providers/types.ts`
- Modify: `src/providers/http.ts`
- Test: `tests/providers/http.test.ts`

- [x] **Step 1: Write failing classification and sanitization tests**

Add focused cases to `tests/providers/http.test.ts`:

```ts
it('extracts an upstream model error from OpenAI-shaped JSON', () => {
  const error = normalizeHttpError(
    400,
    JSON.stringify({ error: { message: 'Model Not Exist', code: 'model_not_found' } }),
  );
  expect(error).toMatchObject({
    kind: 'protocol',
    details: {
      status: 400,
      reason: 'model_not_found',
      upstreamCode: 'model_not_found',
      upstreamMessage: 'Model Not Exist',
    },
  });
});

it('classifies endpoint, quota, invalid request, and upstream server errors', () => {
  expect(normalizeHttpError(404, 'missing').details.reason).toBe('endpoint_not_found');
  expect(normalizeHttpError(402, '{"message":"insufficient balance"}').details.reason).toBe(
    'quota_exceeded',
  );
  expect(normalizeHttpError(422, '{"detail":"invalid tools"}').details.reason).toBe(
    'invalid_request',
  );
  expect(normalizeHttpError(500, 'gateway exploded')).toMatchObject({
    kind: 'overloaded',
    details: { status: 500, reason: 'upstream_error' },
  });
});

it('sanitizes and caps raw upstream text', () => {
  const error = normalizeHttpError(400, `bad\u0000${'x'.repeat(2500)}`);
  expect(error.details.raw).not.toContain('\u0000');
  expect(error.details.raw!.length).toBeLessThanOrEqual(2000);
});
```

- [x] **Step 2: Run the HTTP tests and verify RED**

Run: `pnpm vitest run tests/providers/http.test.ts`

Expected: FAIL because `ProviderError.details` and the fine-grained reasons do not exist.

- [x] **Step 3: Add diagnostic types and parsing**

In `src/providers/types.ts`, define the shared payload and make the constructor backward-compatible for existing three-argument calls:

```ts
export type ProviderErrorReason =
  | 'invalid_key'
  | 'permission_denied'
  | 'quota_exceeded'
  | 'endpoint_not_found'
  | 'model_not_found'
  | 'invalid_request'
  | 'upstream_error'
  | 'response_format';

export interface ProviderErrorDetails {
  status?: number;
  reason?: ProviderErrorReason;
  upstreamCode?: string;
  upstreamMessage?: string;
  raw?: string;
}

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public retryAfterMs?: number,
    public details: ProviderErrorDetails = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
```

Add `details?: ProviderErrorDetails` to `VerifyResult`.

In `src/providers/http.ts`, add pure helpers before `normalizeHttpError`:

```ts
const MAX_UPSTREAM_TEXT = 2000;

function sanitizeUpstreamText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, MAX_UPSTREAM_TEXT);
}

function readUpstreamDetails(bodyText: string): ProviderErrorDetails {
  const raw = sanitizeUpstreamText(bodyText);
  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    return { raw, upstreamMessage: raw || undefined };
  }
  const root = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const nested =
    root.error && typeof root.error === 'object'
      ? (root.error as Record<string, unknown>)
      : root;
  const message = nested.message ?? root.message ?? root.detail;
  const code = nested.code ?? nested.type ?? root.code;
  return {
    raw,
    upstreamMessage:
      typeof message === 'string' ? sanitizeUpstreamText(message) || undefined : undefined,
    upstreamCode:
      typeof code === 'string' || typeof code === 'number' ? String(code) : undefined,
  };
}
```

Rewrite `normalizeHttpError` to set `status`, classify in the design order, preserve `Retry-After`, and return `kind: 'overloaded'` for other 5xx responses. Use the combined sanitized code/message/raw text for the finite keyword checks. Keep context-length detection ahead of general invalid-request handling.

- [x] **Step 4: Run HTTP tests and verify GREEN**

Run: `pnpm vitest run tests/providers/http.test.ts`

Expected: PASS, including the existing failover/backoff assertions.

- [x] **Step 5: Commit the HTTP diagnostic unit**

```bash
git add src/providers/types.ts src/providers/http.ts tests/providers/http.test.ts
git commit -m "feat: classify provider HTTP errors"
```

### Task 2: Adapter and Verify propagation

**Files:**
- Modify: `src/providers/openai.ts`
- Modify: `src/providers/anthropic.ts`
- Test: `tests/providers/adapters.test.ts`

- [x] **Step 1: Write failing Verify propagation tests**

Add a `describe('provider verification diagnostics')` block:

```ts
it('returns status and upstream details when the chat probe is rejected', async () => {
  vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-flash' }] }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'invalid_request', message: 'invalid tools' } }),
        { status: 400 },
      ),
    );

  await expect(new OpenAiAdapter(conn()).verify()).resolves.toMatchObject({
    failure: 'protocol_mismatch',
    details: {
      status: 400,
      reason: 'invalid_request',
      upstreamCode: 'invalid_request',
      upstreamMessage: 'invalid tools',
    },
  });
});
```

- [x] **Step 2: Run the adapter tests and verify RED**

Run: `pnpm vitest run tests/providers/adapters.test.ts`

Expected: FAIL because Verify drops `ProviderError.details`.

- [x] **Step 3: Copy details into Verify and mark format failures**

In `verifyConnection`, retain the current broad `failure` values for compatibility and add:

```ts
result.detail = e.details.upstreamMessage ?? e.message;
result.details = e.details;
```

When OpenAI or Anthropic receives HTTP 200 without a response body, create:

```ts
new ProviderError('protocol', 'response has no body', undefined, {
  reason: 'response_format',
  upstreamMessage: 'response has no body',
});
```

Apply the same `response_format` detail to provider error frames whose structure cannot be consumed as a successful model stream.

- [x] **Step 4: Run adapter and HTTP tests and verify GREEN**

Run: `pnpm vitest run tests/providers/adapters.test.ts tests/providers/http.test.ts`

Expected: PASS.

- [x] **Step 5: Commit adapter propagation**

```bash
git add src/providers/openai.ts src/providers/anthropic.ts tests/providers/adapters.test.ts
git commit -m "feat: expose provider verify diagnostics"
```

### Task 3: Engine protocol propagation

**Files:**
- Modify: `src/messaging/protocol.ts`
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

- [x] **Step 1: Write a failing agent event test**

Extend the test mock so one scripted response can reject, then add:

```ts
it('emits structured provider diagnostics on a failed model call', async () => {
  const error = new ProviderError('protocol', 'unexpected HTTP 400', undefined, {
    status: 400,
    reason: 'model_not_found',
    upstreamCode: 'model_not_found',
    upstreamMessage: 'Model Not Exist',
  });
  vi.spyOn(provider, 'stream').mockImplementation(() => {
    throw error;
  });
  const thread = await tree.createThread({});

  await runTurn(makeEnv(), thread.id, { text: 'hello' }).done;

  expect(events.find((event) => event.type === 'error')).toMatchObject({
    type: 'error',
    errorKind: 'protocol',
    providerDetails: {
      status: 400,
      reason: 'model_not_found',
      upstreamMessage: 'Model Not Exist',
    },
  });
});
```

- [x] **Step 2: Run the agent test and verify RED**

Run: `pnpm vitest run tests/agent/loop.test.ts`

Expected: FAIL because `AgentEvent` and the loop omit `providerDetails`.

- [x] **Step 3: Add the optional protocol field and emit it**

Import `ProviderErrorDetails` as a type into `src/messaging/protocol.ts` and extend only the `error` event:

```ts
providerDetails?: ProviderErrorDetails;
```

In the loop error emission add:

```ts
...(e instanceof ProviderError ? { errorKind: e.kind, providerDetails: e.details } : {}),
```

Keep the field optional so a reloaded UI can tolerate an older Service Worker during the existing schema-reload window.

- [x] **Step 4: Run agent and compile checks**

Run: `pnpm vitest run tests/agent/loop.test.ts && pnpm compile`

Expected: PASS with no protocol type errors.

- [x] **Step 5: Commit protocol propagation**

```bash
git add src/messaging/protocol.ts src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat: propagate provider error details"
```

### Task 4: Client state and presentation policy

**Files:**
- Modify: `src/ui/engineClient.ts`
- Modify: `tests/ui/engineClient.test.ts`
- Create: `src/ui/providerErrorPresentation.ts`
- Create: `tests/ui/providerErrorPresentation.test.ts`
- Modify: `src/ui/i18n.ts`

- [x] **Step 1: Write failing client and presentation tests**

Inside the existing `session outbox` test harness, deliver an error with `FakeTransport.emit` after its initialized event and assert the store retains details:

```ts
first.emit({
  type: 'error',
  code: 'provider_error',
  message: 'unexpected HTTP 404',
  retryable: false,
  errorKind: 'protocol',
  providerDetails: { status: 404, reason: 'endpoint_not_found' },
});
expect(session.store.getState().lastError).toMatchObject({
  kind: 'protocol',
  details: { status: 404, reason: 'endpoint_not_found' },
});
```

Create `tests/ui/providerErrorPresentation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildProviderErrorPresentation } from '../../src/ui/providerErrorPresentation';

it('formats status, upstream code, and message', () => {
  expect(
    buildProviderErrorPresentation({
      message: 'unexpected HTTP 400',
      kind: 'protocol',
      details: {
        status: 400,
        reason: 'model_not_found',
        upstreamCode: 'model_not_found',
        upstreamMessage: 'Model Not Exist',
      },
    }),
  ).toEqual({
    summaryKey: 'error.reason.model_not_found',
    guidanceKey: 'error.guidance.model_not_found',
    detail: 'HTTP 400 · model_not_found · Model Not Exist',
    opensSettings: true,
  });
});

it('falls back to kind and sanitized raw detail', () => {
  const view = buildProviderErrorPresentation({
    message: 'response failed',
    kind: 'protocol',
    details: { raw: 'plain upstream failure' },
  });
  expect(view).toMatchObject({ summaryKey: 'error.protocol', detail: 'plain upstream failure' });
});
```

- [x] **Step 2: Run client/presentation tests and verify RED**

Run: `pnpm vitest run tests/ui/engineClient.test.ts tests/ui/providerErrorPresentation.test.ts`

Expected: FAIL because details are dropped and the presentation helper does not exist.

- [x] **Step 3: Preserve client details and implement the pure presenter**

Change `ThreadUiState.lastError` to include `details?: ProviderErrorDetails`, then store `ev.providerDetails` in the error case.

Create `src/ui/providerErrorPresentation.ts` with a finite reason map:

```ts
export interface ProviderErrorViewInput {
  message: string;
  kind?: string;
  details?: ProviderErrorDetails;
}

export interface ProviderErrorPresentation {
  summaryKey?: string;
  summary?: string;
  guidanceKey?: string;
  detail?: string;
  opensSettings: boolean;
}

const PRESENTATION_BY_REASON = {
  model_not_found: ['error.reason.model_not_found', 'error.guidance.model_not_found'],
  endpoint_not_found: ['error.reason.endpoint_not_found', 'error.guidance.endpoint_not_found'],
  quota_exceeded: ['error.reason.quota_exceeded', 'error.guidance.quota_exceeded'],
  invalid_request: ['error.reason.invalid_request', 'error.guidance.invalid_request'],
  response_format: ['error.reason.response_format', 'error.guidance.response_format'],
} as const;
```

`buildProviderErrorPresentation` must:

1. Prefer the reason mapping, then `error.${kind}`, then the raw event message.
2. Build detail parts in order: `HTTP n`, upstream code, upstream message, raw fallback.
3. Deduplicate equal parts.
4. Set `opensSettings` for auth, endpoint, model, quota, invalid request, and response-format diagnoses.

Add all referenced Chinese and English keys to `src/ui/i18n.ts`, with concise summaries and actionable guidance matching the approved design.

- [x] **Step 4: Run client/presentation tests and verify GREEN**

Run: `pnpm vitest run tests/ui/engineClient.test.ts tests/ui/providerErrorPresentation.test.ts`

Expected: PASS.

- [x] **Step 5: Commit client presentation policy**

```bash
git add src/ui/engineClient.ts src/ui/providerErrorPresentation.ts src/ui/i18n.ts tests/ui/engineClient.test.ts tests/ui/providerErrorPresentation.test.ts
git commit -m "feat: present actionable provider errors"
```

### Task 5: Chat and Verify UI integration

**Files:**
- Create: `src/ui/components/ProviderErrorNotice.tsx`
- Modify: `src/ui/components/ThreadView.tsx`
- Modify: `src/ui/settings/ProvidersPage.tsx`
- Create: `tests/ui/providerErrorNotice.test.ts`

- [x] **Step 1: Write a failing plain-text rendering test**

Create `tests/ui/providerErrorNotice.test.ts` using React's server renderer:

```ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderErrorNotice } from '../../src/ui/components/ProviderErrorNotice';

describe('ProviderErrorNotice', () => {
  it('renders upstream detail as escaped plain text', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderErrorNotice, {
        error: {
          message: 'unexpected HTTP 404',
          kind: 'protocol',
          details: {
            status: 404,
            reason: 'endpoint_not_found',
            upstreamMessage: '<b>Route not found</b>',
          },
        },
      }),
    );
    expect(html).toContain('HTTP 404');
    expect(html).toContain('&lt;b&gt;Route not found&lt;/b&gt;');
    expect(html).not.toContain('<b>Route not found</b>');
  });
});
```

- [x] **Step 2: Run the notice test and verify RED**

Run: `pnpm vitest run tests/ui/providerErrorNotice.test.ts`

Expected: FAIL because `ProviderErrorNotice` does not exist.

- [x] **Step 3: Implement the shared text-only notice**

Create `src/ui/components/ProviderErrorNotice.tsx`. It accepts the same input as `buildProviderErrorPresentation`, calls that helper, and renders summary, detail, and guidance in three ordinary text nodes. It must not use `dangerouslySetInnerHTML`, Markdown, or raw HTML parsing.

```tsx
export function ProviderErrorNotice({ error }: { error: ProviderErrorViewInput }) {
  const view = buildProviderErrorPresentation(error);
  return (
    <div className="min-w-0 flex-1">
      <div>{view.summaryKey ? t(view.summaryKey) : view.summary}</div>
      {view.detail && <div className="break-words opacity-80">{view.detail}</div>}
      {view.guidanceKey && <div className="opacity-80">{t(view.guidanceKey)}</div>}
    </div>
  );
}
```

- [x] **Step 4: Run the notice test and verify GREEN**

Run: `pnpm vitest run tests/ui/providerErrorNotice.test.ts`

Expected: PASS and the upstream HTML-like text is escaped.

- [x] **Step 5: Render chat diagnostics**

Replace `humanizeError` in `ThreadView.tsx` with `buildProviderErrorPresentation` for action decisions and `ProviderErrorNotice` for text rendering:

```tsx
const errorView = state.lastError ? buildProviderErrorPresentation(state.lastError) : null;

<ProviderErrorNotice error={state.lastError} />
```

Show “打开设置” when `errorView.opensSettings`, not only for `auth`. Preserve the existing retry button logic.

- [x] **Step 6: Render Verify diagnostics with the same notice**

In `ProvidersPage.tsx`, convert `verifyResult.failure` plus `verifyResult.details` into the presenter input. Keep `FAILURE_TEXT` only as the fallback for failures without structured details. Under the status chips render summary, detail, and guidance as plain React text nodes.

- [x] **Step 7: Run UI, provider, and compile checks**

Run: `pnpm vitest run tests/ui/providerErrorPresentation.test.ts tests/ui/providerErrorNotice.test.ts tests/ui/engineClient.test.ts tests/providers/http.test.ts tests/providers/adapters.test.ts && pnpm compile`

Expected: PASS.

- [x] **Step 8: Commit UI integration**

```bash
git add src/ui/components/ProviderErrorNotice.tsx src/ui/components/ThreadView.tsx src/ui/settings/ProvidersPage.tsx tests/ui/providerErrorNotice.test.ts
git commit -m "feat: show upstream provider diagnostics"
```

### Task 6: Full verification and repository hygiene

**Files:**
- Verify all files changed in Tasks 1-5

- [x] **Step 1: Run formatting checks on changed source**

Run: `pnpm prettier --check src/providers/types.ts src/providers/http.ts src/providers/openai.ts src/providers/anthropic.ts src/messaging/protocol.ts src/agent/loop.ts src/ui/engineClient.ts src/ui/providerErrorPresentation.ts src/ui/i18n.ts src/ui/components/ProviderErrorNotice.tsx src/ui/components/ThreadView.tsx src/ui/settings/ProvidersPage.tsx tests/providers/http.test.ts tests/providers/adapters.test.ts tests/agent/loop.test.ts tests/ui/engineClient.test.ts tests/ui/providerErrorPresentation.test.ts tests/ui/providerErrorNotice.test.ts`

Expected: all files pass. If not, run the same command with `--write`, inspect the diff, and rerun `--check`.

- [x] **Step 2: Run the full unit suite**

Run: `pnpm test`

Expected: all Vitest tests pass.

- [x] **Step 3: Run type checking and lint**

Run: `pnpm compile && pnpm lint`

Expected: both commands exit 0 with no warnings.

- [x] **Step 4: Check scope and code hygiene**

Run:

```bash
git diff --check
git status --short
rg -n "console\.log|debugger|FIX-[0-9]+|P[0-9]+|C[0-9]+" src/providers src/agent/loop.ts src/messaging/protocol.ts src/ui tests/providers tests/agent/loop.test.ts tests/ui
```

Expected: no whitespace errors, no task-created temporary files, no new debug statements or repair-round comments. Existing unrelated dirty files remain untouched.

- [x] **Step 5: Review the final scoped diff**

Run: `git diff -- src/providers/types.ts src/providers/http.ts src/providers/openai.ts src/providers/anthropic.ts src/messaging/protocol.ts src/agent/loop.ts src/ui/engineClient.ts src/ui/providerErrorPresentation.ts src/ui/i18n.ts src/ui/components/ProviderErrorNotice.tsx src/ui/components/ThreadView.tsx src/ui/settings/ProvidersPage.tsx tests/providers/http.test.ts tests/providers/adapters.test.ts tests/agent/loop.test.ts tests/ui/engineClient.test.ts tests/ui/providerErrorPresentation.test.ts tests/ui/providerErrorNotice.test.ts`

Expected: only approved Provider diagnostics behavior, tests, translations, and UI rendering changes.

- [x] **Step 6: Commit any verification-only cleanup**

If formatting or hygiene produced changes, commit only those scoped files:

```bash
git add src/providers src/agent/loop.ts src/messaging/protocol.ts src/ui tests/providers tests/agent/loop.test.ts tests/ui
git commit -m "chore: finalize provider error diagnostics"
```
