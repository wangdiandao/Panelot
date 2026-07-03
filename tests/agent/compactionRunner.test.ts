import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { buildSessionContext } from '../../src/db/sessionContext';
import { CompactionRunner } from '../../src/agent/compactionRunner';
import type { AgentEvent } from '../../src/messaging/protocol';
import type { FinalResult, ProviderAdapter, ProviderStream, StreamRequest } from '../../src/providers/types';

/** Task model mock: returns a fixed summary, records prompts. */
class SummaryProvider implements ProviderAdapter {
  prompts: string[] = [];
  constructor(private summary: string) {}
  stream(req: StreamRequest): ProviderStream {
    this.prompts.push((req.messages[0]!.content[0] as { text: string }).text);
    const final: FinalResult = {
      message: [{ type: 'text', text: this.summary }],
      toolCalls: [],
      usage: { input: 10, output: 10 },
      stopReason: 'end',
    };
    async function* gen() { /* no streaming */ }
    return { [Symbol.asyncIterator]: () => gen(), final: async () => final };
  }
  async verify() {
    return { reachable: true, keyValid: true, streaming: true, toolUse: false };
  }
}

let db: PanelotDB;
let tree: ThreadTree;
let events: AgentEvent[];
let n = 0;

beforeEach(() => {
  db = new PanelotDB(`cr-test-${Date.now()}-${n++}`);
  tree = new ThreadTree(db);
  events = [];
});

const big = (label: string) => ({ content: [{ type: 'text' as const, text: `${label} ${'x'.repeat(40_000)}` }] });

async function seedLongThread() {
  const t = await tree.createThread({});
  await tree.appendNode(t.id, { type: 'turn_context', payload: { turnId: 'a', model: { connectionId: '', modelId: 'm' }, approvalPolicy: 'untrusted', capabilityScope: 'cross-origin', activeSkills: [] } });
  await tree.appendNode(t.id, { type: 'user_message', payload: big('old-question') });
  await tree.appendNode(t.id, { type: 'assistant_message', payload: { ...big('old-answer'), model: 'm', connectionId: 'c' } });
  await tree.appendNode(t.id, { type: 'tool_call', payload: { itemId: 'tc1', toolName: 'navigate', params: { url: 'https://shop.example' }, level: 'L0' } });
  await tree.appendNode(t.id, { type: 'tool_result', payload: { itemId: 'tc1', ok: true, contentForLlm: [{ type: 'text', text: 'navigated' }] } });
  await tree.appendNode(t.id, { type: 'turn_context', payload: { turnId: 'b', model: { connectionId: '', modelId: 'm' }, approvalPolicy: 'untrusted', capabilityScope: 'cross-origin', activeSkills: [] } });
  await tree.appendNode(t.id, { type: 'user_message', payload: big('recent-question') });
  await tree.appendNode(t.id, { type: 'assistant_message', payload: { ...big('recent-answer'), model: 'm', connectionId: 'c' } });
  return t;
}

describe('CompactionRunner.compact', () => {
  it('appends a compaction node; post-compaction context = summary + kept tail', async () => {
    const t = await seedLongThread();
    const provider = new SummaryProvider('SUMMARY: user researched old things, visited shop.example');
    const runner = new CompactionRunner(
      tree,
      async () => ({ provider, model: 'task-model' }),
      (ev) => events.push(ev),
      { reserveTokens: 0, keepRecentTokens: 15_000 },
    );

    const compacted = await runner.compact(t.id);
    expect(compacted).toBe(true);

    // Internal turn events, non-steerable.
    expect(events[0]).toMatchObject({ type: 'turn.start', turnKind: 'compaction', steerable: false });
    expect(events[1]).toMatchObject({ type: 'turn.complete', stopReason: 'done' });

    const meta = await tree.getThread(t.id);
    const ctx = await buildSessionContext(tree, t.id, meta!.leafId!);
    expect(ctx.lastCompaction).not.toBeNull();
    expect(ctx.lastCompaction!.trackedOps.visitedUrls).toEqual(['https://shop.example']);

    const texts = ctx.messages.flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));
    expect(texts.some((x) => x.includes('SUMMARY: user researched'))).toBe(true);
    expect(texts.some((x) => x.includes('old-question'))).toBe(false);
    expect(texts.some((x) => x.includes('recent-question'))).toBe(true);
  });

  it('feeds the previous summary and trackedOps into the next compaction prompt', async () => {
    const t = await seedLongThread();
    const provider = new SummaryProvider('second summary');
    const runner = new CompactionRunner(
      tree,
      async () => ({ provider, model: 'task' }),
      () => {},
      { reserveTokens: 0, keepRecentTokens: 15_000 },
    );
    await runner.compact(t.id);

    // Grow the thread past the keep window again.
    await tree.appendNode(t.id, { type: 'user_message', payload: big('newer-q') });
    await tree.appendNode(t.id, { type: 'assistant_message', payload: { ...big('newer-a'), model: 'm', connectionId: 'c' } });
    await tree.appendNode(t.id, { type: 'turn_context', payload: { turnId: 'c', model: { connectionId: '', modelId: 'm' }, approvalPolicy: 'untrusted', capabilityScope: 'cross-origin', activeSkills: [] } });
    await tree.appendNode(t.id, { type: 'user_message', payload: big('newest-q') });

    const secondCompacted = await runner.compact(t.id);
    expect(secondCompacted).toBe(true);
    // The second prompt must iterate on the first summary (compound-loss prevention).
    expect(provider.prompts[1]).toContain('second summary');
    expect(provider.prompts[1]).toContain('shop.example'); // trackedOps carried forward
  });

  it('returns false and stays silent when there is nothing to cut', async () => {
    const t = await tree.createThread({});
    await tree.appendNode(t.id, { type: 'user_message', payload: { content: [{ type: 'text', text: 'short' }] } });
    const runner = new CompactionRunner(tree, async () => ({ provider: new SummaryProvider('s'), model: 'm' }), (ev) => events.push(ev));
    expect(await runner.compact(t.id)).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('CompactionRunner.summarizeAbandonedBranch (docs/04 §5.2)', () => {
  it('injects a branch_summary node into the new branch', async () => {
    const t = await tree.createThread({});
    await tree.appendNode(t.id, { type: 'user_message', payload: { content: [{ type: 'text', text: 'Q' }] } });
    const ansA = await tree.appendNode(t.id, { type: 'assistant_message', payload: { content: [{ type: 'text', text: 'approach A: tried selector .foo, hit login wall' }], model: 'm', connectionId: 'c' } });
    // Fork to approach B.
    const ansB = await tree.forkAt(t.id, ansA.id, { type: 'assistant_message', payload: { content: [{ type: 'text', text: 'approach B' }], model: 'm', connectionId: 'c' } });

    const runner = new CompactionRunner(
      tree,
      async () => ({ provider: new SummaryProvider('A hit a login wall at step 2'), model: 'task' }),
      () => {},
    );
    await runner.summarizeAbandonedBranch(t.id, ansA.id, ansB.id);

    const meta = await tree.getThread(t.id);
    const ctx = await buildSessionContext(tree, t.id, meta!.leafId!);
    const texts = ctx.messages.flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));
    expect(texts.some((x) => x.includes('A hit a login wall'))).toBe(true);
    // Abandoned branch content itself is NOT in the new context.
    expect(texts.some((x) => x.includes('approach A: tried selector'))).toBe(false);
  });
});
