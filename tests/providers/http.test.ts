import { describe, expect, it, vi } from 'vitest';
import { createKeyRing, normalizeHttpError, withRetry } from '../../src/providers/http';
import { ProviderError } from '../../src/providers/types';

const noSleep = () => Promise.resolve();

describe('normalizeHttpError (docs/03 §7)', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [429, 'rate_limit'],
    [503, 'overloaded'],
    [529, 'overloaded'],
    [500, 'protocol'],
  ] as const)('maps %i → %s', (status, kind) => {
    expect(normalizeHttpError(status, '').kind).toBe(kind);
  });

  it('detects context_too_long from a 400 body', () => {
    expect(normalizeHttpError(400, 'This model maximum context length is 8192 tokens').kind).toBe(
      'context_too_long',
    );
    expect(normalizeHttpError(400, 'invalid field foo').kind).toBe('protocol');
  });

  it('parses retry-after seconds', () => {
    expect(normalizeHttpError(429, '', '5').retryAfterMs).toBe(5000);
  });
});

describe('key failover (docs/03 §8, sticky + failover)', () => {
  it('stays sticky on success', async () => {
    const keys = createKeyRing(['k1', 'k2']);
    const attempt = vi.fn().mockResolvedValue('ok');
    await withRetry(keys, attempt, { sleep: noSleep });
    await withRetry(keys, attempt, { sleep: noSleep });
    expect(attempt).toHaveBeenNthCalledWith(1, 'k1');
    expect(attempt).toHaveBeenNthCalledWith(2, 'k1');
  });

  it('advances to the next key on auth failure without backoff', async () => {
    const keys = createKeyRing(['bad', 'good']);
    const attempt = vi.fn(async (k: string) => {
      if (k === 'bad') throw new ProviderError('auth', '401');
      return 'ok';
    });
    const result = await withRetry(keys, attempt, { sleep: noSleep });
    expect(result).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('throws auth error when ALL keys fail (user must fix)', async () => {
    const keys = createKeyRing(['a', 'b']);
    const attempt = vi.fn().mockRejectedValue(new ProviderError('auth', '401'));
    await expect(withRetry(keys, attempt, { sleep: noSleep })).rejects.toMatchObject({
      kind: 'auth',
    });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('fails over on 429 before backing off', async () => {
    const keys = createKeyRing(['k1', 'k2']);
    const attempt = vi.fn(async (k: string) => {
      if (k === 'k1') throw new ProviderError('rate_limit', '429');
      return 'ok';
    });
    const result = await withRetry(keys, attempt, { sleep: noSleep });
    expect(result).toBe('ok');
  });

  it('backs off exponentially on network errors then succeeds', async () => {
    const delays: number[] = [];
    const keys = createKeyRing(['k']);
    let calls = 0;
    const attempt = vi.fn(async () => {
      if (++calls < 3) throw new ProviderError('network', 'down');
      return 'ok';
    });
    const result = await withRetry(keys, attempt, {
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(result).toBe('ok');
    expect(delays).toEqual([1000, 2000]);
  });

  it('respects retry-after over exponential backoff', async () => {
    const delays: number[] = [];
    const keys = createKeyRing(['k']);
    let calls = 0;
    const attempt = vi.fn(async () => {
      if (++calls < 2) throw new ProviderError('rate_limit', '429', 7000);
      return 'ok';
    });
    await withRetry(keys, attempt, { sleep: async (ms) => void delays.push(ms) });
    expect(delays).toEqual([7000]);
  });

  it('does not retry context_too_long (not a transient failure)', async () => {
    const keys = createKeyRing(['k']);
    const attempt = vi.fn().mockRejectedValue(new ProviderError('context_too_long', 'too long'));
    await expect(withRetry(keys, attempt, { sleep: noSleep })).rejects.toMatchObject({
      kind: 'context_too_long',
    });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxAttempts', async () => {
    const keys = createKeyRing(['k']);
    const attempt = vi.fn().mockRejectedValue(new ProviderError('network', 'down'));
    const sleep = vi.fn(noSleep);
    await expect(withRetry(keys, attempt, { maxAttempts: 3, sleep })).rejects.toMatchObject({
      kind: 'network',
    });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('aborts while waiting between attempts', async () => {
    const controller = new AbortController();
    const keys = createKeyRing(['k']);
    const attempt = vi.fn().mockRejectedValue(new ProviderError('network', 'down'));
    const pending = withRetry(keys, attempt, {
      signal: controller.signal,
      baseDelayMs: 60_000,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
