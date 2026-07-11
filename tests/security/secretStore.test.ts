import { beforeEach, describe, expect, it } from 'vitest';
import { SecretStore } from '../../src/security/secretStore';

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();

beforeEach(() => {
  local.clear();
  session.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: local.get(key) }),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) local.set(key, value);
        },
      },
      session: {
        get: async (key: string) => ({ [key]: session.get(key) }),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) session.set(key, value);
        },
        remove: async (key: string) => session.delete(key),
      },
    },
  };
});

describe('SecretStore', () => {
  it('seals persistent secrets with AES-GCM and authenticates their purpose', async () => {
    const secrets = new SecretStore();
    const sealed = await secrets.seal('sk-secret', 'provider-key');

    expect(sealed).not.toContain('sk-secret');
    await expect(secrets.unseal(sealed, 'provider-key')).resolves.toBe('sk-secret');
    await expect(secrets.unseal(sealed, 'mcp-bearer')).rejects.toThrow();
  });

  it('keeps OAuth access tokens in storage.session only', async () => {
    const secrets = new SecretStore();
    await secrets.setSessionSecret('mcp-a:access', 'access-token');

    await expect(secrets.getSessionSecret('mcp-a:access')).resolves.toBe('access-token');
    expect(JSON.stringify([...local.entries()])).not.toContain('access-token');
  });

  it('creates a portable PBKDF2 600000 iteration backup', async () => {
    const secrets = new SecretStore();
    const backup = await secrets.encryptBackup({ provider: 'sk-secret' }, 'correct horse');

    expect(backup.kdf.iterations).toBe(600_000);
    expect(JSON.stringify(backup)).not.toContain('sk-secret');
    await expect(secrets.decryptBackup(backup, 'correct horse')).resolves.toEqual({
      provider: 'sk-secret',
    });
    await expect(secrets.decryptBackup(backup, 'wrong passphrase')).rejects.toThrow();
  });
});
