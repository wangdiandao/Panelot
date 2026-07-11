import { secretStore } from '../security/secretStore';
import { storageGet, storageSet } from '../settings/store';
import type { McpServerConfig } from './types';

export const MCP_SERVERS_KEY = 'mcp_servers';

function purpose(id: string, kind: 'bearer' | 'refresh'): string {
  return `mcp:${id}:${kind}`;
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  return storageGet<McpServerConfig[]>(MCP_SERVERS_KEY, []);
}

export async function protectMcpServer(config: McpServerConfig): Promise<McpServerConfig> {
  if (config.auth.kind === 'bearer') {
    return {
      ...config,
      auth: {
        kind: 'bearer',
        token: secretStore.isSealed(config.auth.token)
          ? config.auth.token
          : await secretStore.seal(config.auth.token, purpose(config.id, 'bearer')),
      },
    };
  }
  if (config.auth.kind === 'oauth' && config.auth.tokens) {
    const tokens = config.auth.tokens;
    if (tokens.access)
      await secretStore.setSessionSecret(`${config.id}:oauth-access`, tokens.access);
    return {
      ...config,
      auth: {
        ...config.auth,
        tokens: {
          access: '',
          refresh: tokens.refresh
            ? secretStore.isSealed(tokens.refresh)
              ? tokens.refresh
              : await secretStore.seal(tokens.refresh, purpose(config.id, 'refresh'))
            : undefined,
          expiresAt: tokens.expiresAt,
        },
      },
    };
  }
  return config;
}

export async function saveMcpServers(configs: McpServerConfig[]): Promise<void> {
  await storageSet(MCP_SERVERS_KEY, await Promise.all(configs.map(protectMcpServer)));
}

export async function readMcpBearer(config: McpServerConfig): Promise<string | null> {
  if (config.auth.kind !== 'bearer') return null;
  return secretStore.isSealed(config.auth.token)
    ? secretStore.unseal(config.auth.token, purpose(config.id, 'bearer'))
    : config.auth.token;
}

export async function readMcpAccess(id: string): Promise<string | null> {
  return secretStore.getSessionSecret(`${id}:oauth-access`);
}

export async function readMcpRefresh(config: McpServerConfig): Promise<string | null> {
  if (config.auth.kind !== 'oauth' || !config.auth.tokens?.refresh) return null;
  const refresh = config.auth.tokens.refresh;
  return secretStore.isSealed(refresh)
    ? secretStore.unseal(refresh, purpose(config.id, 'refresh'))
    : refresh;
}
