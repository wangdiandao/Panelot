/**
 * turn.fork (docs/02 §3.2): branch-and-run. Regenerate and edit-and-resend
 * append the new user message as a SIBLING of the anchor's branch — history
 * survives as branches, leafId lands on the new branch, and the snapshot's
 * branch counters reflect the siblings.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { RealEngineCore, type ProviderResolver } from '../../src/engine/core';
import { EngineHost } from '../../src/engine/host';
import { createDirectPair } from '../../src/messaging/transport';
import { ToolRegistry } from '../../src/agent/tool';
import type { GatekeeperCheck } from '../../src/agent/loop';
import type { AgentEvent, Op } from '../../src/messaging/protocol';
import type { FinalResult, ProviderAdapter, ProviderStream, StreamRequest } from '../../src/providers/types';

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

class MockProvider implements ProviderAdapter {
  requests: StreamRequest[] = [];
  private replies: string[] = [];
  queue(...texts: string[]) {
    this.replies.push(...texts);
  }
  stream(req: StreamRequest): ProviderStream {
    this.requests.push(req);
    const text = this.replies.shift() ?? 'ok';
    const final: FinalResult = {
      message: [{ type: 'text', text }],
      toolCalls: [],
      usage: { input: 10, output: 5 },
      stopReason: 'end',
    };
    async function* gen() {
      yield { type: 'text' as const, delta: text };
    }
    const it = gen();
    return {
      [Symbol.asyncIterator]: () => it,
      final: async () => {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        for await (const _ of it) { /* drain */ }
        return final;
      },
    };
  }
  async verify() {
    return { reachable: true, keyValid: true, streaming: true, toolUse: true };
  }
}

class TestClient {
  events: AgentEvent[] = [];
  private waiters: { predicate: (ev: AgentEvent) => boolean; resolve: (ev: AgentEvent) => void }[] = [];
  constructor(private send: (op: Op) => void) {}
  receive(ev: AgentEvent): void {
    this.events.push(ev);
    this.waiters = this.waiters.filter((w) => (w.predicate(ev) ? (w.resolve(ev), false) : true));
  }
  post(op: DistributiveOmit<Op, 'submissionId'> & { submissionId?: string }): string {
    const submissionId = op.submissionId ?? crypto.randomUUID();
    this.send({ ...op, submissionId } as Op);
    return submissionId;
  }
  waitNth<T extends AgentEvent['type']>(type: T, nth: number, timeoutMs = 3000): Promise<Extract<AgentEvent, { type: T }>> {
    const found = this.events.filter((e) => e.type === type);
    if (found.length >= nth) return Promise.resolve(found[nth - 1] as Extract<AgentEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${type} #${nth}; got: ${this.events.map((e) => e.type).join(',')}`)),
        timeoutMs,
      );
      this.waiters.push({
        predicate: (ev) => ev.type === type && this.events.filter((e) => e.type === type).length >= nth,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev as Extract<AgentEvent, { type: T }>);
        },
      });
    });
  }
}

const allowAll: GatekeeperCheck = { check: async () => ({ verdict: 'allow' }) };
let n = 0;

function build() {
  const db = new PanelotDB(`fork-test-${Date.now()}-${n++}`);
  const provider = new MockProvider();
  const resolver: ProviderResolver = {
    resolve: async () => ({ provider, model: 'mock', params: {} }),
  };
  const core = new RealEngineCore(db, new ToolRegistry(), allowAll, resolver);
  const host = new EngineHost(core);
  core.onBroadcast = (ev) => host.broadcast(ev);
  const { transport, connection } = createDirectPair();
  host.onConnection(connection);
  const client = new TestClient((op) => transport.send(op));
  transport.onEvent((ev) => client.receive(ev));
  return { db, core, client, provider };
}

async function setupThread(client: TestClient, db: PanelotDB): Promise<string> {
  client.post({ type: 'initialize', protocolVersion: 1 });
  await client.waitNth('initialized', 1);
  client.post({ type: 'thread.create' });
  const created = (await client.waitNth('thread.created', 1)) as Extract<AgentEvent, { type: 'thread.created' }>;
  await db.threads.update(created.threadId, { title: 'pre-titled' });
  client.post({ type: 'thread.subscribe', threadId: created.threadId });
  await client.waitNth('initialized', 2);
  return created.threadId;
}

