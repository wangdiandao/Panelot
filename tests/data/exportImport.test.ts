import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import {
  exportAll,
  exportThreadMarkdown,
  importBundle,
  validateImportBundle,
} from '../../src/data/exportImport';

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
  it('strips every secret by default and only exports secrets as a passphrase backup', async () => {
    store.set('connections', [
      {
        id: 'c1',
        name: 'x',
        apiKeys: ['sk-secret'],
        customHeaders: { Authorization: 'Bearer header-secret' },
        baseUrl: 'https://x',
        kind: 'openai',
        enabled: true,
      },
    ]);
    store.set('mcp_servers', [
      {
        id: 'mcp-a',
        name: 'MCP',
        url: 'https://mcp.example',
        auth: { kind: 'bearer', token: 'mcp-secret' },
        enabled: true,
        disabledTools: [],
        connectOnStartup: false,
      },
    ]);

    const stripped = await exportAll(db, {});
    expect(JSON.stringify(stripped)).not.toMatch(/sk-secret|header-secret|mcp-secret/);
    expect((stripped.settings.connections as { apiKeys: string[] }[])[0]!.apiKeys).toEqual([]);

    const protectedBundle = await exportAll(db, { secretBackupPassphrase: 'correct horse' });
    expect(protectedBundle.encryptedSecrets?.kdf.iterations).toBe(600_000);
    expect(JSON.stringify(protectedBundle)).not.toMatch(/sk-secret|header-secret|mcp-secret/);
  });

  it('round-trips threads and nodes through export → import', async () => {
    const tree = new ThreadTree(db);
    const thread = await tree.createThread({ title: 'roundtrip' });
    await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'hi' }] },
    });

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

  it('dry-runs references and rejects broken parent chains before writing', async () => {
    const tree = new ThreadTree(db);
    const thread = await tree.createThread({ title: 'validate' });
    await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: 'hello' }] },
    });
    const bundle = await exportAll(db);
    const target = new PanelotDB(`export-validation-target-${n++}`);

    const valid = await validateImportBundle(target, bundle);
    expect(valid.report).toMatchObject({ threadCount: 1, nodeCount: 1 });
    expect(await target.threads.count()).toBe(0);

    const broken = structuredClone(bundle);
    broken.nodes[0]!.parentId = 'missing-parent';
    await expect(validateImportBundle(target, broken)).rejects.toThrow(/parent/);
    expect(await target.threads.count()).toBe(0);
  });

  it('rejects plaintext provider secrets in imported settings', async () => {
    const bundle = await exportAll(db);
    bundle.settings.connections = [{ apiKeys: ['plaintext-key'] }];
    await expect(validateImportBundle(db, bundle)).rejects.toThrow(/明文 Provider Key/);
  });
});

describe('exportThreadMarkdown', () => {
  it('renders a conversation as Markdown with roles and tool calls', async () => {
    const tree = new ThreadTree(db);
    const thread = await tree.createThread({ title: '耳机调研' });
    await tree.appendNode(thread.id, {
      type: 'user_message',
      payload: { content: [{ type: 'text', text: '帮我比价' }] },
    });
    await tree.appendNode(thread.id, {
      type: 'assistant_message',
      payload: {
        content: [{ type: 'text', text: '好的，我来查。' }],
        model: 'm',
        connectionId: 'c',
      },
    });
    await tree.appendNode(thread.id, {
      type: 'tool_call',
      payload: { itemId: 't1', toolName: 'navigate', params: { url: 'https://shop' }, level: 'L0' },
    });
    await tree.appendNode(thread.id, {
      type: 'tool_result',
      payload: { itemId: 't1', ok: true, contentForLlm: [{ type: 'text', text: '已打开' }] },
    });

    const md = await exportThreadMarkdown(db, thread.id);
    expect(md).toContain('# 耳机调研');
    expect(md).toContain('## 用户');
    expect(md).toContain('帮我比价');
    expect(md).toContain('## 助手');
    expect(md).toContain('🔧 **navigate**');
    expect(md).toContain('✓ 已打开');
  });
});
