/**
 * Data export/import (DESIGN §12): full JSON export (keys stripped by default),
 * single-thread Markdown export, JSON re-import. All local; no cloud (V1).
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

export interface ExportBundle {
  version: 1;
  exportedAt: number;
  threads: ThreadMeta[];
  nodes: ThreadNode[];
  skills: unknown[];
  memories: unknown[];
  settings: Record<string, unknown>;
}

const SETTINGS_KEYS = ['connections', 'model_presets', 'global_settings', 'permission_rules', 'sensitive_origins', 'mcp_servers', 'site_prompts'];

/**
 * Full JSON export. Attachments (blobs) are omitted to keep the file portable;
 * API keys are stripped from connections unless includeKeys is set.
 */
export async function exportAll(db: PanelotDB, opts: { includeKeys?: boolean } = {}): Promise<ExportBundle> {
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
  if (!opts.includeKeys && Array.isArray(settings.connections)) {
    settings.connections = (settings.connections as { apiKeys?: unknown }[]).map((c) => ({ ...c, apiKeys: [] }));
  }

  return { version: 1, exportedAt: Date.now(), threads, nodes, skills, memories, settings };
}

export async function importBundle(db: PanelotDB, bundle: ExportBundle, opts: { merge?: boolean } = {}): Promise<void> {
  if (bundle.version !== 1) throw new Error(`不支持的导出版本: ${bundle.version}`);
  await db.transaction('rw', [db.threads, db.nodes, db.skills, db.memories], async () => {
    if (!opts.merge) {
      await Promise.all([db.threads.clear(), db.nodes.clear(), db.skills.clear(), db.memories.clear()]);
    }
    await db.threads.bulkPut(bundle.threads);
    await db.nodes.bulkPut(bundle.nodes);
    await db.skills.bulkPut(bundle.skills as never[]);
    await db.memories.bulkPut(bundle.memories as never[]);
  });
  for (const [key, value] of Object.entries(bundle.settings)) {
    if (value !== null) await storageSet(key, value);
  }
}

/** Single conversation → Markdown (DESIGN §12). */
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
        lines.push('## 用户', '', p.content.map((c) => (c.type === 'text' ? c.text : '[图片]')).join('\n'), '');
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
