import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers';
import {
  allocateEngineStreamEpoch,
  EngineHost,
  StubEngineCore,
  type EngineCore,
} from '../../src/engine/host';
import { ENGINE_PROTOCOL, ENGINE_SCHEMA_HASH } from '../../src/messaging/protocol';
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

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function init(transport: EngineTransport, threadId?: string) {
  transport.send({
    type: 'initialize',
    submissionId: 'init-1',
    protocol: ENGINE_PROTOCOL,
    schemaHash: ENGINE_SCHEMA_HASH,
    clientId: 'host-test-client',
    ...(threadId ? { subscribe: { threadId } } : {}),
  });
}

describe('EngineHost handshake', () => {
  it('holds initialization and queued commands behind the startup recovery barrier', async () => {
    let releaseRecovery!: () => void;
    const recoveryReady = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const handled: string[] = [];
    const core: EngineCore = {
      handleOp: async (op) => {
        handled.push(op.submissionId);
      },
      getSnapshot: async () => null,
      threadIdOf: (op) => ('threadId' in op ? op.threadId : null),
    };
    const host = new EngineHost(core, recoveryReady);
    const transport = connect(host);
    const events = collect(transport);

    init(transport);
    transport.send({
      type: 'turn.interrupt',
      submissionId: 'after-recovery',
      threadId: 'thread-a',
    });
    await flush();
    expect(events).toEqual([]);
    expect(handled).toEqual([]);

    releaseRecovery();
    await flush();
    expect(events[0]).toMatchObject({ type: 'initialized', submissionId: 'init-1' });
    expect(handled).toEqual(['after-recovery']);
  });

  it('reports a rejected recovery barrier as reload-required and disconnects', async () => {
    const host = new EngineHost(
      new StubEngineCore(),
      Promise.reject(new Error('durable recovery failed')),
      { startupRecoveryTimeoutMs: 100 },
    );
    const transport = connect(host);
    const events = collect(transport);
    const disconnected = vi.fn();
    transport.onDisconnect(disconnected);

    init(transport);
    await flush();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'fatal.reload_required',
        message: expect.stringContaining('durable recovery failed'),
      }),
    );
    expect((events[0] as { message: string }).message).toContain('Reload the extension');
    expect((events[0] as { message: string }).message).not.toContain('Reconnect to retry');
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('times out a never-settling barrier for every connection and disconnects them', async () => {
    vi.useFakeTimers();
    try {
      const host = new EngineHost(new StubEngineCore(), new Promise<void>(() => {}), {
        startupRecoveryTimeoutMs: 5,
      });
      const first = connect(host);
      const second = connect(host);
      const firstEvents = collect(first);
      const secondEvents = collect(second);
      const firstDisconnected = vi.fn();
      const secondDisconnected = vi.fn();
      first.onDisconnect(firstDisconnected);
      second.onDisconnect(secondDisconnected);

      init(first);
      init(second);
      await vi.advanceTimersByTimeAsync(5);

      for (const events of [firstEvents, secondEvents]) {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'fatal.reload_required',
            message: expect.stringContaining('startup deadline'),
          }),
        );
      }
      expect(firstDisconnected).toHaveBeenCalledOnce();
      expect(secondDisconnected).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

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
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
    });
    expect((events[0] as { snapshot?: unknown }).snapshot).toBeUndefined();
  });

  it('requires a matching protocol and schema hash, then disconnects stale clients', async () => {
    const host = new EngineHost(new StubEngineCore());
    const t = connect(host);
    const events = collect(t);
    const disconnected = vi.fn();
    t.onDisconnect(disconnected);

    t.send({
      type: 'initialize',
      submissionId: 'stale-init',
      protocol: ENGINE_PROTOCOL,
      schemaHash: 'stale-schema',
      clientId: 'stale-client',
    } as Op);
    await flush();

    expect(events[0]).toMatchObject({
      type: 'fatal.reload_required',
      submissionId: 'stale-init',
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
    });
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('echoes an old client protocol in the stable reload-required envelope', async () => {
    const host = new EngineHost(new StubEngineCore());
    const transport = connect(host);
    const events = collect(transport);
    const disconnected = vi.fn();
    transport.onDisconnect(disconnected);

    transport.send({
      type: 'initialize',
      submissionId: 'old-init',
      protocol: 'panelot/engine-v0',
      schemaHash: 'old-schema',
      clientId: 'old-client',
    });
    await flush();

    expect(events[0]).toMatchObject({
      type: 'fatal.reload_required',
      submissionId: 'old-init',
      protocol: 'panelot/engine-v0',
      schemaHash: ENGINE_SCHEMA_HASH,
    });
    expect(disconnected).toHaveBeenCalledOnce();
  });

  it('returns a snapshot when subscribing to an existing thread', async () => {
    const snapshot: ThreadSnapshot = {
      meta: {
        id: 't1',
        revision: 0,
        title: 'Test',
        createdAt: 1,
        updatedAt: 2,
        leafId: null,
        archived: false,
        pinned: false,
        stats: { turns: 0, totalTokens: 0, costUsd: 0 },
      },
      items: [],
      activeTurn: null,
      pendingApprovals: [],
      queuedInputs: 0,
      queuedRuns: [],
      recoverableRuns: [],
    };
    const core: EngineCore = {
      handleOp: vi.fn(async () => {}),
      getSnapshot: async (id) => (id === 't1' ? snapshot : null),
      threadIdOf: () => null,
    };
    const host = new EngineHost(core, Promise.resolve(), { streamEpoch: 41 });
    const t = connect(host);
    const events = collect(t);

    init(t, 't1');
    await flush();

    expect(events[0]).toMatchObject({ type: 'initialized' });
    const initialized = events[0] as Extract<AgentEvent, { type: 'initialized' }>;
    expect(initialized.snapshot?.meta.id).toBe('t1');
    expect(initialized.stream).toEqual({ threadId: 't1', epoch: 41, sequence: 1 });
    expect(initialized.snapshot?.stream).toEqual(initialized.stream);

    host.broadcast({ type: 'thread.updated', threadId: 't1', revision: 1, patch: {} });
    await flush();
    expect(events[1]).toMatchObject({
      type: 'thread.updated',
      stream: { threadId: 't1', epoch: 41, sequence: 2 },
    });
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

    expect(events[0]).toMatchObject({ type: 'error', code: 'invalid_command' });
  });

  it('rejects a malformed known command with its submission id', async () => {
    const host = new EngineHost(new StubEngineCore());
    const t = connect(host);
    const events = collect(t);

    t.send({
      type: 'turn.submit',
      submissionId: 'bad-submit',
      threadId: 't1',
      input: { text: 17 },
    } as unknown as Op);
    await flush();

    expect(events[0]).toMatchObject({
      type: 'command.rejected',
      submissionId: 'bad-submit',
      code: 'invalid_command',
    });
  });

  it('allocates a monotonic worker epoch from session storage', async () => {
    const set = vi.fn(async () => undefined);
    const storage = {
      get: vi.fn(async () => ({ panelot_engine_stream_epoch: 7 })),
      set,
    } as unknown as Pick<chrome.storage.StorageArea, 'get' | 'set'>;

    await expect(allocateEngineStreamEpoch(storage)).resolves.toBe(8);
    expect(set).toHaveBeenCalledWith({ panelot_engine_stream_epoch: 8 });
  });
});

