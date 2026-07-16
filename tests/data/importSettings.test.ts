import { beforeEach, describe, expect, it } from 'vitest';
import type { ExportBundle } from '../../src/data/importContract';
import { materializeImportSettings, parsePortableSecrets } from '../../src/data/importSettings';
import { secretStore } from '../../src/security/secretStore';

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
  };
});

describe('portable import secrets', () => {
  it('validates the complete decrypted structure before materializing settings', () => {
    expect(
      parsePortableSecrets({
        connections: [
          {
            id: 'provider-1',
            apiKeys: ['key-1'],
            customHeaders: { Authorization: 'Bearer token' },
          },
        ],
        mcpServers: [{ id: 'mcp-1', bearer: 'token' }],
      }),
    ).toEqual({
      connections: [
        {
          id: 'provider-1',
          apiKeys: ['key-1'],
          customHeaders: { Authorization: 'Bearer token' },
        },
      ],
      mcpServers: [{ id: 'mcp-1', bearer: 'token' }],
    });

    expect(() =>
      parsePortableSecrets({
        connections: [
          { id: 'provider-1', apiKeys: ['key'] },
          { id: 'provider-1', apiKeys: [] },
        ],
        mcpServers: [],
      }),
    ).toThrow('IMPORT_SECRET_BACKUP_CONNECTION_ID');
    expect(() =>
      parsePortableSecrets({
        connections: [{ id: 'provider-1', apiKeys: [], customHeaders: { Authorization: 17 } }],
        mcpServers: [],
      }),
    ).toThrow('IMPORT_SECRET_BACKUP_HEADER');
    expect(() =>
      parsePortableSecrets({ connections: [], mcpServers: [], unexpected: true }),
    ).toThrow('IMPORT_SECRET_BACKUP');
  });

  it('rejects malformed authenticated plaintext before any secret is sealed', async () => {
    const encryptedSecrets = await secretStore.encryptBackup(
      { connections: 'not-an-array', mcpServers: [] },
      'correct horse',
    );
    const bundle: ExportBundle = {
      version: 2,
      exportedAt: 1,
      threads: [],
      nodes: [],
      skills: [],
      memories: [],
      settings: {},
      encryptedSecrets,
    };

    await expect(materializeImportSettings(bundle, 'correct horse')).rejects.toThrow(
      'IMPORT_SECRET_BACKUP_CONNECTIONS',
    );
  });
});
