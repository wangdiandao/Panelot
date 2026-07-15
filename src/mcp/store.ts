import { secretStore } from '../security/secretStore';
import { normalizeEndpointUrl } from '../security/endpointUrl';
import { storageGet, storageSet } from '../settings/store';
import type { McpOAuthCredentialBinding, McpServerConfig } from './types';

export const MCP_SERVERS_KEY = 'mcp_servers';

function purpose(id: string, kind: 'bearer' | 'refresh'): string {
  return `mcp:${id}:${kind}`;
}

function bindingKey(binding: McpOAuthCredentialBinding): string {
  return `${encodeURIComponent(binding.resource)}:${encodeURIComponent(binding.issuer)}`;
}

export function mcpAccessSecretId(config: McpServerConfig): string | null {
  if (config.auth.kind !== 'oauth' || !config.auth.binding) return null;
  return `${config.id}:oauth-access:${bindingKey(config.auth.binding)}`;
}

function refreshPurpose(config: McpServerConfig): string {
  if (config.auth.kind !== 'oauth' || !config.auth.binding) {
    return purpose(config.id, 'refresh');
  }
  return `mcp:${config.id}:oauth:${bindingKey(config.auth.binding)}:refresh`;
}

export async function listMcpServers(): Promise<McpServerConfig[]> {
  return storageGet<McpServerConfig[]>(MCP_SERVERS_KEY, []);
}

export async function protectMcpServer(config: McpServerConfig): Promise<McpServerConfig> {
  const validated = {
    ...config,
    url: normalizeEndpointUrl(config.url, { label: `MCP 服务器 ${config.name} 的 URL` }),
  };
  if (config.auth.kind === 'bearer') {
    return {
      ...validated,
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
    const accessId = mcpAccessSecretId(config);
    if (tokens.access && accessId) await secretStore.setSessionSecret(accessId, tokens.access);
    return {
      ...validated,
      auth: {
        ...config.auth,
        tokens: {
          access: '',
          refresh: tokens.refresh
            ? secretStore.isSealed(tokens.refresh)
              ? tokens.refresh
              : await secretStore.seal(tokens.refresh, refreshPurpose(config))
            : undefined,
          expiresAt: tokens.expiresAt,
        },
      },
    };
  }
  return validated;
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
  const config = (await listMcpServers()).find((server) => server.id === id);
  if (!config) return null;
  const accessId = mcpAccessSecretId(config);
  return accessId ? secretStore.getSessionSecret(accessId) : null;
}

export async function readMcpRefresh(config: McpServerConfig): Promise<string | null> {
  if (config.auth.kind !== 'oauth' || !config.auth.binding || !config.auth.tokens?.refresh) {
    return null;
  }
  const refresh = config.auth.tokens.refresh;
  try {
    return secretStore.isSealed(refresh)
      ? await secretStore.unseal(refresh, refreshPurpose(config))
      : refresh;
  } catch {
    return null;
  }
}

export async function deleteMcpAccess(config: McpServerConfig): Promise<void> {
  const accessId = mcpAccessSecretId(config);
  if (accessId) await secretStore.deleteSessionSecret(accessId);
  await secretStore.deleteSessionSecret(`${config.id}:oauth-access`);
}