describe('EngineHost bounded queue', () => {
  it('rejects new runtime work while maintenance owns admission', async () => {
    let blocked = true;
    const handleOp = vi.fn(async () => undefined);
    const core: EngineCore = {
      handleOp,
      getSnapshot: async () => null,
      threadIdOf: (op) => ('threadId' in op ? op.threadId : null),
    };
    const host = new EngineHost(core, Promise.resolve(), {
      isAdmissionBlocked: () => blocked,
    });
    const transport = connect(host);
    const events = collect(transport);
    init(transport);
    await flush();

    transport.send({
      type: 'turn.interrupt',
      submissionId: 'blocked-by-maintenance',
      threadId: 'thread-a',
    });
    await flush();

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'command.rejected',
        submissionId: 'blocked-by-maintenance',
        code: 'overloaded',
        message: expect.stringContaining('maintenance'),
      }),
    );
    expect(handleOp).not.toHaveBeenCalled();

    blocked = false;
    transport.send({
      type: 'turn.interrupt',
      submissionId: 'admitted-after-maintenance',
      threadId: 'thread-a',
    });
    await flush();
    expect(handleOp).toHaveBeenCalledWith(
      expect.objectContaining({ submissionId: 'admitted-after-maintenance' }),
      expect.any(Function),
    );
  });

  it('waits for already admitted host and core work to become idle', async () => {
    let release!: () => void;
    const handled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitForAdmissionIdle = vi.fn(async () => undefined);
    const core: EngineCore = {
      handleOp: () => handled,
      getSnapshot: async () => null,
      threadIdOf: (op) => ('threadId' in op ? op.threadId : null),
      waitForAdmissionIdle,
      activeThreadIds: () => ['core-active'],
    };
    const host = new EngineHost(core);
    const transport = connect(host);
    init(transport);
    await flush();
    transport.send({
      type: 'turn.interrupt',
      submissionId: 'already-admitted',
      threadId: 'host-active',
    });
    await flush();

    expect(new Set(host.activeThreadIds())).toEqual(new Set(['host-active', 'core-active']));
    let idle = false;
    const waiting = host.waitForAdmissionIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);

    release();
    await waiting;
    expect(waitForAdmissionIdle).toHaveBeenCalledOnce();
    expect(idle).toBe(true);
  });

  it('rejects a command when a thread queue exceeds capacity', async () => {
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
    const rejected = events.filter(
      (event) => event.type === 'command.rejected' && event.code === 'overloaded',
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ submissionId: 's33' });
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
    const releaseA1 = gates.get('a1');
    if (!releaseA1) throw new Error('a1 gate was not registered');
    releaseA1();
    await flush();
    expect(order).toContain('start:a2');
  });
});

