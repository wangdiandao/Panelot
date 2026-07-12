import { describe, expect, it } from 'vitest';
import { actionError, serializeActionFailure } from '../../src/tools/action/errors';

describe('structured action failures', () => {
  it('preserves stable recovery metadata', () => {
    const failure = serializeActionFailure(
      actionError('occluded', 'covered', 'precheck', true, { blocker: 'dialog' }),
    );
    expect(failure).toEqual({
      code: 'occluded',
      message: 'covered',
      phase: 'precheck',
      retryable: true,
      details: { blocker: 'dialog' },
    });
  });

  it('maps legacy errors without guessing a retry policy', () => {
    expect(serializeActionFailure(new Error('legacy'))).toMatchObject({
      code: 'unknown',
      message: 'legacy',
      retryable: false,
    });
  });
});
