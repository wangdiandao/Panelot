import { describe, expect, it, vi } from 'vitest';
import {
  createKeyRing,
  createProviderFrameError,
  normalizeHttpError,
  parseRetryAfter,
  requestWithRetry,
  withRetry,
} from '../../src/providers/http';
import { ProviderError } from '../../src/providers/types';

const noSleep = () => Promise.resolve();

describe('requestWithRetry', () => {
  it('normalizes transport failures so provider requests can retry', async () => {
    const request = vi
      .fn<(apiKey: string) => Promise<Response>>()
      .mockRejectedValueOnce(new TypeError('socket closed'))
      .mockResolvedValueOnce(new Response('ok'));

    const response = await requestWithRetry(createKeyRing(['sticky']), request, {
      maxAttempts: 2,
      sleep: noSleep,
    });

    expect(await response.text()).toBe('ok');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(1, 'sticky');
    expect(request).toHaveBeenNthCalledWith(2, 'sticky');
  });

  it('normalizes HTTP failures with provider-specific request ids', async () => {
    const response = new Response('{"message":"bad request"}', {
      status: 400,
      headers: { 'x-trace-id': 'trace-a' },
    });

    await expect(
      requestWithRetry(createKeyRing(['key']), async () => response, {
        requestIdHeaders: ['request-id', 'x-trace-id'],
      }),
    ).rejects.toMatchObject({
      kind: 'protocol',
      details: { status: 400, requestId: 'trace-a' },
    });
  });
});

describe('createProviderFrameError', () => {
  it.each([
    ['insufficient_quota', 'request rejected'],
    ['insufficient_balance', 'request rejected'],
    ['insufficient_credits', 'request rejected'],
    ['billing_error', 'quota exceeded'],
    ['billing_error', 'current quota is zero'],
  ])('classifies quota signal %s / %s', (code, message) => {
    expect(createProviderFrameError(207, message, 'provider error', code)).toMatchObject({
      kind: 'rate_limit',
      details: { status: 207, reason: 'quota_exceeded', upstreamCode: code },
    });
  });

  it.each([
    'insufficient_permissions',
    'insufficient_permission',
    'permission_denied',
    'permission_error',
  ])('classifies permission code %s', (code) => {
    expect(createProviderFrameError(207, 'access rejected', 'provider error', code)).toMatchObject({
      kind: 'auth',
      details: { status: 207, reason: 'permission_denied', upstreamCode: code },
    });
  });

  it('keeps generic rate limits unqualified and invalid keys classified as authentication', () => {
    expect(
      createProviderFrameError(
        207,
        'requests arriving too quickly',
        'provider error',
        'rate_limit',
      ),
    ).toMatchObject({ kind: 'rate_limit', details: { status: 207 } });
    expect(
      createProviderFrameError(207, 'key rejected', 'provider error', 'invalid_api_key'),
    ).toMatchObject({ kind: 'auth', details: { status: 207, reason: 'invalid_key' } });
    expect(
      createProviderFrameError(207, 'requests arriving too quickly', 'provider error', 'rate_limit')
        .details.reason,
    ).toBeUndefined();
  });

  it.each(['rate_limit_error', 'rate_limit', 'rate_limited', 'too_many_requests'])(
    'refines canonical rate-limit code %s only for strong quota evidence',
    (code) => {
      expect(
        createProviderFrameError(207, 'credit quota exhausted', 'provider error', code),
      ).toMatchObject({ kind: 'rate_limit', details: { reason: 'quota_exceeded' } });
      expect(
        createProviderFrameError(207, 'requested model not found', 'provider error', code),
      ).toMatchObject({ kind: 'rate_limit' });
      expect(
        createProviderFrameError(207, 'provider overloaded', 'provider error', code),
      ).toMatchObject({ kind: 'rate_limit' });
      expect(
        createProviderFrameError(207, 'requested model not found', 'provider error', code).details
          .reason,
      ).toBeUndefined();
      expect(
        createProviderFrameError(207, 'provider overloaded', 'provider error', code).details.reason,
      ).toBeUndefined();
    },
  );

  it.each([
    ['overloaded_error', 'current quota is exhausted', 'overloaded', 'upstream_error'],
    ['invalid_request_error', 'quota exceeded', 'protocol', 'invalid_request'],
    ['model_not_found', 'rate limit reached', 'protocol', 'model_not_found'],
    ['invalid_api_key', 'permission denied for this operation', 'auth', 'invalid_key'],
  ])('prefers canonical code %s over conflicting message text', (code, message, kind, reason) => {
    expect(createProviderFrameError(207, message, 'provider error', code)).toMatchObject({
      kind,
      details: { status: 207, reason, upstreamCode: code, upstreamMessage: message },
    });
  });

  it('uses message heuristics when the code is absent or unknown', () => {
    expect(createProviderFrameError(207, 'current quota is zero', 'provider error')).toMatchObject({
      kind: 'rate_limit',
      details: { reason: 'quota_exceeded' },
    });
    expect(
      createProviderFrameError(207, 'provider overloaded', 'provider error', 'vendor_error'),
    ).toMatchObject({ kind: 'overloaded', details: { reason: 'upstream_error' } });
  });
});

