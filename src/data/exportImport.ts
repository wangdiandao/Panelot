/**
 * Data export/import (DESIGN §12): full JSON export (keys stripped by default),
 * single-thread Markdown export, JSON re-import. All local; no cloud.
 */

import type { PanelotDB } from '../db/schema';
import { buildSessionContext } from '../db/sessionContext';
import { ThreadTree } from '../db/tree';
import { storageGet, storageSet } from '../settings/store';
import type {
  AssistantMessagePayload,
  ThreadMeta,
  ThreadNode,
  ToolCallPayload,
  ToolResultPayload,
  UserMessagePayload,
} from '../db/types';
import type { EncryptedSecretBackup } from '../security/secretStore';
import { secretStore } from '../security/secretStore';
import {
  decryptHeaderValue,
  decryptSecret,
  encryptHeaderValue,
  encryptSecret,
} from '../settings/crypto';
import type { Connection } from '../providers/types';
import type { McpServerConfig } from '../mcp/types';
import { readMcpAccess, readMcpBearer, readMcpRefresh, saveMcpServers } from '../mcp/store';

export interface ExportBundle {
  version: 2;
  exportedAt: number;
  threads: ThreadMeta[];
  nodes: ThreadNode[];
  skills: unknown[];
  memories: unknown[];
  settings: Record<string, unknown>;
  encryptedSecrets?: EncryptedSecretBackup;
}

