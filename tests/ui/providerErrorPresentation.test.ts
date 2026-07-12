import { describe, expect, it } from 'vitest';
import { buildProviderErrorPresentation } from '../../src/ui/providerErrorPresentation';
import type { ProviderErrorKind, ProviderErrorReason } from '../../src/providers/types';

describe('buildProviderErrorPresentation', () => {
  it('formats the real status, upstream code, and message in diagnostic order', () => {
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

  it.each<[ProviderErrorReason, string, boolean]>([
    ['invalid_key', 'error.reason.invalid_key', true],
    ['permission_denied', 'error.reason.permission_denied', true],
    ['quota_exceeded', 'error.reason.quota_exceeded', true],
    ['endpoint_not_found', 'error.reason.endpoint_not_found', true],
    ['model_not_found', 'error.reason.model_not_found', true],
    ['invalid_request', 'error.reason.invalid_request', true],
    ['upstream_error', 'error.reason.upstream_error', false],
    ['response_format', 'error.reason.response_format', true],
  ])('maps reason %s before the broad kind', (reason, summaryKey, opensSettings) => {
    expect(
      buildProviderErrorPresentation({
        message: 'provider failed',
        kind: 'network',
        details: { reason },
      }),
    ).toMatchObject({
      summaryKey,
      guidanceKey: `error.guidance.${reason}`,
      opensSettings,
    });
  });

  it.each<ProviderErrorKind>([
    'auth',
    'rate_limit',
    'overloaded',
    'context_too_long',
    'content_filter',
    'network',
    'protocol',
  ])('falls back to broad kind %s', (kind) => {
    expect(buildProviderErrorPresentation({ message: 'provider failed', kind })).toMatchObject({
      summaryKey: `error.${kind}`,
      guidanceKey: `error.guidance.${kind}`,
      opensSettings: kind === 'auth' || kind === 'protocol',
    });
  });

  it('falls back to the raw event message when no known diagnosis exists', () => {
    expect(buildProviderErrorPresentation({ message: 'unclassified failure' })).toEqual({
      summary: 'unclassified failure',
      opensSettings: false,
    });
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'ignores inherited runtime diagnosis value %s',
    (inheritedName) => {
      expect(
        buildProviderErrorPresentation({
          message: 'event fallback',
          kind: inheritedName,
          details: { reason: inheritedName as ProviderErrorReason },
        }),
      ).toEqual({
        summary: 'event fallback',
        opensSettings: false,
      });
    },
  );

  it('uses sanitized raw detail only when an upstream message is unavailable', () => {
    expect(
      buildProviderErrorPresentation({
        message: 'response failed',
        kind: 'protocol',
        details: { raw: 'plain upstream failure' },
      }),
    ).toMatchObject({
      summaryKey: 'error.protocol',
      guidanceKey: 'error.guidance.protocol',
      detail: 'plain upstream failure',
    });
  });

  it('deduplicates equal upstream code and message parts', () => {
    expect(
      buildProviderErrorPresentation({
        message: 'response failed',
        details: {
          status: 429,
          upstreamCode: 'rate_limit',
          upstreamMessage: 'rate_limit',
          raw: 'raw response that should remain a fallback',
        },
      }).detail,
    ).toBe('HTTP 429 · rate_limit');
  });
});