describe('normalizeHttpError (docs/development/providers.md §7)', () => {
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

    const longCode = normalizeHttpError(
      400,
      JSON.stringify({ error: { code: `bad\u0000${'x'.repeat(2500)}` } }),
    ).details.upstreamCode;
    expect(longCode).not.toContain('\u0000');
    expect(longCode).toHaveLength(2000);
  });

  it('strips non-whitespace control characters while preserving tab and line breaks', () => {
    const body = 'a\u0000\u0008\u000b\u000c\u000e\u001f\u007fb\t\n\rc';

    expect(normalizeHttpError(400, body).details.upstreamMessage).toBe('ab\t\n\rc');
  });

  it.each([
    ['insufficient_quota', 'quota_exceeded'],
    ['insufficient_balance', 'quota_exceeded'],
  ] as const)('normalizes delimited quota code %s', (code, reason) => {
    expect(normalizeHttpError(400, JSON.stringify({ error: { code } })).details.reason).toBe(
      reason,
    );
  });

  it('normalizes delimited context-length codes', () => {
    expect(
      normalizeHttpError(400, JSON.stringify({ error: { code: 'context_length_exceeded' } })),
    ).toMatchObject({
      kind: 'context_too_long',
      details: { status: 400 },
    });
  });

  it.each([503, 529] as const)(
    'keeps HTTP %i overloaded even when the body mentions a missing model',
    (status) => {
      expect(normalizeHttpError(status, '{"error":{"code":"model_not_found"}}')).toMatchObject({
        kind: 'overloaded',
        details: { status, reason: 'upstream_error' },
      });
    },
  );

  it('keeps quota attribution ahead of overload attribution', () => {
    expect(normalizeHttpError(503, '{"error":{"code":"insufficient_quota"}}')).toMatchObject({
      kind: 'overloaded',
      details: { reason: 'quota_exceeded' },
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
    expect(JSON.stringify(error.details)).not.toContain('fake-secret');
  });

  it('redacts credentials from allowlisted upstream fields', () => {
    const error = normalizeHttpError(
      400,
      JSON.stringify({
        error: {
          code: 'api_key=code-secret',
          message: 'authorization: Bearer message-secret sk-message-secret',
        },
      }),
    );

    expect(error.details.upstreamCode).not.toContain('code-secret');
    expect(error.details.upstreamMessage).not.toContain('message-secret');
    expect(JSON.stringify(error.details)).not.toMatch(/code-secret|message-secret/);
  });

  it('redacts credentials from plain-text upstream responses', () => {
    const error = normalizeHttpError(
      400,
      'Authorization: Bearer bearer-secret api_key=key-secret apiKey: camel-secret sk-plain-secret',
    );

    expect(error.details.upstreamMessage).toContain('[REDACTED]');
    expect(JSON.stringify(error.details)).not.toMatch(
      /bearer-secret|key-secret|camel-secret|sk-plain-secret/,
    );
  });

  it.each([
    'API key: opaque-secret',
    'api_key=opaque-secret',
    'api-key: opaque-secret',
    '"api_key":"opaque-secret"',
    'Authorization: Basic opaque-secret',
    'Authorization: Bearer opaque-secret',
    'Authorization: Token opaque-secret',
    'x-api-key: opaque-secret',
  ])('redacts the complete labeled credential in %s', (body) => {
    const details = normalizeHttpError(400, body).details;
    expect(JSON.stringify(details)).not.toContain('opaque-secret');
    expect(details.upstreamMessage).toContain('[REDACTED]');
  });

  it('redacts quoted key-value text embedded in an allowlisted message', () => {
    const error = normalizeHttpError(
      400,
      JSON.stringify({ error: { message: 'upstream echoed "api_key":"opaque-secret"' } }),
    );

    expect(JSON.stringify(error.details)).not.toContain('opaque-secret');
    expect(error.details.upstreamMessage).toContain('[REDACTED]');
  });

  it('keeps ordinary prose without a credential label-value pattern', () => {
    const prose = 'Credential formats are documented, and access controls are configurable.';
    expect(normalizeHttpError(400, prose).details.upstreamMessage).toBe(prose);
  });

  it.each(['apiKey opaque-secret', 'api key opaque-secret', 'x-api-key opaque-secret'])(
    'redacts a whitespace-delimited opaque credential in %s',
    (body) => {
      const details = normalizeHttpError(400, body).details;
      expect(JSON.stringify(details)).not.toContain('opaque-secret');
      expect(details.upstreamMessage).toContain('[REDACTED]');
    },
  );

  it.each(['apiKey abcdefgh', 'api key ONLYLETTERS', 'x-api-key abcdef'])(
    'redacts a terminal pure-letter credential in %s',
    (body) => {
      const details = normalizeHttpError(400, body).details;
      expect(details.upstreamMessage).toContain('[REDACTED]');
      expect(details.upstreamMessage).not.toBe(body);
    },
  );

  it.each([
    'API key opaque-secret was rejected',
    'x-api-key opaque-secret is invalid',
    'apiKey abcdefgh remains unusable',
  ])('redacts a whitespace-delimited credential before trailing prose in %s', (body) => {
    const details = normalizeHttpError(400, body).details;
    expect(details.upstreamMessage).toContain('[REDACTED]');
    expect(JSON.stringify(details)).not.toMatch(/opaque-secret|abcdefgh/);
  });

  it('redacts mixed-case standalone SK credentials', () => {
    const details = normalizeHttpError(400, 'upstream echoed SK-MixedCase123').details;
    expect(JSON.stringify(details)).not.toContain('SK-MixedCase123');
    expect(details.upstreamMessage).toContain('[REDACTED]');
  });

  it('redacts an entire escaped quoted credential value without leaking a suffix', () => {
    const details = normalizeHttpError(400, String.raw`api_key="abc\"tail" after`).details;
    expect(JSON.stringify(details)).not.toMatch(/abc|tail/);
    expect(details.upstreamMessage).toBe('api_key=[REDACTED] after');
  });

  it('classifies structured JSON from known error fields only', () => {
    const error = normalizeHttpError(
      400,
      JSON.stringify({
        error: { message: 'invalid tools' },
        metadata: { quota: 'exceeded', model: 'unknown_model' },
        request: { prompt: 'context_length_exceeded' },
      }),
    );

    expect(error).toMatchObject({
      kind: 'protocol',
      details: { reason: 'invalid_request', upstreamMessage: 'invalid tools' },
    });
  });

  it('does not classify echoed request metadata when JSON has no error fields', () => {
    const error = normalizeHttpError(
      418,
      JSON.stringify({
        request: { prompt: 'quota exceeded for unknown_model context_length_exceeded' },
        authorization: 'Bearer fake-secret',
      }),
    );

    expect(error.details.reason).toBeUndefined();
    expect(JSON.stringify(error.details)).not.toContain('fake-secret');
  });

  it('does not treat JSON arrays as plain-text error fallbacks', () => {
    const error = normalizeHttpError(
      418,
      JSON.stringify(['quota exceeded for unknown_model', 'Bearer array-secret']),
    );

    expect(error.details.reason).toBeUndefined();
    expect(JSON.stringify(error.details)).not.toContain('array-secret');
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

  it('parses Retry-After HTTP dates and preserves provider request ids', () => {
    expect(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:55Z')),
    ).toBe(5000);
    expect(normalizeHttpError(429, '', '1', 'req_123').details.requestId).toBe('req_123');
  });
});

describe('key failover (docs/development/providers.md §8, sticky + failover)', () => {
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

  it('throws an auth error when all keys fail and the user must fix the connection', async () => {
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
      random: () => 1,
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

  it('adds bounded jitter to transient retry delays', async () => {
    const delays: number[] = [];
    const keys = createKeyRing(['k']);
    let calls = 0;
    await withRetry(
      keys,
      async () => {
        if (calls++ === 0) throw new ProviderError('network', 'down');
        return 'ok';
      },
      { sleep: async (ms) => void delays.push(ms), random: () => 0 },
    );
    expect(delays).toEqual([500]);
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

  it('removes the abort listener after a retry delay completes normally', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const keys = createKeyRing(['k']);
      const attempt = vi
        .fn()
        .mockRejectedValueOnce(new ProviderError('network', 'down'))
        .mockResolvedValueOnce('ok');
      const pending = withRetry(keys, attempt, {
        signal: controller.signal,
        baseDelayMs: 10,
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();

      await expect(pending).resolves.toBe('ok');
      const abortListener = add.mock.calls.find(([type]) => type === 'abort')?.[1];
      expect(abortListener).toBeDefined();
      expect(remove).toHaveBeenCalledWith('abort', abortListener);
    } finally {
      vi.useRealTimers();
    }
  });
});
