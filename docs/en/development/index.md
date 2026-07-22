# Development guide

> Start with the [user guide](../guide/) for product behavior and [Architecture and messaging](./architecture.md) for runtime topology.
>
> This section records behavior that can be checked against the current repository. Unmeasured goals belong in [Experience targets](./experience-targets.md).

## 1. Requirements

| Item | Requirement | Source |
| --- | --- | --- |
| Node.js | `^20.19.0 || >=22.12.0` | `package.json#engines`; GitHub Actions uses `22.12.0` |
| pnpm | `9.12.3` | `package.json#packageManager` and lockfile v9 |
| Browser | Chrome 116+ | `wxt.config.ts`; Edge is also a build target |
| Playwright Chromium | Required only for e2e | `playwright.config.ts` defines a Chromium project |

There is no required `.env` file. Configure model endpoints, API keys, permissions, Skills, and MCP servers through extension settings.

## 2. Install and run

```bash
pnpm install
pnpm dev
```

`postinstall` runs `wxt prepare`. Development output is written to `dist/chrome-mv3-dev`. If WXT cannot launch a browser, load that directory manually from `chrome://extensions`.

Refreshing a page does not update the extension service worker. Reload Panelot after changing `entrypoints/background.ts`, engine, agent, Gatekeeper, or background tool code.

The VitePress site shares the root package and lockfile:

```bash
pnpm docs:dev
pnpm docs:i18n:check
pnpm docs:build
pnpm docs:preview
```

Chinese pages are canonical. `docs:i18n:check` requires a matching English path for every published Chinese page. `docs:build` runs that check before rendering and validating links.

## 3. Repository map

| Path | Responsibility |
| --- | --- |
| `entrypoints/background.ts` | Compose the database, engine, providers, Gatekeeper, browser tools, Skills, MCP, and Chrome events |
| `entrypoints/page-executor.unlisted.ts` | Injected L1 page executor, action indicator, and manual-takeover listener |
| `entrypoints/mcp-worker/` | MCP SDK client and canonical import validation in an offscreen document |
| `entrypoints/sidepanel/`, `chat/`, `options/` | UI entrypoints |
| `src/engine/` | Op dispatch, Thread and Turn lifecycle, queues, approvals, interactions, and recovery |
| `src/agent/` | Agent loop, tool registry, and argument validation |
| `src/messaging/` | Shared protocol, validation, and Port or direct transports |
| `src/db/`, `src/data/` | Dexie schema, conversation tree, context derivation, import, export, and maintenance |
| `src/providers/` | OpenAI and Anthropic wire formats, SSE, retry, key failover, model listing, and verification |
| `src/tools/` | L0 tab tools, L1 content-script tools, L2 CDP tools, and built-ins |
| `src/gatekeeper/`, `src/permissions/` | Approval policy, rules, sensitive origins, and host access |
| `src/skills/`, `src/plugins/`, `src/mcp/` | Extensible instruction, data asset, and remote capability systems |
| `src/prompts/` | Kernel prompt, layered assembly, and untrusted-content boundaries |
| `src/ui/` | EngineClient, shared UI, settings, themes, shortcuts, and i18n |
| `tests/`, `e2e/` | Vitest contracts and real Chromium extension flows |
| `docs/`, `docs/en/` | Canonical Chinese documentation and matching English translations |

## 4. Runtime path

```text
Side panel or chat UI
  -> EngineClient
  -> chrome.runtime Port (Op)
  -> EngineHost
  -> RealEngineCore
  -> runTurn
      -> buildSessionContext
      -> SettingsProviderResolver
      -> ToolRegistry -> GatekeeperService
  -> ThreadTree and PanelotDB checkpoints
  -> AgentEvent broadcast to subscribed UIs
```

The UI is a reconnectable view, not a second state authority. Persisted snapshots provide conversation paths and completed tool results. Streaming deltas are temporary overlays.

## 5. Settings and local data

`chrome.storage.local` holds provider connections, model presets, global settings, recent model choices, site instructions, permission rules, sensitive origins, and MCP configuration. Secrets use local AES-GCM envelopes. Encryption reduces plaintext inspection and accidental export but does not defend against an attacker who can read the browser profile.

Dexie database `panelot_v1` stores Threads, append-only nodes, attachments, Skills, memories, Runs, command receipts, approvals, interactions, Plugins, and Plugin assets. JSON export omits attachment Blobs and installed Plugins. Import validates twice, replaces managed data, and requires an extension reload before new agent commands are accepted.

See [Data model and storage](./data-model.md) for transaction and recovery rules.

## 6. Commands

| Command | Purpose |
| --- | --- |
| `pnpm compile` | Validate protocol manifests and all TypeScript configurations |
| `pnpm protocol:check` | Check engine and content-script semantic manifests |
| `pnpm protocol:write` | Write reviewed protocol schema hashes |
| `pnpm lint` | Run ESLint and React Hooks rules |
| `pnpm format:check` | Check Prettier-managed source and configuration files |
| `pnpm test` | Run Vitest unit and integration tests |
| `pnpm test:coverage` | Run V8 coverage thresholds |
| `pnpm e2e` | Build and test the extension in persistent Chromium |
| `pnpm build`, `pnpm build:edge` | Build Chrome or Edge MV3 output |
| `pnpm budget` | Check production JavaScript and background static-graph budgets |
| `pnpm zip`, `pnpm zip:edge` | Create release archives |
| `pnpm zip:smoke -- <zips...>` | Validate archive manifests, permissions, and source maps |

CI runs formatting, lint, compile, documentation, e2e, both browser builds, bundle budgets, archive smoke tests, and a separate coverage job. Release tags must point to a commit on `main` with a successful main CI run.

## 7. Test boundaries

Use unit tests for pure functions and state machines, Node integration tests for Dexie, transport, and engine flows, and Playwright only for browser-context behavior. Tests must not depend on a user profile, real provider, execution order, or network access.

The overall V8 thresholds are 58% for lines and 50% for branches, with higher per-file branch thresholds for critical run, Gatekeeper, rule, secret-store, and import code. Provider verification against a real third-party endpoint remains an external compatibility check.

## 8. Common development failures

- Reload the extension after background changes. A page refresh is insufficient.
- A sandbox can report `spawn EPERM` before Vitest or Playwright collects tests. Rerun in an environment that permits child processes.
- Install Chromium with `pnpm exec playwright install chromium` when Playwright cannot find it.
- Provider verification requires optional access to the endpoint origin.
- Large Vite chunks are warnings. CI enforces executable budgets, including a 4 MB production JavaScript limit, 500 KiB shared eager UI limit, 230 KiB `background.js` entry limit, and 406 KiB recursive background static graph limit.

MV3 extension service workers do not support runtime `import()`. Do not use dynamic imports to evade background graph measurement.

## 9. Documentation and code rules

Read the relevant Chinese page, implementation, and tests before changing behavior. Keep shared protocol types in `src/messaging/protocol.ts`, UI tokens in `src/ui/styles/global.css`, shortcuts in `src/ui/shortcuts.ts`, and the kernel prompt in `src/prompts/kernel.ts`.

Every published Chinese page needs the same relative path under `docs/en/`. Update both locale navigation entries and run `pnpm docs:build`. The Chinese page decides meaning when translations disagree.

## 10. Release packaging

Run the same gates as the release workflow, create both browser archives, and validate them with `zip:smoke`. A release is complete only after GitHub Actions succeeds and the GitHub Release contains both ZIP files, SBOMs, and checksums.
