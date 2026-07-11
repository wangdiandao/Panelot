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
    [500, 'overloaded'],
  ] as const)('maps %i → %s', (status, kind) => {
    expect(normalizeHttpError(status, '').kind).toBe(kind);
  });

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

  it('recognizes unknown-model error codes', () => {
    expect(
      normalizeHttpError(400, JSON.stringify({ error: { code: 'unknown_model' } })).details.reason,
    ).toBe('model_not_found');
  });

  it('reads top-level message, detail, numeric code, and plain text responses', () => {
    expect(normalizeHttpError(400, '{"message":"bad input","code":1001}').details).toMatchObject({
      upstreamCode: '1001',
      upstreamMessage: 'bad input',
    });
    expect(normalizeHttpError(422, '{"detail":"invalid tools"}').details).toMatchObject({
      upstreamMessage: 'invalid tools',
    });
    expect(normalizeHttpError(400, 'plain upstream failure').details).toMatchObject({
      raw: 'plain upstream failure',
      upstreamMessage: 'plain upstream failure',
    });
  });

  it.each([
    [401, 'bad key', 'invalid_key'],
    [403, 'account blocked', 'permission_denied'],
    [402, '{"message":"insufficient balance"}', 'quota_exceeded'],
    [400, '{"message":"quota exceeded"}', 'quota_exceeded'],
    [404, 'missing', 'endpoint_not_found'],
    [422, '{"detail":"invalid tools"}', 'invalid_request'],
    [500, 'gateway exploded', 'upstream_error'],
  ] as const)('classifies HTTP %i (%s) as %s', (status, body, reason) => {
    expect(normalizeHttpError(status, body).details).toMatchObject({ status, reason });
  });

  it('sanitizes and caps raw upstream text and extracted fields', () => {
    const error = normalizeHttpError(400, ` bad\u0000${'x'.repeat(2500)} `);
    expect(error.details.raw).not.toContain('\u0000');
    expect(error.details.raw).toHaveLength(2000);
    expect(error.details.upstreamMessage).toBe(error.details.raw);

    const jsonError = normalizeHttpError(
      400,
      JSON.stringify({ error: { message: 'bad\u0000message', type: 'invalid_request' } }),
    );
    expect(jsonError.details).toMatchObject({
      upstreamCode: 'invalid_request',
      upstreamMessage: 'badmessage',
    });
  });

  it('does not promote unrelated JSON fields into structured details', () => {
    const error = normalizeHttpError(
      400,
      JSON.stringify({
        message: 'bad input',
        code: 'invalid_request',
        authorization: 'Bearer fake-secret',
        headers: { 'x-api-key': 'fake-secret' },
      }),
    );

    expect(error.details.upstreamMessage).toBe('bad input');
    expect(error.details.upstreamCode).toBe('invalid_request');
    expect(error.details).not.toHaveProperty('authorization');
    expect(error.details).not.toHaveProperty('headers');
  });

  it('detects context_too_long from a 400 body', () => {
    expect(
      normalizeHttpError(400, 'This unknown model maximum context length is 8192 tokens'),
    ).toMatchObject({
      kind: 'context_too_long',
      details: { status: 400 },
    });
    expect(normalizeHttpError(400, 'invalid field foo').kind).toBe('protocol');
  });

  it('keeps quota attribution ahead of token-length wording', () => {
    expect(
      normalizeHttpError(400, 'token limit reached because quota balance is empty'),
    ).toMatchObject({
      kind: 'protocol',
      details: { reason: 'quota_exceeded' },
    });
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
