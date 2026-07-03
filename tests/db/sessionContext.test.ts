import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { buildSessionContext } from '../../src/db/sessionContext';
import { ThreadTree } from '../../src/db/tree';
import type {
  CompactionPayload,
  TurnContextPayload,
  UserMessagePayload,
} from '../../src/db/types';

let db: PanelotDB;
let tree: ThreadTree;
let n = 0;

beforeEach(() => {
  db = new PanelotDB(`ctx-test-${Date.now()}-${n++}`);
  tree = new ThreadTree(db);
});

const msg = (text: string): UserMessagePayload => ({ content: [{ type: 'text', text }] });
const assistant = (text: string) => ({
  content: [{ type: 'text' as const, text }], model: 'm', connectionId: 'c',
});
const turnCtx = (turnId: string): TurnContextPayload => ({
  turnId,
  model: { connectionId: 'c', modelId: 'm' },
  approvalPolicy: 'untrusted',
  capabilityScope: 'cross-origin',
  activeSkills: [],
});

describe('buildSessionContext basics', () => {
  it('converts a linear path into unified messages, skipping metadata nodes', async () => {
    const t = await tree.createThread({});
    await tree.appendNode(t.id, { type: 'turn_context', payload: turnCtx('turn1') });
    await tree.appendNode(t.id, { type: 'user_message', payload: msg('hello') });
    await tree.appendNode(t.id, { type: 'assistant_message', payload: assistant('hi there') });
    await tree.appendNode(t.id, { type: 'system_notice', payload: { text: 'paused' } });
    const leaf = await tree.appendNode(t.id, { type: 'user_message', payload: msg('next') });

    const ctx = await buildSessionContext(tree, t.id, leaf.id);
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(ctx.turnContext?.turnId).toBe('turn1');
  });

  it('attaches tool calls to the preceding assistant message and pairs results', async () => {
    const t = await tree.createThread({});
    await tree.appendNode(t.id, { type: 'user_message', payload: msg('click it') });
    await tree.appendNode(t.id, { type: 'assistant_message', payload: assistant('clicking') });
    await tree.appendNode(t.id, {
      type: 'tool_call',
      payload: { itemId: 'call1', toolName: 'click', params: { ref: 's1_2' }, level: 'L1' },
    });
    const leaf = await tree.appendNode(t.id, {
      type: 'tool_result',
      payload: { itemId: 'call1', ok: true, contentForLlm: [{ type: 'text', text: 'clicked' }] },
    });

    const ctx = await buildSessionContext(tree, t.id, leaf.id);
    expect(ctx.messages).toHaveLength(3);
    const assistantMsg = ctx.messages[1]!;
    expect(assistantMsg.role).toBe('assistant');
    expect((assistantMsg as { toolCalls?: unknown[] }).toolCalls).toHaveLength(1);
    const result = ctx.messages[2]!;
    expect(result).toMatchObject({ role: 'tool_result', toolCallId: 'call1', isError: false });
  });

  it('renders failed tool results with isError=true', async () => {
    const t = await tree.createThread({});
    await tree.appendNode(t.id, { type: 'assistant_message', payload: assistant('trying') });
    await tree.appendNode(t.id, {
      type: 'tool_call',
      payload: { itemId: 'c1', toolName: 'click', params: {}, level: 'L1' },
    });
    const leaf = await tree.appendNode(t.id, {
      type: 'tool_result',
      payload: { itemId: 'c1', ok: false, contentForLlm: [{ type: 'text', text: 'stale ref' }] },
    });
    const ctx = await buildSessionContext(tree, t.id, leaf.id);
    expect(ctx.messages[ctx.messages.length - 1]).toMatchObject({ role: 'tool_result', isError: true });
  });

  it('follows only the active branch after a fork', async () => {
    const t = await tree.createThread({});
    await tree.appendNode(t.id, { type: 'user_message', payload: msg('Q') });
    const ans1 = await tree.appendNode(t.id, { type: 'assistant_message', payload: assistant('answer v1') });
    // Regenerate: sibling of ans1.
    const ans2 = await tree.forkAt(t.id, ans1.id, { type: 'assistant_message', payload: assistant('answer v2') });

    const ctx = await buildSessionContext(tree, t.id, ans2.id);
    const texts = ctx.messages.flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));
    expect(texts).toContain('answer v2');
    expect(texts).not.toContain('answer v1');
  });
});

