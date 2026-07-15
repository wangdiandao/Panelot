import { beforeEach, describe, expect, it } from 'vitest';
import {
  MCP_SERVERS_KEY,
  readMcpAccess,
  readMcpRefresh,
  saveMcpServers,
} from '../../src/mcp/store';
import type { McpServerConfig } from '../../src/mcp/types';

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

describe('MCP OAuth secret partitioning', () => {
  it('does not expose access or refresh tokens through a different issuer binding', async () => {
    const config: McpServerConfig = {
      id: 'server-1',
      name: 'Remote MCP',
      url: 'https://mcp.example.com/mcp',
      auth: {
        kind: 'oauth',
        clientId: 'client-a',
        binding: {
          resource: 'https://mcp.example.com/mcp',
          issuer: 'https://auth-a.example.com',
        },
        tokens: {
          access: 'access-a',
          refresh: 'refresh-a',
          expiresAt: Date.now() + 3_600_000,
        },
      },
      enabled: true,
      disabledTools: [],
      connectOnStartup: false,
    };
    await saveMcpServers([config]);

    await expect(readMcpAccess(config.id)).resolves.toBe('access-a');
    const [stored] = local.get(MCP_SERVERS_KEY) as McpServerConfig[];
    await expect(readMcpRefresh(stored!)).resolves.toBe('refresh-a');

    const rebound: McpServerConfig = {
      ...stored!,
      auth: {
        ...stored!.auth,
        kind: 'oauth',
        binding: {
          resource: 'https://mcp.example.com/mcp',
          issuer: 'https://auth-b.example.com',
        },
      },
    };
    await saveMcpServers([rebound]);

    await expect(readMcpAccess(config.id)).resolves.toBeNull();
    const [storedRebound] = local.get(MCP_SERVERS_KEY) as McpServerConfig[];
    await expect(readMcpRefresh(storedRebound!)).resolves.toBeNull();
    expect(JSON.stringify([...local.entries()])).not.toContain('access-a');
  });
});
