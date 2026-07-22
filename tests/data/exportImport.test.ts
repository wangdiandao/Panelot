import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import type { InteractionResponsePayload } from '../../src/db/types';
import { exportAll, exportThreadMarkdown, validateImportBundle } from '../../src/data/exportImport';

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

describe('exportAll (docs/development/index.md §5)', () => {
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

  it('rejects an unknown export version', async () => {
    await expect(validateImportBundle(db, { version: 99 } as never)).rejects.toThrow(/版本/);
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

  it('validates every persisted interaction shape in an exported thread', async () => {
    const tree = new ThreadTree(db);
    const thread = await tree.createThread({ title: 'interaction history' });
    const payloads: InteractionResponsePayload[] = [
      {
        interactionId: 'ask-1',
        request: {
          kind: 'ask_user',
          questions: [
            {
              id: 'choice',
              question: 'Choose one.',
              options: [{ value: 'A', label: 'Option A' }],
            },
          ],
        },
        response: { kind: 'submit', value: { answers: [{ id: 'choice', value: 'A' }] } },
        respondedAt: 10,
      },
      {
        interactionId: 'action-1',
        request: { kind: 'user_action', instruction: 'Complete the browser step.', tabId: 7 },
        response: { kind: 'cancel', note: 'Skipped.' },
        respondedAt: 11,
      },
      {
        interactionId: 'watch-1',
        request: {
          kind: 'watch_page',
          tabId: 7,
          condition: { type: 'text', value: 'Ready' },
          deadlineAt: 20,
        },
        response: { kind: 'timeout', value: { observed: false } },
        respondedAt: 12,
      },
      {
        interactionId: 'download-1',
        request: {
          kind: 'watch_page',
          tabId: 7,
          condition: { type: 'download', downloadId: 9 },
          deadlineAt: 21,
        },
        response: { kind: 'submit', value: null },
        respondedAt: 13,
      },
      {
        interactionId: 'schedule-1',
        request: { kind: 'schedule', resumeAt: 30, reason: 'Wait for the scheduled time.' },
        response: { kind: 'submit', value: { resumed: true } },
        respondedAt: 14,
      },
      {
        interactionId: 'mcp-1',
        request: {
          kind: 'mcp_elicitation',
          serverId: 'server-1',
          message: 'Choose a format.',
          requestedSchema: { type: 'object', properties: { format: { type: 'string' } } },
        },
        response: { kind: 'cancel' },
        respondedAt: 15,
      },
    ];
    for (const payload of payloads) {
      await tree.appendNode(thread.id, { type: 'interaction_response', payload });
    }
    const bundle = await exportAll(db);
    const target = new PanelotDB(`export-interaction-target-${n++}`);

    await expect(validateImportBundle(target, bundle)).resolves.toMatchObject({
      report: { threadCount: 1, nodeCount: payloads.length },
    });

    const invalid = structuredClone(bundle);
    const invalidNode = invalid.nodes.find(
      (node) => (node.payload as InteractionResponsePayload).request.kind === 'ask_user',
    );
    const invalidRequest = (invalidNode!.payload as InteractionResponsePayload)
      .request as unknown as Record<string, unknown>;
    delete invalidRequest.questions;
    await expect(validateImportBundle(target, invalid)).rejects.toThrow(
      /IMPORT_INTERACTION_QUESTIONS/,
    );
    await target.delete();
  });

  it('validates persisted Anthropic thinking replay state', async () => {
    const tree = new ThreadTree(db);
    const thread = await tree.createThread({ title: 'Anthropic state' });
    await tree.appendNode(thread.id, {
      type: 'assistant_message',
      payload: {
        content: [],
        model: 'claude',
        connectionId: 'anthropic',
        providerState: {
          kind: 'anthropic',
          thinkingBlocks: [
            { type: 'thinking', thinking: 'private', signature: 'signed' },
            { type: 'redacted_thinking', data: 'redacted' },
          ],
        },
      },
    });
    const bundle = await exportAll(db);
    const target = new PanelotDB(`export-provider-state-${n++}`);

    await expect(validateImportBundle(target, bundle)).resolves.toMatchObject({
      report: { nodeCount: 1 },
    });

    const invalid = structuredClone(bundle);
    const payload = invalid.nodes[0]!.payload as {
      providerState: { thinkingBlocks: Record<string, unknown>[] };
    };
    delete payload.providerState.thinkingBlocks[0]!.signature;
    await expect(validateImportBundle(target, invalid)).rejects.toThrow(
      /IMPORT_ASSISTANT_PROVIDER_STATE/,
    );
    await target.delete();
  });

  it('allows conflict-free merge validation and rejects an existing thread id', async () => {
    const tree = new ThreadTree(db);
    await tree.createThread({ title: 'merge source' });
    const bundle = await exportAll(db);
    const target = new PanelotDB(`export-merge-target-${n++}`);

    const validated = await validateImportBundle(target, bundle, { merge: true });
    expect(validated.report.threadCount).toBe(1);
    expect(await target.threads.count()).toBe(0);

    await target.threads.put(bundle.threads[0]!);
    await expect(validateImportBundle(target, bundle, { merge: true })).rejects.toThrow(/ID/);
  });

  it('rejects plaintext provider secrets in imported settings', async () => {
    const bundle = await exportAll(db);
    bundle.settings.connections = [{ apiKeys: ['plaintext-key'] }];
    await expect(validateImportBundle(db, bundle)).rejects.toThrow(/明文 Provider Key/);
  });

  it('rejects unsafe Provider and MCP endpoints before import mutates data', async () => {
    const providerBundle = await exportAll(db);
    providerBundle.settings.connections = [
      { baseUrl: 'http://provider.example.com/v1', apiKeys: [] },
    ];
    await expect(validateImportBundle(db, providerBundle)).rejects.toThrow(/HTTPS/);

    const mcpBundle = await exportAll(db);
    mcpBundle.settings.mcp_servers = [
      { url: 'https://user:pass@mcp.example.com/mcp', auth: { kind: 'none' } },
    ];
    await expect(validateImportBundle(db, mcpBundle)).rejects.toThrow(/用户名或密码/);
  });

  it('canonicalizes safe Provider endpoints using the SettingsStore convention', async () => {
    const bundle = await exportAll(db);
    bundle.settings.connections = [
      {
        id: 'provider',
        name: 'Provider',
        kind: 'openai',
        baseUrl: 'https://provider.example.com/v1/',
        apiKeys: [],
        enabled: true,
      },
    ];

    const validated = await validateImportBundle(db, bundle);

    expect((validated.bundle.settings.connections as { baseUrl: string }[])[0]!.baseUrl).toBe(
      'https://provider.example.com/v1',
    );
  });
});

describe('exportThreadMarkdown', () => {
  it('renders an empty thread without inventing conversation content', async () => {
    const thread = await new ThreadTree(db).createThread({ title: 'Empty thread' });

    const md = await exportThreadMarkdown(db, thread.id);

    expect(md).toContain('# Empty thread');
    expect(md).toContain('无内容');
  });

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