describe('EngineHost event routing', () => {
  it('broadcasts thread events only to subscribers of that thread', async () => {
    const snapshot: ThreadSnapshot = {
      meta: {
        id: 'tA',
        revision: 0,
        title: '',
        createdAt: 0,
        updatedAt: 0,
        leafId: null,
        archived: false,
        pinned: false,
        stats: { turns: 0, totalTokens: 0, costUsd: 0 },
      },
      items: [],
      activeTurn: null,
      pendingApprovals: [],
      queuedInputs: 0,
      queuedRuns: [],
      recoverableRuns: [],
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

    host.broadcast({
      type: 'turn.start',
      threadId: 'tA',
      turnId: 'x',
      turnKind: 'user',
      steerable: true,
    });
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

    host.broadcast({
      type: 'activity.updated',
      activity: { threadId: 'tA', running: true, pendingApprovals: 0 },
    });
    await flush();

    const got = events.find((e) => e.type === 'activity.updated');
    expect(got).toBeDefined();
    expect((got as { activity: { threadId: string; running: boolean } }).activity).toMatchObject({
      threadId: 'tA',
      running: true,
    });
  });

  // item.delta/complete now carry threadId (cross-thread isolation), so the
  // client must be subscribed to receive them.
  function subscribedHost(threadId: string) {
    const snapshot: ThreadSnapshot = {
      meta: {
        id: threadId,
        revision: 0,
        title: '',
        createdAt: 1,
        updatedAt: 2,
        leafId: null,
        archived: false,
        pinned: false,
        stats: { turns: 0, totalTokens: 0, costUsd: 0 },
      },
      items: [],
      activeTurn: null,
      pendingApprovals: [],
      queuedInputs: 0,
      queuedRuns: [],
      recoverableRuns: [],
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

    vi.useFakeTimers();
    try {
      for (const ch of ['H', 'e', 'l', 'l', 'o']) {
        host.broadcast({ type: 'item.delta', threadId: 'tC', itemId: 'i1', delta: { text: ch } });
      }
      await vi.advanceTimersByTimeAsync(16);

      const deltas = events.filter((e) => e.type === 'item.delta');
      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({ itemId: 'i1', threadId: 'tC', delta: { text: 'Hello' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes buffered deltas before a non-delta event (ordering preserved)', async () => {
    const host = subscribedHost('tC');
    const t = connect(host);
    const events = collect(t);
    init(t, 'tC');
    await flush();

    host.broadcast({
      type: 'item.delta',
      threadId: 'tC',
      itemId: 'i1',
      delta: { text: 'partial' },
    });
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
