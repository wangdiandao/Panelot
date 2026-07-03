import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { exportAll, exportThreadMarkdown, importBundle } from '../../src/data/exportImport';

// In-memory chrome.storage.local for settings round-trip.
const store = new Map<string, unknown>();
beforeEach(() => {
  store.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store.get(key) }),
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
      },
    },
  };
});

let db: PanelotDB;
let n = 0;
beforeEach(() => {
  db = new PanelotDB(`export-test-${Date.now()}-${n++}`);
});

describe('exportAll (DESIGN §12)', () => {
  it('strips API keys by default, keeps them when includeKeys', async () => {
    store.set('connections', [{ id: 'c1', name: 'x', apiKeys: ['sk-secret'], baseUrl: 'https://x', kind: 'openai', enabled: true }]);

    const stripped = await exportAll(db, {});
    expect((stripped.settings.connections as { apiKeys: string[] }[])[0]!.apiKeys).toEqual([]);

    const withKeys = await exportAll(db, { includeKeys: true });
    expect((withKeys.settings.connections as { apiKeys: string[] }[])[0]!.apiKeys).toEqual(['sk-secret']);
  });

  it('round-trips threads and nodes through export → import', async () => {
    const tree = new ThreadTree(db);
    const thread = await tree.createThread({ title: 'roundtrip' });
    await tree.appendNode(thread.id, { type: 'user_message', payload: { content: [{ type: 'text', text: 'hi' }] } });

    const bundle = await exportAll(db, {});
    const db2 = new PanelotDB(`export-test-target-${n++}`);
    await importBundle(db2, bundle, { merge: false });

    const threads = await db2.threads.toArray();
    const nodes = await db2.nodes.toArray();
    expect(threads.map((t) => t.title)).toContain('roundtrip');
    expect(nodes).toHaveLength(1);
  });

  it('rejects an unknown export version', async () => {
    await expect(importBundle(db, { version: 99 } as never, {})).rejects.toThrow(/版本/);
  });
});

describe('exportThreadMarkdown', () => {
  it('renders a conversation as Markdown with roles and tool calls', async () => {
    const tree = new ThreadTree(db);
    const thread = await tree.createThread({ title: '耳机调研' });
    await tree.appendNode(thread.id, { type: 'user_message', payload: { content: [{ type: 'text', text: '帮我比价' }] } });
    await tree.appendNode(thread.id, { type: 'assistant_message', payload: { content: [{ type: 'text', text: '好的，我来查。' }], model: 'm', connectionId: 'c' } });
    await tree.appendNode(thread.id, { type: 'tool_call', payload: { itemId: 't1', toolName: 'navigate', params: { url: 'https://shop' }, level: 'L0' } });
    await tree.appendNode(thread.id, { type: 'tool_result', payload: { itemId: 't1', ok: true, contentForLlm: [{ type: 'text', text: '已打开' }] } });

    const md = await exportThreadMarkdown(db, thread.id);
    expect(md).toContain('# 耳机调研');
    expect(md).toContain('## 用户');
    expect(md).toContain('帮我比价');
    expect(md).toContain('## 助手');
    expect(md).toContain('🔧 **navigate**');
    expect(md).toContain('✓ 已打开');
  });
});
