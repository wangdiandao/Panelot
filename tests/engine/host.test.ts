import { describe, expect, it, vi } from 'vitest';
import { EngineHost, StubEngineCore, type EngineCore } from '../../src/engine/host';
import { PROTOCOL_VERSION } from '../../src/messaging/protocol';
import type { AgentEvent, Op, ThreadSnapshot } from '../../src/messaging/protocol';
import { createDirectPair, type EngineTransport } from '../../src/messaging/transport';

function connect(host: EngineHost): EngineTransport {
  const { transport, connection } = createDirectPair();
  host.onConnection(connection);
  return transport;
}

function collect(transport: EngineTransport): AgentEvent[] {
  const events: AgentEvent[] = [];
  transport.onEvent((ev) => events.push(ev));
  return events;
}

const flush = () => new Promise((r) => setTimeout(r, 30));

function init(transport: EngineTransport, threadId?: string) {
  transport.send({
    type: 'initialize',
    submissionId: 'init-1',
    protocolVersion: PROTOCOL_VERSION,
    ...(threadId ? { subscribe: { threadId } } : {}),
  });
}

describe('EngineHost handshake', () => {
  it('answers initialize with protocol version and no snapshot for unknown thread', async () => {
    const host = new EngineHost(new StubEngineCore());
    const t = connect(host);
    const events = collect(t);

    init(t, 'nonexistent');
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'initialized',
      submissionId: 'init-1',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect((events[0] as { snapshot?: unknown }).snapshot).toBeUndefined();
  });

  it('returns a snapshot when subscribing to an existing thread', async () => {
    const snapshot: ThreadSnapshot = {
      meta: {
        id: 't1', title: 'Test', createdAt: 1, updatedAt: 2, leafId: null,
        archived: false, pinned: false,
        stats: { turns: 0, totalTokens: 0, costUsd: 0 },
      },
      items: [],
      activeTurn: null,
      pendingApprovals: [],
      queuedInputs: 0,
    };
    const core: EngineCore = {
      handleOp: vi.fn(async () => {}),
      getSnapshot: async (id) => (id === 't1' ? snapshot : null),
      threadIdOf: () => null,
    };
    const host = new EngineHost(core);
    const t = connect(host);
    const events = collect(t);

    init(t, 't1');
    await flush();

    expect(events[0]).toMatchObject({ type: 'initialized' });
    expect((events[0] as { snapshot: ThreadSnapshot }).snapshot.meta.id).toBe('t1');
  });

  it('answers ping with pong without requiring initialize', async () => {
    const host = new EngineHost(new StubEngineCore());
    const t = connect(host);
    const events = collect(t);

    t.send({ type: 'ping', submissionId: 'p1' });
    await flush();

    expect(events[0]).toEqual({ type: 'pong', submissionId: 'p1' });
  });

  it('rejects ops before initialize', async () => {
    const host = new EngineHost(new StubEngineCore());
    const t = connect(host);
    const events = collect(t);

    t.send({ type: 'turn.interrupt', submissionId: 's1', threadId: 't1' });
    await flush();

    expect(events[0]).toMatchObject({ type: 'error', submissionId: 's1', retryable: true });
  });

  it('rejects malformed messages without crashing', async () => {
    const host = new EngineHost(new StubEngineCore());
    const t = connect(host);
    const events = collect(t);

    t.send({ type: 'nonsense' } as unknown as Op);
    await flush();

    expect(events[0]).toMatchObject({ type: 'error', code: 'internal' });
  });
});

describe('EngineHost bounded queue', () => {
  it('emits overloaded when a thread queue exceeds capacity', async () => {
    // A core whose op handling never resolves, so the queue only fills.
    let firstStarted = false;
    const core: EngineCore = {
      handleOp: () =>
        new Promise(() => {
          firstStarted = true;
        }),
      getSnapshot: async () => null,
      threadIdOf: (op) => ('threadId' in op ? (op as { threadId: string }).threadId : null),
    };
    const host = new EngineHost(core);
    const t = connect(host);
    const events = collect(t);

    init(t);
    await flush();

    // 1 op executing (dequeued) + 32 queued; the 34th must bounce.
    for (let i = 0; i < 34; i++) {
      t.send({ type: 'turn.interrupt', submissionId: `s${i}`, threadId: 'tq' });
    }
    await flush();

    expect(firstStarted).toBe(true);
    const overloaded = events.filter((e) => e.type === 'overloaded');
    expect(overloaded).toHaveLength(1);
    expect(overloaded[0]).toMatchObject({ submissionId: 's33' });
  });

  it('serializes ops per thread but runs threads independently', async () => {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    const core: EngineCore = {
      handleOp: (op) =>
        new Promise<void>((resolve) => {
          order.push(`start:${op.submissionId}`);
          gates.set(op.submissionId, () => {
            order.push(`end:${op.submissionId}`);
            resolve();
          });
        }),
      getSnapshot: async () => null,
      threadIdOf: (op) => ('threadId' in op ? (op as { threadId: string }).threadId : null),
    };
    const host = new EngineHost(core);
    const t = connect(host);
    init(t);
    await flush();

    t.send({ type: 'turn.interrupt', submissionId: 'a1', threadId: 'A' });
    t.send({ type: 'turn.interrupt', submissionId: 'a2', threadId: 'A' });
    t.send({ type: 'turn.interrupt', submissionId: 'b1', threadId: 'B' });
    await flush();

    // a2 must wait for a1; b1 must not.
    expect(order).toEqual(['start:a1', 'start:b1']);
    gates.get('a1')!();
    await flush();
    expect(order).toContain('start:a2');
  });
});