interface PortableSecrets {
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

const SETTINGS_KEYS = [
  'connections',
  'model_presets',
  'global_settings',
  'permission_rules',
  'sensitive_origins',
  'mcp_servers',
  'site_prompts',
];
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_THREADS = 10_000;
const MAX_NODES = 100_000;
const MAX_ASSETS = 10_000;

export interface ImportValidationResult {
  bytes: number;
  threadCount: number;
  nodeCount: number;
  skillCount: number;
  memoryCount: number;
  hasEncryptedSecrets: boolean;
}

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
  for (const key of SETTINGS_KEYS) {
    settings[key] = await storageGet(key, null);
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

export async function importBundle(
  db: PanelotDB,
  input: unknown,
  opts: { merge?: boolean; secretBackupPassphrase?: string } = {},
): Promise<void> {
  const { bundle } = await validateImportBundle(db, input, { merge: opts.merge });
  let settings = structuredClone(bundle.settings);
  if (bundle.encryptedSecrets) {
    if (!opts.secretBackupPassphrase) throw new Error('该备份包含加密秘密，请输入备份口令');
    const secrets = await secretStore.decryptBackup<PortableSecrets>(
      bundle.encryptedSecrets,
      opts.secretBackupPassphrase,
    );
    settings = await restorePortableSecrets(settings, secrets);
  }
  await db.transaction('rw', [db.threads, db.nodes, db.skills, db.memories], async () => {
    if (!opts.merge) {
      await Promise.all([
        db.threads.clear(),
        db.nodes.clear(),
        db.skills.clear(),
        db.memories.clear(),
      ]);
    }
    await db.threads.bulkPut(bundle.threads);
    await db.nodes.bulkPut(bundle.nodes);
    await db.skills.bulkPut(bundle.skills as never[]);
    await db.memories.bulkPut(bundle.memories as never[]);
  });
  for (const [key, value] of Object.entries(settings)) {
    if (value === null) continue;
    if (key === 'mcp_servers' && Array.isArray(value)) {
      await saveMcpServers(value as McpServerConfig[]);
    } else {
      await storageSet(key, value);
    }
  }
}

export async function validateImportBundle(
  db: PanelotDB,
  input: unknown,
  opts: { merge?: boolean } = {},
): Promise<{ bundle: ExportBundle; report: ImportValidationResult }> {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error('导入文件不是可序列化的 JSON');
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_IMPORT_BYTES) throw new Error('导入文件超过 50 MB 限制');
  if (!isRecord(input)) throw new Error('导入文件根节点必须是对象');
  if (input.version !== 2) throw new Error(`不支持的导出版本: ${String(input.version)}`);
  if (!Array.isArray(input.threads) || input.threads.length > MAX_THREADS) {
    throw new Error(`threads 必须是数组且不超过 ${MAX_THREADS} 条`);
  }
  if (!Array.isArray(input.nodes) || input.nodes.length > MAX_NODES) {
    throw new Error(`nodes 必须是数组且不超过 ${MAX_NODES} 条`);
  }
  if (!Array.isArray(input.skills) || input.skills.length > MAX_ASSETS) {
    throw new Error(`skills 必须是数组且不超过 ${MAX_ASSETS} 条`);
  }
  if (!Array.isArray(input.memories) || input.memories.length > MAX_ASSETS) {
    throw new Error(`memories 必须是数组且不超过 ${MAX_ASSETS} 条`);
  }
  if (!isRecord(input.settings)) throw new Error('settings 必须是对象');
  for (const key of Object.keys(input.settings)) {
    if (!SETTINGS_KEYS.includes(key)) throw new Error(`未知设置项: ${key}`);
  }
  validateEncryptedBackup(input.encryptedSecrets);

  const threads = input.threads as unknown[];
  const nodes = input.nodes as unknown[];
  const threadIds = uniqueIds(threads, 'thread');
  const nodeIds = uniqueIds(nodes, 'node');
  const nodeRecords = new Map<string, { threadId: string; parentId: string | null; seq: number }>();
  for (const candidate of nodes) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.threadId !== 'string'
    ) {
      throw new Error('node 缺少字符串 id/threadId');
    }
    if (!threadIds.has(candidate.threadId))
      throw new Error(`node ${candidate.id} 引用了不存在的 thread`);
    if (candidate.parentId !== null && typeof candidate.parentId !== 'string') {
      throw new Error(`node ${candidate.id} 的 parentId 无效`);
    }
    if (!Number.isSafeInteger(candidate.seq) || Number(candidate.seq) < 0) {
      throw new Error(`node ${candidate.id} 的 seq 无效`);
    }
    if (typeof candidate.type !== 'string' || !('payload' in candidate)) {
      throw new Error(`node ${candidate.id} 缺少 type/payload`);
    }
    nodeRecords.set(candidate.id, {
      threadId: candidate.threadId,
      parentId: candidate.parentId,
      seq: candidate.seq as number,
    });
  }
  const seqs = new Set<string>();
  for (const [id, node] of nodeRecords) {
    const seqKey = `${node.threadId}\u0000${node.seq}`;
    if (seqs.has(seqKey)) throw new Error(`thread ${node.threadId} 含重复 seq ${node.seq}`);
    seqs.add(seqKey);
    if (node.parentId !== null) {
      const parent = nodeRecords.get(node.parentId);
      if (!parent) throw new Error(`node ${id} 引用了不存在的 parent ${node.parentId}`);
      if (parent.threadId !== node.threadId) throw new Error(`node ${id} 的 parent 跨越了 thread`);
    }
  }
  assertAcyclic(nodeRecords);

  for (const candidate of threads) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.title !== 'string' ||
      !Number.isSafeInteger(candidate.revision) ||
      (candidate.leafId !== null && typeof candidate.leafId !== 'string')
    ) {
      throw new Error('thread 字段无效');
    }
    if (candidate.leafId !== null) {
      const leaf = nodeRecords.get(candidate.leafId);
      if (!leaf || leaf.threadId !== candidate.id) {
        throw new Error(`thread ${candidate.id} 的 leafId 无效`);
      }
    }
  }

  for (const [key, values] of [
    ['skill', input.skills],
    ['memory', input.memories],
  ] as const) {
    uniqueIds(values, key);
  }
  validateSanitizedSettings(input.settings);

  if (opts.merge) {
    const [existingThreads, existingNodes] = await Promise.all([
      db.threads.bulkGet([...threadIds]),
      db.nodes.bulkGet([...nodeIds]),
    ]);
    if (existingThreads.some(Boolean) || existingNodes.some(Boolean)) {
      throw new Error('合并导入存在 ID 冲突，请改用覆盖导入');
    }
  }

  return {
    bundle: input as unknown as ExportBundle,
    report: {
      bytes,
      threadCount: threads.length,
      nodeCount: nodes.length,
      skillCount: input.skills.length,
      memoryCount: input.memories.length,
      hasEncryptedSecrets: input.encryptedSecrets !== undefined,
    },
  };
}

