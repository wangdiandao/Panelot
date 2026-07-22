/**
 * Data export/import (docs/development/index.md §5): full JSON export (keys stripped by default),
 * import validation/materialization, and single-thread Markdown export. All local; no cloud.
 */

import type { PanelotDB } from '../db/schema';
import { buildSessionContext } from '../db/sessionContext';
import { ThreadTree } from '../db/tree';
import { SettingsStore, storageGet } from '../settings/store';
import type {
  AssistantMessagePayload,
  ToolCallPayload,
  ToolResultPayload,
  UserMessagePayload,
} from '../db/types';
import { secretStore } from '../security/secretStore';
import { decryptHeaderValue, decryptSecret } from '../settings/crypto';
import type { Connection } from '../providers/types';
import type { McpServerConfig } from '../mcp/types';
import { readMcpAccess, readMcpBearer, readMcpRefresh } from '../mcp/store';
import type { PortableSecrets } from './importSettings';
import {
  IMPORT_SETTINGS_KEYS,
  type ExportBundle,
  type ImportValidationResult,
} from './importContract';
import { validatePortableExport } from './importValidator';

export { materializeImportSettings, type MaterializedImportSettings } from './importSettings';
export {
  IMPORT_SETTINGS_KEYS,
  type ExportBundle,
  type ImportValidationResult,
} from './importContract';

/**
 * Full JSON export. Attachments (blobs) are omitted to keep the file portable;
 * API keys are stripped from connections unless includeKeys is set.
 */
export async function exportAll(
  db: PanelotDB,
  opts: { secretBackupPassphrase?: string } = {},
): Promise<ExportBundle> {
  const [threads, nodes, skills, memories] = await Promise.all([
    db.threads.toArray(),
    db.nodes.toArray(),
    db.skills.toArray(),
    db.memories.toArray(),
  ]);

  const settings: Record<string, unknown> = {};
  for (const key of IMPORT_SETTINGS_KEYS) {
    settings[key] =
      key === 'global_settings'
        ? await SettingsStore.global.get()
        : key === 'model_presets'
          ? await SettingsStore.presets.get()
          : await storageGet(key, null);
  }
  const secrets = await collectSecrets(settings);
  settings.connections = sanitizeConnections(settings.connections);
  settings.mcp_servers = sanitizeMcpServers(settings.mcp_servers);

  return {
    version: 2,
    exportedAt: Date.now(),
    threads,
    nodes,
    skills,
    memories,
    settings,
    ...(opts.secretBackupPassphrase
      ? { encryptedSecrets: await secretStore.encryptBackup(secrets, opts.secretBackupPassphrase) }
      : {}),
  };
}

export async function validateImportBundle(
  db: PanelotDB,
  input: unknown,
  opts: { merge?: boolean } = {},
): Promise<{ bundle: ExportBundle; report: ImportValidationResult }> {
  const validated = await validatePortableExport(input);
  if (opts.merge) {
    const [existingThreads, existingNodes] = await Promise.all([
      db.threads.bulkGet(validated.bundle.threads.map((thread) => thread.id)),
      db.nodes.bulkGet(validated.bundle.nodes.map((node) => node.id)),
    ]);
    if (existingThreads.some(Boolean) || existingNodes.some(Boolean)) {
      throw new Error('合并导入存在 ID 冲突，请改用覆盖导入');
    }
  }
  return validated;
}

/** Single conversation → Markdown (docs/development/index.md §5). */
function sanitizeConnections(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return (value as Connection[]).map((connection) => ({
    ...connection,
    apiKeys: [],
    customHeaders: undefined,
  }));
}

function sanitizeMcpServers(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return (value as McpServerConfig[]).map((server) => ({
    ...server,
    auth:
      server.auth.kind === 'bearer'
        ? { kind: 'bearer', token: '' }
        : server.auth.kind === 'oauth'
          ? {
              kind: 'oauth',
              clientId: server.auth.clientId,
              scopes: server.auth.scopes,
              binding: server.auth.binding,
              tokens: server.auth.tokens
                ? { access: '', expiresAt: server.auth.tokens.expiresAt }
                : undefined,
            }
          : { kind: 'none' },
  }));
}

async function collectSecrets(settings: Record<string, unknown>): Promise<PortableSecrets> {
  const connections = Array.isArray(settings.connections)
    ? await Promise.all(
        (settings.connections as Connection[]).map(async (connection) => ({
          id: connection.id,
          apiKeys: await Promise.all(connection.apiKeys.map(decryptSecret)),
          customHeaders: connection.customHeaders
            ? Object.fromEntries(
                await Promise.all(
                  Object.entries(connection.customHeaders).map(async ([name, value]) => [
                    name,
                    await decryptHeaderValue(connection.id, name, value),
                  ]),
                ),
              )
            : undefined,
        })),
      )
    : [];
  const mcpServers = Array.isArray(settings.mcp_servers)
    ? await Promise.all(
        (settings.mcp_servers as McpServerConfig[]).map(async (server) => ({
          id: server.id,
          bearer:
            server.auth.kind === 'bearer'
              ? ((await readMcpBearer(server)) ?? undefined)
              : undefined,
          oauthAccess:
            server.auth.kind === 'oauth'
              ? ((await readMcpAccess(server.id)) ?? undefined)
              : undefined,
          oauthRefresh:
            server.auth.kind === 'oauth'
              ? ((await readMcpRefresh(server)) ?? undefined)
              : undefined,
        })),
      )
    : [];
  return { connections, mcpServers };
}

export async function exportThreadMarkdown(db: PanelotDB, threadId: string): Promise<string> {
  const tree = new ThreadTree(db);
  const thread = await db.threads.get(threadId);
  if (!thread?.leafId) return `# ${thread?.title ?? '空会话'}\n\n（无内容）`;

  const ctx = await buildSessionContext(tree, threadId, thread.leafId);
  const lines: string[] = [`# ${thread.title || '会话'}`, ''];

  for (const node of ctx.path) {
    switch (node.type) {
      case 'user_message': {
        const p = node.payload as UserMessagePayload;
        lines.push(
          '## 用户',
          '',
          p.content.map((c) => (c.type === 'text' ? c.text : '[图片]')).join('\n'),
          '',
        );
        break;
      }
      case 'assistant_message': {
        const p = node.payload as AssistantMessagePayload;
        const text = p.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
        if (text.trim()) lines.push('## 助手', '', text, '');
        break;
      }
      case 'tool_call': {
        const p = node.payload as ToolCallPayload;
        lines.push(`> 🔧 **${p.toolName}** \`${JSON.stringify(p.params)}\``, '');
        break;
      }
      case 'tool_result': {
        const p = node.payload as ToolResultPayload;
        const text = p.contentForLlm.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
        lines.push(`> ${p.ok ? '✓' : '✗'} ${text.slice(0, 500)}`, '');
        break;
      }
      case 'approval_decision':
      case 'interaction_response':
      case 'turn_context':
      case 'system_notice':
        break;
      default:
        throw new Error(node.type satisfies never);
    }
  }
  return lines.join('\n');
}
