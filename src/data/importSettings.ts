import type { McpOAuthCredentialBinding, McpServerConfig } from '../mcp/types';
import type { Connection } from '../providers/types';
import { normalizeEndpointUrl } from '../security/endpointUrl';
import {
  LOCAL_SECRET_KEY_STORAGE,
  sealSecretWithRawKey,
  secretStore,
} from '../security/secretStore';
import type { ExportBundle } from './importContract';

export interface PortableSecrets {
  connections: {
    id: string;
    apiKeys: string[];
    customHeaders?: Record<string, string>;
  }[];
  mcpServers: {
    id: string;
    bearer?: string;
    oauthAccess?: string;
    oauthRefresh?: string;
  }[];
}

export interface MaterializedImportSettings {
  settings: Record<string, unknown>;
  oauthAccessToClear: number;
  localSecretKey?: number[];
}

export async function materializeImportSettings(
  bundle: ExportBundle,
  passphrase?: string,
): Promise<MaterializedImportSettings> {
  let secrets: PortableSecrets = { connections: [], mcpServers: [] };
  if (bundle.encryptedSecrets) {
    if (!passphrase) throw new Error('该备份包含加密秘密，请输入备份口令');
    secrets = await secretStore.decryptBackup<PortableSecrets>(bundle.encryptedSecrets, passphrase);
  }

  let rawKey: number[] | undefined;
  let generated = false;
  const seal = async (plaintext: string, purpose: string): Promise<string> => {
    if (!rawKey) {
      const stored = (await chrome.storage.local.get(LOCAL_SECRET_KEY_STORAGE))[
        LOCAL_SECRET_KEY_STORAGE
      ];
      if (
        Array.isArray(stored) &&
        stored.length === 32 &&
        stored.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
      ) {
        rawKey = [...stored] as number[];
      } else {
        rawKey = [...crypto.getRandomValues(new Uint8Array(32))];
        generated = true;
      }
    }
    return sealSecretWithRawKey(plaintext, purpose, rawKey);
  };

  const settings = structuredClone(bundle.settings);
  if (Array.isArray(settings.connections)) {
    settings.connections = await Promise.all(
      (settings.connections as Connection[]).map(async (connection) => {
        const portable = secrets.connections.find((candidate) => candidate.id === connection.id);
        return {
          ...connection,
          apiKeys: await Promise.all(
            (portable?.apiKeys ?? []).map((value) => seal(value, 'provider-key')),
          ),
          customHeaders: portable?.customHeaders
            ? Object.fromEntries(
                await Promise.all(
                  Object.entries(portable.customHeaders).map(async ([name, value]) => [
                    name,
                    await seal(value, `provider:${connection.id}:header:${name.toLowerCase()}`),
                  ]),
                ),
              )
            : undefined,
        };
      }),
    );
  }

  let oauthAccessToClear = 0;
  if (Array.isArray(settings.mcp_servers)) {
    settings.mcp_servers = await Promise.all(
      (settings.mcp_servers as McpServerConfig[]).map(async (server) => {
        const portable = secrets.mcpServers.find((candidate) => candidate.id === server.id);
        const validated = {
          ...server,
          url: normalizeEndpointUrl(server.url, { label: `MCP 服务器 ${server.name} 的 URL` }),
        };
        if (server.auth.kind === 'bearer') {
          const token = portable?.bearer ?? '';
          return {
            ...validated,
            auth: {
              kind: 'bearer' as const,
              token: token ? await seal(token, `mcp:${server.id}:bearer`) : '',
            },
          };
        }
        if (server.auth.kind !== 'oauth' || !server.auth.tokens) return validated;
        if (portable?.oauthAccess) oauthAccessToClear += 1;
        const refresh = portable?.oauthRefresh;
        return {
          ...validated,
          auth: {
            ...server.auth,
            tokens: {
              access: '',
              refresh: refresh
                ? await seal(refresh, refreshPurpose(server.id, server.auth.binding))
                : undefined,
              expiresAt: server.auth.tokens.expiresAt,
            },
          },
        };
      }),
    );
  }

  return {
    settings,
    oauthAccessToClear,
    ...(generated && rawKey ? { localSecretKey: rawKey } : {}),
  };
}

function refreshPurpose(id: string, binding?: McpOAuthCredentialBinding): string {
  if (!binding) return `mcp:${id}:refresh`;
  const key = `${encodeURIComponent(binding.resource)}:${encodeURIComponent(binding.issuer)}`;
  return `mcp:${id}:oauth:${key}:refresh`;
}