describe('turn.fork', () => {
  it('regenerate: forking at the user node re-runs the turn as a sibling branch', async () => {
    const { db, core, client, provider } = build();
    const threadId = await setupThread(client, db);
    provider.queue('first answer', 'second answer');

    client.post({ type: 'turn.submit', threadId, input: { text: 'question' } });
    await client.waitNth('turn.complete', 1);

    const snap1 = await core.getSnapshot(threadId);
    const user1 = snap1!.items.find((i) => i.kind === 'user_message')!;
    expect(user1.branch).toBeUndefined();

    // Regenerate = fork at the preceding user node, re-sending its text.
    client.post({ type: 'turn.fork', threadId, siblingOfNodeId: user1.nodeId, input: { text: 'question' } });
    await client.waitNth('turn.complete', 2);

    const snap2 = await core.getSnapshot(threadId);
    // Path shows only the NEW branch: user(question) → assistant(second answer).
    const kinds = snap2!.items.map((i) => i.kind);
    expect(kinds).toEqual(['user_message', 'assistant_message']);
    // Both turns' user messages are logical siblings (each under its own
    // turn_context) — branch shows 2/2 on the active user node.
    const user2 = snap2!.items[0]!;
    expect(user2.branch).toEqual({ index: 2, count: 2 });
    const tree = new ThreadTree(db);
    const logical = await tree.getLogicalSiblings(threadId, user2.nodeId);
    expect(logical).toHaveLength(2);
    // leafId lives on the new branch (the second answer).
    const last = snap2!.items[snap2!.items.length - 1]!;
    const text = (last.payload as { content: { type: string; text?: string }[] }).content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    expect(text).toBe('second answer');
  });

  it('edit-and-resend: forking at the user node creates a sibling user branch', async () => {
    const { db, core, client, provider } = build();
    const threadId = await setupThread(client, db);
    provider.queue('answer A', 'answer B');

    client.post({ type: 'turn.submit', threadId, input: { text: 'original' } });
    await client.waitNth('turn.complete', 1);
    const snap1 = await core.getSnapshot(threadId);
    const user1 = snap1!.items.find((i) => i.kind === 'user_message')!;

    client.post({ type: 'turn.fork', threadId, siblingOfNodeId: user1.nodeId, input: { text: 'edited' } });
    await client.waitNth('turn.complete', 2);

    const snap2 = await core.getSnapshot(threadId);
    const users = snap2!.items.filter((i) => i.kind === 'user_message');
    expect(users).toHaveLength(1); // path shows only the active branch
    const activeUser = users[0]!;
    const text = (activeUser.payload as { content: { type: string; text?: string }[] }).content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    expect(text).toBe('edited');
    // Branch counter on the user node: 2 logical siblings, edited is #2.
    expect(activeUser.branch).toEqual({ index: 2, count: 2 });
  });

  it('selectBranch on a logical sibling returns to the original branch', async () => {
    const { db, core, client, provider } = build();
    const threadId = await setupThread(client, db);
    provider.queue('answer A', 'answer B');

    client.post({ type: 'turn.submit', threadId, input: { text: 'original' } });
    await client.waitNth('turn.complete', 1);
    const snap1 = await core.getSnapshot(threadId);
    const user1 = snap1!.items.find((i) => i.kind === 'user_message')!;

    client.post({ type: 'turn.fork', threadId, siblingOfNodeId: user1.nodeId, input: { text: 'edited' } });
    await client.waitNth('turn.complete', 2);

    // Switch back to the original branch via its user node.
    client.post({ type: 'thread.selectBranch', threadId, nodeId: user1.nodeId });
    await client.waitNth('thread.updated', 1);

    const snap3 = await core.getSnapshot(threadId);
    const activeUser = snap3!.items.find((i) => i.kind === 'user_message')!;
    const text = (activeUser.payload as { content: { type: string; text?: string }[] }).content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    expect(text).toBe('original');
    expect(activeUser.branch).toEqual({ index: 1, count: 2 });
    // The assistant answer on this branch is the original one.
    const assistant = snap3!.items.find((i) => i.kind === 'assistant_message')!;
    const aText = (assistant.payload as { content: { type: string; text?: string }[] }).content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('');
    expect(aText).toBe('answer A');
  });

  it('rejects forking an unknown node', async () => {
    const { db, client } = build();
    const threadId = await setupThread(client, db);
    client.post({ type: 'turn.fork', threadId, siblingOfNodeId: 'no-such-node', input: { text: 'x' } });
    const err = (await client.waitNth('error', 1)) as Extract<AgentEvent, { type: 'error' }>;
    expect(err.code).toBe('thread_not_found');
  });
});
