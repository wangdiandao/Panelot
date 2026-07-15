import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';

function issueMessage(result: ReturnType<ReturnType<typeof z.string>['safeParse']>): string {
  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected an invalid string value.');
  return result.error.issues[0]?.message ?? '';
}

describe('runtime schema locale isolation', () => {
  it('does not change the realm-wide Zod configuration or unrelated diagnostics', async () => {
    const previous = z.config();
    const previousCustomError = previous.customError;
    const previousLocaleError = previous.localeError;
    const sentinelCustomError: z.core.$ZodErrorMap = () => 'third-party custom error';
    const sentinelLocaleError: z.core.$ZodErrorMap = () => 'third-party locale error';

    try {
      z.config({ customError: sentinelCustomError, localeError: sentinelLocaleError });
      const configBeforeImport = z.config();
      const messageBeforeImport = issueMessage(z.string().safeParse(42));

      await import('../../src/agent/schema');

      const configAfterImport = z.config();
      expect(configAfterImport).toBe(configBeforeImport);
      expect(configAfterImport.customError).toBe(sentinelCustomError);
      expect(configAfterImport.localeError).toBe(sentinelLocaleError);
      expect(issueMessage(z.string().safeParse(42))).toBe(messageBeforeImport);
    } finally {
      z.config({ customError: previousCustomError, localeError: previousLocaleError });
    }
  });
});