describe('EngineHost event routing', () => {
  it('broadcasts thread events only to subscribers of that thread', async () => {
    const snapshot: ThreadSnapshot = {
      meta: {
        id: 'tA', title: '', createdAt: 0, updatedAt: 0, leafId: null,
        archived: false, pinned: false, stats: { turns: 0, totalTokens: 0, costUsd: 0 },
      },
      items: [], activeTurn: null, pendingApprovals: [], queuedInputs: 0,
    };
    const core: EngineCore = {
      handleOp: vi.fn(async () => {}),
      getSnapshot: async (id) => (id === 'tA' ? snapshot : null),
      threadIdOf: () => null,
    };
    const host = new EngineHost(core);

    const subscriber = connect(host);
    const subEvents = collect(subscriber);
    init(subscriber, 'tA');

    const bystander = connect(host);
    const byEvents = collect(bystander);
    init(bystander);
    await flush();

    host.broadcast({ type: 'turn.start', threadId: 'tA', turnId: 'x', turnKind: 'user', steerable: true });
    await flush();

    expect(subEvents.some((e) => e.type === 'turn.start')).toBe(true);
    expect(byEvents.some((e) => e.type === 'turn.start')).toBe(false);
  });

  it('delivers activity.updated to clients subscribed to OTHER threads (sidebar indicators)', async () => {
    const core: EngineCore = {
      handleOp: vi.fn(async () => {}),
      getSnapshot: async () => null,
      threadIdOf: () => null,
    };
    const host = new EngineHost(core);

    // Subscribed to thread B — must still hear about thread A's activity
    // (the event has no top-level threadId, so the filter lets it through).
    const otherThreadClient = connect(host);
    const events = collect(otherThreadClient);
    init(otherThreadClient);
    await flush();

    host.broadcast({ type: 'activity.updated', activity: { threadId: 'tA', running: true, pendingApprovals: 0 } });
    await flush();

    const got = events.find((e) => e.type === 'activity.updated');
    expect(got).toBeDefined();
    expect((got as { activity: { threadId: string; running: boolean } }).activity).toMatchObject({ threadId: 'tA', running: true });
  });

  // item.delta/complete now carry threadId (cross-thread isolation), so the
  // client must be subscribed to receive them.
  function subscribedHost(threadId: string) {
    const snapshot: ThreadSnapshot = {
      meta: {
        id: threadId, title: '', createdAt: 1, updatedAt: 2, leafId: null,
        archived: false, pinned: false,
        stats: { turns: 0, totalTokens: 0, costUsd: 0 },
      },
      items: [],
      activeTurn: null,
      pendingApprovals: [],
      queuedInputs: 0,
    };
    const core: EngineCore = {
      handleOp: vi.fn(async () => {}),
      getSnapshot: async (id) => (id === threadId ? snapshot : null),
      threadIdOf: () => null,
    };
    return new EngineHost(core);
  }

  it('coalesces consecutive text deltas for the same item within 16ms', async () => {
    const host = subscribedHost('tC');
    const t = connect(host);
    const events = collect(t);
    init(t, 'tC');
    await flush();

    for (const ch of ['H', 'e', 'l', 'l', 'o']) {
      host.broadcast({ type: 'item.delta', threadId: 'tC', itemId: 'i1', delta: { text: ch } });
    }
    await flush();

    const deltas = events.filter((e) => e.type === 'item.delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ itemId: 'i1', threadId: 'tC', delta: { text: 'Hello' } });
  });

  it('flushes buffered deltas before a non-delta event (ordering preserved)', async () => {
    const host = subscribedHost('tC');
    const t = connect(host);
    const events = collect(t);
    init(t, 'tC');
    await flush();

    host.broadcast({ type: 'item.delta', threadId: 'tC', itemId: 'i1', delta: { text: 'partial' } });
    host.broadcast({ type: 'item.complete', threadId: 'tC', itemId: 'i1', result: { ok: true } });
    await flush();

    const relevant = events.filter((e) => e.type === 'item.delta' || e.type === 'item.complete');
    expect(relevant.map((e) => e.type)).toEqual(['item.delta', 'item.complete']);
    expect(relevant[0]).toMatchObject({ delta: { text: 'partial' } });
  });
});

describe('DirectTransport', () => {
  it('fires onDisconnect when closed', async () => {
    const { transport, connection } = createDirectPair();
    const host = new EngineHost(new StubEngineCore());
    host.onConnection(connection);

    const disconnected = vi.fn();
    transport.onDisconnect(disconnected);
    transport.close();
    await flush();

    expect(disconnected).toHaveBeenCalledOnce();
    expect(() => transport.send({ type: 'ping', submissionId: 'x' })).toThrow();
  });
});
