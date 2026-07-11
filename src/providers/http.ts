/**
 * Shared HTTP layer for both adapters: error normalization (docs/03 §7),
 * sticky-key failover (docs/03 §8), and retry with backoff.
 *
 * Retry happens ONLY at this per-LLM-call layer; tool execution errors are
 * the model's domain (docs/03 §7).
 */

import { ProviderError } from './types';

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
  if (status === 401 || status === 403) {
    return new ProviderError('auth', `authentication failed (${status})`, undefined, bodyText);
  }
  if (status === 429) {
    return new ProviderError('rate_limit', 'rate limited (429)', retryAfterMs, bodyText);
  }
  if (status === 529 || status === 503) {
    return new ProviderError(
      'overloaded',
      `provider overloaded (${status})`,
      retryAfterMs,
      bodyText,
    );
  }
  // Context-length errors surface as 400 with a recognizable message on both protocols.
  if (status === 400 && /context|token|length|too long|maximum/i.test(bodyText)) {
    return new ProviderError('context_too_long', 'context window exceeded', undefined, bodyText);
  }
  return new ProviderError('protocol', `unexpected HTTP ${status}`, undefined, bodyText);
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
