/**
 * Shared HTTP layer for both adapters: error normalization (docs/03 §7),
 * sticky-key failover (docs/03 §8), and retry with backoff.
 *
 * Retry happens ONLY at this per-LLM-call layer; tool execution errors are
 * the model's domain (docs/03 §7).
 */

import { ProviderError, type ProviderErrorDetails, type ProviderErrorReason } from './types';

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
    root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : root;
  const message = nested.message ?? root.message ?? root.detail;
  const code = nested.code ?? nested.type ?? root.code;
  return {
    raw,
    upstreamMessage:
      typeof message === 'string' ? sanitizeUpstreamText(message) || undefined : undefined,
    upstreamCode:
      typeof code === 'string' || typeof code === 'number'
        ? sanitizeUpstreamText(String(code)) || undefined
        : undefined,
  };
}

function classifyReason(status: number, searchableText: string): ProviderErrorReason | undefined {
  if (status === 401) return 'invalid_key';
  if (status === 403) return 'permission_denied';
  if (isQuotaError(status, searchableText)) return 'quota_exceeded';
  if (status === 404) return 'endpoint_not_found';
  if (status === 503 || status === 529) return 'upstream_error';
  if (
    /\bmodel[_\s-]*(?:not[_\s-]*(?:found|exist)|unknown)\b|\b(?:unknown|missing)[_\s-]+model\b|\bmodel\b.{0,24}\b(?:does not exist|not found)\b/i.test(
      searchableText,
    )
  ) {
    return 'model_not_found';
  }
  if (status === 400 || status === 409 || status === 422) return 'invalid_request';
  if (status >= 500 && status <= 599) return 'upstream_error';
  return undefined;
}

function isQuotaError(status: number, searchableText: string): boolean {
  return (
    status === 402 ||
    /\b(?:quota|balance|credit|credits)\b|insufficient\s+(?:funds?|balance|credits?)/i.test(
      searchableText,
    )
  );
}

function isContextLengthError(status: number, searchableText: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) return false;
  return (
    /\bcontext(?:\s+window)?(?:\s+length)?\b.{0,32}\b(?:exceed|maximum|limit|too\s+long)/i.test(
      searchableText,
    ) ||
    /\b(?:exceed|maximum|limit|length|too\s+(?:many|long))\b.{0,32}\btokens?\b/i.test(
      searchableText,
    ) ||
    /\btokens?\b.{0,32}\b(?:exceed|maximum|limit|length|too\s+(?:many|long))\b/i.test(
      searchableText,
    )
  );
}

export interface KeyRing {
  /** Returns the current sticky key (may be '' for keyless local endpoints). */
  current(): string;
  /** Rotate to the next key after auth/rate-limit failure. Returns false if exhausted. */
  advance(): boolean;
  reset(): void;
}

/** Sticky key + failover-on-error (kinder to provider-side prompt caches than round-robin). */
export function createKeyRing(keys: string[]): KeyRing {
  const ring = keys.length > 0 ? keys : [''];
  let index = 0;
  let failures = 0;
  return {
    current: () => ring[index % ring.length]!,
    advance: () => {
      failures++;
      if (failures >= ring.length) return false;
      index = (index + 1) % ring.length;
      return true;
    },
    reset: () => {
      failures = 0;
    },
  };
}

export function normalizeHttpError(
  status: number,
  bodyText: string,
  retryAfterHeader?: string | null,
): ProviderError {
  const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 || undefined : undefined;
  const details = readUpstreamDetails(bodyText);
  const searchableText = [details.upstreamCode, details.upstreamMessage, details.raw]
    .filter(Boolean)
    .join(' ')
    .replace(/[_-]+/g, ' ');

  if (!isQuotaError(status, searchableText) && isContextLengthError(status, searchableText)) {
    return new ProviderError('context_too_long', 'context window exceeded', undefined, {
      ...details,
      status,
    });
  }

  const reason = classifyReason(status, searchableText);
  const diagnosticDetails = { ...details, status, reason };

  if (status === 401 || status === 403) {
    return new ProviderError(
      'auth',
      `authentication failed (${status})`,
      undefined,
      diagnosticDetails,
    );
  }
  if (status === 429) {
    return new ProviderError('rate_limit', 'rate limited (429)', retryAfterMs, diagnosticDetails);
  }
  if (status >= 500 && status <= 599) {
    return new ProviderError(
      'overloaded',
      status === 503 || status === 529
        ? `provider overloaded (${status})`
        : `upstream server error (${status})`,
      retryAfterMs,
      diagnosticDetails,
    );
  }
  return new ProviderError('protocol', `unexpected HTTP ${status}`, undefined, diagnosticDetails);
}

export interface RetryOptions {
  /** Base delay 1s, ×2, cap 32s, max 4 attempts (docs/03 §7). */
  maxAttempts?: number;
  baseDelayMs?: number;
  capDelayMs?: number;
  signal?: AbortSignal;
  /** Injectable clock for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      },
      { once: true },
    );
  });

/**
 * Run `attempt` with normalized retry semantics:
 *  - auth → advance key ring; if exhausted, throw (user must fix keys)
 *  - rate_limit / overloaded → failover key first if available, else backoff
 *  - network → backoff
 *  - everything else → throw immediately
 */
export async function withRetry<T>(
  keys: KeyRing,
  attempt: (apiKey: string) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.capDelayMs ?? 32_000;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const result = await attempt(keys.current());
      keys.reset();
      return result;
    } catch (e) {
      lastError = e;
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      if (!(e instanceof ProviderError)) throw e;
      if (i === maxAttempts - 1) throw e;

      switch (e.kind) {
        case 'auth': {
          if (!keys.advance()) throw e; // all keys invalid → user problem
          continue; // retry immediately with next key, no backoff
        }
        case 'rate_limit':
        case 'overloaded': {
          if (keys.advance()) continue; // failover first when multi-key
          const delay = e.retryAfterMs ?? Math.min(base * 2 ** i, cap);
          await sleep(delay, opts.signal);
          continue;
        }
        case 'network': {
          const delay = Math.min(base * 2 ** i, cap);
          await sleep(delay, opts.signal);
          continue;
        }
        default:
          throw e; // context_too_long / content_filter / protocol: not retryable here
      }
    }
  }
  throw lastError;
}
