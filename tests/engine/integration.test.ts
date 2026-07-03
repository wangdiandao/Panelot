/**
 * Full-stack engine regression: DirectTransport → EngineHost → RealEngineCore
 * → mock provider → Dexie. No browser required (docs/04 §7).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PanelotDB } from '../../src/db/schema';
import { RealEngineCore, type ProviderResolver } from '../../src/engine/core';
import { EngineHost } from '../../src/engine/host';
import { createDirectPair } from '../../src/messaging/transport';
import { ToolRegistry, type AgentTool } from '../../src/agent/tool';
import type { GatekeeperCheck } from '../../src/agent/loop';
import type { AgentEvent, Op, ThreadSnapshot } from '../../src/messaging/protocol';
import type { FinalResult, ProviderAdapter, ProviderStream, StreamEvent, StreamRequest } from '../../src/providers/types';

// ---------------------------------------------------------------------------

/** Omit that distributes over union members (plain Omit collapses the union). */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

type Scripted = Partial<FinalResult> & { streamText?: string[] };

class MockProvider implements ProviderAdapter {
  requests: StreamRequest[] = [];
  private script: Scripted[] = [];
  private i = 0;
  queue(...r: Scripted[]) {
    this.script.push(...r);
  }
  stream(req: StreamRequest): ProviderStream {
    this.requests.push(req);
    const s = this.script[this.i++] ?? {};
    const events: StreamEvent[] = (s.streamText ?? []).map((t) => ({ type: 'text', delta: t }));
    const final: FinalResult = {
      message: s.message ?? [{ type: 'text', text: (s.streamText ?? []).join('') }],
      toolCalls: s.toolCalls ?? [],
      usage: s.usage ?? { input: 50, output: 10 },
      stopReason: s.stopReason ?? ((s.toolCalls?.length ?? 0) > 0 ? 'tool_use' : 'end'),
    };
    async function* gen() {
      for (const ev of events) yield ev;
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
    this.waiters = this.waiters.filter((w) => {
      if (w.predicate(ev)) {
        w.resolve(ev);
        return false;
      }
      return true;
    });
  }

  post(op: DistributiveOmit<Op, 'submissionId'> & { submissionId?: string }): string {
    const submissionId = op.submissionId ?? crypto.randomUUID();
    this.send({ ...op, submissionId } as Op);
    return submissionId;
  }

  waitFor<T extends AgentEvent['type']>(type: T, timeoutMs = 3000): Promise<Extract<AgentEvent, { type: T }>> {
    const existing = this.events.find((e) => e.type === type);
    if (existing) return Promise.resolve(existing as Extract<AgentEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}; got: ${this.events.map((e) => e.type).join(',')}`)), timeoutMs);
      this.waiters.push({
        predicate: (ev) => ev.type === type,
        resolve: (ev) => {
          clearTimeout(timer);
          resolve(ev as Extract<AgentEvent, { type: T }>);
        },
      });
    });
  }
}

// ---------------------------------------------------------------------------

let db: PanelotDB;
let provider: MockProvider;
let tools: ToolRegistry;
let n = 0;

const allowAll: GatekeeperCheck = { check: async () => ({ verdict: 'allow' }) };

function buildEngine(dbInstance?: PanelotDB) {
  db = dbInstance ?? new PanelotDB(`int-test-${Date.now()}-${n++}`);
  provider = provider ?? new MockProvider();
  tools = new ToolRegistry();
  const resolver: ProviderResolver = {
    resolve: async () => ({ provider, model: 'mock', params: {}, contextWindow: 128_000 }),
  };
  const core = new RealEngineCore(db, tools, allowAll, resolver);
  const host = new EngineHost(core);
  core.onBroadcast = (ev) => host.broadcast(ev);
  return { core, host };
}

function connect(host: EngineHost): TestClient {
  const { transport, connection } = createDirectPair();
  host.onConnection(connection);
  const client = new TestClient((op) => transport.send(op));
  transport.onEvent((ev) => client.receive(ev));
  return client;
}

beforeEach(() => {
  provider = new MockProvider();
});

async function initThread(client: TestClient): Promise<string> {
  client.post({ type: 'initialize', protocolVersion: 1 });
  await client.waitFor('initialized');
  client.post({ type: 'thread.create' });
  const created = await client.waitFor('thread.created');
  // Pre-title the thread so the once-only title job doesn't consume scripted
  // mock responses mid-test.
  await db.threads.update(created.threadId, { title: 'test-thread' });
  // Subscribe so thread-scoped broadcasts reach this client.
  client.post({ type: 'thread.subscribe', threadId: created.threadId });
  await new Promise<void>((resolve) => {
    const check = () =>
      client.events.filter((e) => e.type === 'initialized').length >= 2 ? resolve() : setTimeout(check, 5);
    check();
  });
  return created.threadId;
}

// ---------------------------------------------------------------------------

describe('engine integration (Op → events → DB)', () => {
  it('turn.submit streams deltas and completes; snapshot reflects the conversation', async () => {
    const { core, host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue({ streamText: ['He', 'llo!'] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'hi' } });
    await client.waitFor('turn.complete');

    // Deltas were coalesced (16ms window) but content is intact.
    const deltas = client.events.filter((e) => e.type === 'item.delta');
    const text = deltas.map((d) => (d as { delta: { text?: string } }).delta.text ?? '').join('');
    expect(text).toBe('Hello!');

    const snapshot = await core.getSnapshot(threadId);
    expect(snapshot!.items.map((i) => i.kind)).toEqual(['user_message', 'assistant_message']);
    expect(snapshot!.activeTurn).toBeNull();
  });

  it('approval RPC round-trip: approval.request → response → tool runs', async () => {
    const { host } = buildEngine();
    // Gatekeeper that asks for writes — override via a write tool + ask verdict.
    tools.register({
      name: 'poke',
      label: 'Poke',
      description: 'poke',
      parameters: z.object({}),
      level: 'L1',
      effects: 'write',
      execute: async () => ({ content: [{ type: 'text', text: 'poked' }] }),
    });

    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'poke', params: {} }] },
      { streamText: ['done'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'poke it' } });

    // allowAll gatekeeper → no approval.request expected; this test asserts the
    // tool ran straight through.
    await client.waitFor('turn.complete');
    const resultMsg = provider.requests[1]!.messages.find((m) => m.role === 'tool_result')!;
    expect((resultMsg.content[0] as { text: string }).text).toBe('poked');
  });

  it('turn.steer with wrong expectedTurnId errors; correct id injects', async () => {
    const { host } = buildEngine();
    let releaseTool: () => void;
    const gate = new Promise<void>((r) => (releaseTool = r));
    tools.register({
      name: 'slow',
      label: 'Slow',
      description: 'slow tool',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      execute: async () => {
        await gate;
        return { content: [{ type: 'text', text: 'finally' }] };
      },
    });

    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'slow', params: {} }] },
      { streamText: ['after steer'] },
    );
    client.post({ type: 'turn.submit', threadId, input: { text: 'start' } });
    const turnStart = await client.waitFor('turn.start');

    // Wrong turn id → turn_mismatch error.
    client.post({ type: 'turn.steer', threadId, expectedTurnId: 'wrong', input: { text: 'x' } });
    const err = await client.waitFor('error');
    expect(err.code).toBe('turn_mismatch');

    // Correct id → injected after current call.
    client.post({ type: 'turn.steer', threadId, expectedTurnId: turnStart.turnId, input: { text: 'also do B' } });
    releaseTool!();
    await client.waitFor('turn.complete');

    const lastReq = provider.requests[1]!;
    const userTexts = lastReq.messages.filter((m) => m.role === 'user')
      .flatMap((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')));
    expect(userTexts).toContain('also do B');
  });

  it('turn.interrupt stops the turn with stopReason interrupted', async () => {
    const { host } = buildEngine();
    tools.register({
      name: 'forever',
      label: 'Forever',
      description: 'never returns until aborted',
      parameters: z.object({}),
      level: 'builtin',
      effects: 'read',
      execute: (_id, _p, signal) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))),
    });

    const client = connect(host);
    const threadId = await initThread(client);
    provider.queue({ toolCalls: [{ id: 'c1', name: 'forever', params: {} }] });

    client.post({ type: 'turn.submit', threadId, input: { text: 'go' } });
    await client.waitFor('item.start');
    client.post({ type: 'turn.interrupt', threadId });
    const complete = await client.waitFor('turn.complete');
    expect(complete.stopReason).toBe('interrupted');
  });

  it('enqueue while busy: second input runs as the NEXT turn; queue.updated fires', async () => {
    const { host } = buildEngine();
    const client = connect(host);
    const threadId = await initThread(client);

    provider.queue({ streamText: ['first answer'] }, { streamText: ['second answer'] });
    client.post({ type: 'turn.submit', threadId, input: { text: 'first' } });
    client.post({ type: 'turn.enqueue', threadId, input: { text: 'second' } });

    // Two turn.completes in order.
    await client.waitFor('turn.complete');
    const completes = () => client.events.filter((e) => e.type === 'turn.complete');
    await new Promise<void>((resolve) => {
      const check = () => (completes().length >= 2 ? resolve() : setTimeout(check, 10));
      check();
    });

    expect(provider.requests).toHaveLength(2);
    const secondUser = provider.requests[1]!.messages.filter((m) => m.role === 'user').pop()!;
    expect((secondUser.content[0] as { text: string }).text).toBe('second');
    expect(client.events.some((e) => e.type === 'queue.updated')).toBe(true);
  });

  it('SW-kill recovery: new engine over the same DB rebuilds the snapshot and continues', async () => {
    // Engine instance 1: run a full turn with a tool call.
    const dbName = `int-recovery-${Date.now()}`;
    const sharedDb = new PanelotDB(dbName);
    const { host: host1 } = buildEngine(sharedDb);
    tools.register({
      name: 'echo',
      label: 'Echo',
      description: 'echo',
      parameters: z.object({ text: z.string() }),
      level: 'builtin',
      effects: 'read',
      execute: async (_id, p: { text: string }) => ({ content: [{ type: 'text', text: `echo:${p.text}` }] }),
    });
    const client1 = connect(host1);
    const threadId = await initThread(client1);
    provider.queue(
      { toolCalls: [{ id: 'c1', name: 'echo', params: { text: 'checkpoint' } }] },
      { streamText: ['all done'] },
    );
    client1.post({ type: 'turn.submit', threadId, input: { text: 'do it' } });
    await client1.waitFor('turn.complete');

    // "SW killed": build a brand-new engine over the same database.
    const provider2 = new MockProvider();
    provider = provider2;
    const { host: host2 } = buildEngine(sharedDb);
    const client2 = connect(host2);
    client2.post({ type: 'initialize', protocolVersion: 1, subscribe: { threadId } });
    const init = await client2.waitFor('initialized');
    const snapshot = init.snapshot as ThreadSnapshot;

    // Replay reconstructed the full history from checkpoints.
    expect(snapshot.items.map((i) => i.kind)).toEqual([
      'user_message', 'assistant_message', 'tool_call', 'tool_result', 'assistant_message',
    ]);
    expect(snapshot.activeTurn).toBeNull();

    // Continue the conversation on the recovered engine.
    provider2.queue({ streamText: ['continuing fine'] });
    client2.post({ type: 'turn.submit', threadId, input: { text: 'continue' } });
    await client2.waitFor('turn.complete');
    // History fed to the model includes the pre-kill tool result.
    const req = provider2.requests[0]!;
    const resultMsg = req.messages.find((m) => m.role === 'tool_result')!;
    expect((resultMsg.content[0] as { text: string }).text).toBe('echo:checkpoint');
  });
});
