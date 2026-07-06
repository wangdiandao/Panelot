/**
 * Palette full-text search (docs/09 §6): titles + message bodies.
 * No FTS index exists (nodes: id, threadId, [threadId+seq], parentId), so
 * this is a bounded scan — the 50 most-recent threads' message nodes,
 * filtered in JS. OpenWebUI does the same server-side; at extension scale
 * (hundreds of threads) a bounded scan beats maintaining an index.
 */

import type { PanelotDB } from '../db/schema';
import type { ThreadMeta } from '../db/types';
import type { ContentBlock } from '../messaging/protocol';

export interface ThreadSearchHit {
  thread: ThreadMeta;
  /** ±30 chars around the first body match; absent for title-only hits. */
  snippet?: string;
}

function nodeText(payload: unknown): string {
  const content = (payload as { content?: ContentBlock[] })?.content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

export function makeSnippet(text: string, query: string, radius = 30): string | undefined {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return undefined;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

export async function searchThreads(db: PanelotDB, query: string, scanLimit = 50): Promise<ThreadSearchHit[]> {
  const recent = (await db.threads.orderBy('updatedAt').reverse().limit(200).toArray()).filter(
    (t) => !t.deleting && !t.archived && t.leafId !== null,
  );
  const q = query.trim().toLowerCase();
  if (!q) return recent.slice(0, scanLimit).map((thread) => ({ thread }));

  const hits: ThreadSearchHit[] = [];
  const titleMissed: ThreadMeta[] = [];
  for (const thread of recent) {
    if ((thread.title || '').toLowerCase().includes(q)) hits.push({ thread });
    else titleMissed.push(thread);
  }

  // Body scan over the most recent title-missed threads.
  const scanIds = titleMissed.slice(0, scanLimit).map((t) => t.id);
  if (scanIds.length > 0) {
    const nodes = await db.nodes.where('threadId').anyOf(scanIds).toArray();
    const matchedByThread = new Map<string, string>();
    for (const node of nodes) {
      if (node.deleted || (node.type !== 'user_message' && node.type !== 'assistant_message')) continue;
      if (matchedByThread.has(node.threadId)) continue;
      const text = nodeText(node.payload);
      if (text.toLowerCase().includes(q)) {
        matchedByThread.set(node.threadId, makeSnippet(text, q) ?? '');
      }
    }
    for (const thread of titleMissed) {
      const snippet = matchedByThread.get(thread.id);
      if (snippet !== undefined) hits.push({ thread, snippet });
    }
  }
  return hits.slice(0, scanLimit);
}
