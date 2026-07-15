import { describe, expect, it } from 'vitest';
import {
  isProviderErrorRetryable,
  ProviderError,
  type ProviderErrorKind,
} from '../../src/providers/types';

describe('provider error retryability', () => {
  it.each<[ProviderErrorKind, boolean]>([
    ['network', true],
    ['rate_limit', true],
    ['overloaded', true],
    ['auth', false],
    ['context_too_long', false],
    ['content_filter', false],
    ['protocol', false],
  ])('classifies %s as retryable=%s', (kind, expected) => {
    expect(isProviderErrorRetryable(new ProviderError(kind, 'provider failed'))).toBe(expected);
    expect(isProviderErrorRetryable(kind)).toBe(expected);
  });

  it('fails closed for an error kind added upstream before this policy is updated', () => {
    expect(isProviderErrorRetryable('unknown_provider_failure')).toBe(false);
  });
});