describe('compaction view (docs/02 §4-5)', () => {
  it('replaces pre-cut history with the summary and keeps nodes from firstKeptNodeId', async () => {
    const t = await tree.createThread({});
    await tree.appendNode(t.id, { type: 'user_message', payload: msg('old-1') });
    await tree.appendNode(t.id, { type: 'assistant_message', payload: assistant('old-2') });
    const kept = await tree.appendNode(t.id, { type: 'user_message', payload: msg('kept-1') });
    await tree.appendNode(t.id, { type: 'assistant_message', payload: assistant('kept-2') });

    const compaction: CompactionPayload = {
      summary: 'user asked old things',
      firstKeptNodeId: kept.id,
      tokensBefore: 1000,
      tokensAfter: 100,
      trackedOps: { visitedUrls: ['https://a.com'], mutatedTargets: [] },
    };
    await tree.appendNode(t.id, { type: 'compaction', payload: compaction });
    const leaf = await tree.appendNode(t.id, { type: 'user_message', payload: msg('new-1') });

    const ctx = await buildSessionContext(tree, t.id, leaf.id);
    const texts = ctx.messages.flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));

    expect(texts.some((x) => x.includes('user asked old things'))).toBe(true);
    expect(texts).not.toContain('old-1');
    expect(texts).not.toContain('old-2');
    expect(texts).toContain('kept-1');
    expect(texts).toContain('kept-2');
    expect(texts).toContain('new-1');
    // Summary message comes first.
    expect(ctx.messages[0]!.role).toBe('assistant');
    expect(ctx.lastCompaction?.trackedOps.visitedUrls).toEqual(['https://a.com']);
  });

  it('uses only the LATEST compaction when several exist', async () => {
    const t = await tree.createThread({});
    const k1 = await tree.appendNode(t.id, { type: 'user_message', payload: msg('gen1-kept') });
    await tree.appendNode(t.id, {
      type: 'compaction',
      payload: {
        summary: 'summary-1', firstKeptNodeId: k1.id,
        tokensBefore: 0, tokensAfter: 0, trackedOps: { visitedUrls: [], mutatedTargets: [] },
      },
    });
    const k2 = await tree.appendNode(t.id, { type: 'user_message', payload: msg('gen2-kept') });
    await tree.appendNode(t.id, {
      type: 'compaction',
      payload: {
        summary: 'summary-2', firstKeptNodeId: k2.id,
        tokensBefore: 0, tokensAfter: 0, trackedOps: { visitedUrls: [], mutatedTargets: [] },
      },
    });
    const leaf = await tree.appendNode(t.id, { type: 'user_message', payload: msg('tail') });

    const ctx = await buildSessionContext(tree, t.id, leaf.id);
    const texts = ctx.messages.flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));
    expect(texts.some((x) => x.includes('summary-2'))).toBe(true);
    expect(texts.some((x) => x.includes('summary-1'))).toBe(false);
    expect(texts).not.toContain('gen1-kept');
    expect(texts).toContain('gen2-kept');
    expect(texts).toContain('tail');
  });

  it('renders branch_summary as an in-place assistant message', async () => {
    const t = await tree.createThread({});
    await tree.appendNode(t.id, { type: 'user_message', payload: msg('try B') });
    await tree.appendNode(t.id, {
      type: 'branch_summary',
      payload: { summary: 'branch A found the login wall', abandonedLeafId: 'x', commonAncestorId: 'y' },
    });
    const leaf = await tree.appendNode(t.id, { type: 'assistant_message', payload: assistant('ok, using B') });

    const ctx = await buildSessionContext(tree, t.id, leaf.id);
    const texts = ctx.messages.flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));
    expect(texts.some((x) => x.includes('branch A found the login wall'))).toBe(true);
  });
});
