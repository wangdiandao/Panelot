import { beforeEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncrypted } from '../../src/settings/crypto';

const store = new Map<string, unknown>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
  };
});

describe('API key encryption (docs/development/index.md §5)', () => {
  it('round-trips a secret through AES-GCM', async () => {
    const secret = 'sk-proj-abc123XYZ';
    const encrypted = await encryptSecret(secret);
    expect(encrypted).toMatch(/^secret:v1:/);
    expect(encrypted).not.toContain(secret);
    expect(await decryptSecret(encrypted)).toBe(secret);
  });

  it('reuses the same device key across calls (stable)', async () => {
    const a = await encryptSecret('one');
    const b = await encryptSecret('two');
    // Both decrypt correctly with the persisted KEK.
    expect(await decryptSecret(a)).toBe('one');
    expect(await decryptSecret(b)).toBe('two');
  });

  it('uses a fresh IV each call (ciphertexts differ for the same input)', async () => {
    const a = await encryptSecret('same');
    const b = await encryptSecret('same');
    expect(a).not.toBe(b);
    expect(await decryptSecret(a)).toBe('same');
    expect(await decryptSecret(b)).toBe('same');
  });

  it('passes plaintext through (pre-encryption / session mode)', async () => {
    expect(await decryptSecret('plain-key')).toBe('plain-key');
    expect(isEncrypted('plain-key')).toBe(false);
    expect(isEncrypted('enc:xxx')).toBe(true);
    expect(isEncrypted('secret:v1:iv:ciphertext')).toBe(true);
  });
});