function uniqueIds(values: readonly unknown[], label: string): Set<string> {
  const ids = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
      throw new Error(`${label} 缺少字符串 id`);
    }
    if (ids.has(value.id)) throw new Error(`${label} id 重复: ${value.id}`);
    ids.add(value.id);
  }
  return ids;
}

function assertAcyclic(nodes: Map<string, { parentId: string | null }>): void {
  const complete = new Set<string>();
  for (const id of nodes.keys()) {
    if (complete.has(id)) continue;
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !complete.has(current)) {
      if (path.has(current)) throw new Error(`node parent 链存在环: ${current}`);
      path.add(current);
      current = nodes.get(current)?.parentId ?? null;
    }
    for (const visited of path) complete.add(visited);
  }
}

function validateSanitizedSettings(settings: Record<string, unknown>): void {
  const connections = settings.connections;
  if (connections !== null && connections !== undefined) {
    if (!Array.isArray(connections)) throw new Error('connections 必须是数组');
    for (const connection of connections) {
      if (!isRecord(connection) || !Array.isArray(connection.apiKeys))
        throw new Error('connection 字段无效');
      if (connection.apiKeys.some((key) => typeof key !== 'string' || key !== '')) {
        throw new Error('导入设置不能包含明文 Provider Key');
      }
      if (connection.customHeaders !== undefined)
        throw new Error('导入设置不能包含明文自定义 Header');
    }
  }
}

function validateEncryptedBackup(value: unknown): void {
  if (value === undefined) return;
  if (
    !isRecord(value) ||
    value.format !== 'panelot-secret-backup' ||
    value.version !== 1 ||
    value.cipher !== 'AES-GCM-256' ||
    typeof value.iv !== 'string' ||
    typeof value.ciphertext !== 'string' ||
    !isRecord(value.kdf) ||
    value.kdf.name !== 'PBKDF2-SHA-256' ||
    value.kdf.iterations !== 600_000 ||
    typeof value.kdf.salt !== 'string'
  ) {
    throw new Error('加密秘密备份格式无效');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Single conversation → Markdown (DESIGN §12). */
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

async function restorePortableSecrets(
  settings: Record<string, unknown>,
  secrets: PortableSecrets,
): Promise<Record<string, unknown>> {
  const restored = structuredClone(settings);
  if (Array.isArray(restored.connections)) {
    restored.connections = await Promise.all(
      (restored.connections as Connection[]).map(async (connection) => {
        const secret = secrets.connections.find((candidate) => candidate.id === connection.id);
        return {
          ...connection,
          apiKeys: await Promise.all((secret?.apiKeys ?? []).map(encryptSecret)),
          customHeaders: secret?.customHeaders
            ? Object.fromEntries(
                await Promise.all(
                  Object.entries(secret.customHeaders).map(async ([name, value]) => [
                    name,
                    await encryptHeaderValue(connection.id, name, value),
                  ]),
                ),
              )
            : undefined,
        };
      }),
    );
  }
  if (Array.isArray(restored.mcp_servers)) {
    restored.mcp_servers = (restored.mcp_servers as McpServerConfig[]).map((server) => {
      const secret = secrets.mcpServers.find((candidate) => candidate.id === server.id);
      if (server.auth.kind === 'bearer') {
        return { ...server, auth: { kind: 'bearer', token: secret?.bearer ?? '' } };
      }
      if (server.auth.kind === 'oauth') {
        return {
          ...server,
          auth: {
            ...server.auth,
            tokens: server.auth.tokens
              ? {
                  access: secret?.oauthAccess ?? '',
                  refresh: secret?.oauthRefresh,
                  expiresAt: server.auth.tokens.expiresAt,
                }
              : undefined,
          },
        };
      }
      return server;
    });
  }
  return restored;
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
      default:
        break;
    }
  }
  return lines.join('\n');
}
