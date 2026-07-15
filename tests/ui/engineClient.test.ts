/**
 * EngineSession self-heal: subscribing to a vanished thread (deleted from
 * another surface / stale ?thread= link / replaced DB) must not dead-end on
 * "thread ... not found" — the client resets and creates a fresh thread.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { RealEngineCore, type ProviderResolver } from '../../src/engine/core';
import { EngineHost } from '../../src/engine/host';
import { createDirectPair, type EngineTransport } from '../../src/messaging/transport';
import { ENGINE_PROTOCOL, ENGINE_SCHEMA_HASH } from '../../src/messaging/protocol';
import type { AgentEvent, Op, ThreadSnapshot } from '../../src/messaging/protocol';
import { ToolRegistry } from '../../src/agent/tool';
import type { GatekeeperCheck } from '../../src/agent/loop';
import { EngineSession } from '../../src/ui/engineClient';

const allowAll: GatekeeperCheck = { check: async () => ({ verdict: 'allow' }) };

function buildSession() {
  const db = new PanelotDB(`client-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const resolver: ProviderResolver = {
    resolve: async () => {
      throw new Error('no provider needed in this test');
    },
  };
  const core = new RealEngineCore(db, new ToolRegistry(), allowAll, resolver);
  const host = new EngineHost(core);
  core.onBroadcast = (ev) => host.broadcast(ev);

  const { transport, connection } = createDirectPair();
  host.onConnection(connection);
  const session = new EngineSession(() => transport);
  session.start();
  return { session, db };
}

function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EngineSession lifecycle', () => {
  class FakeTransport implements EngineTransport {
    sent: Op[] = [];
    close = vi.fn();
    private eventHandler: (event: AgentEvent) => void = () => {};
    private disconnectHandler: () => void = () => {};
    send(op: Op): void {
      this.sent.push(op);
    }
    onEvent(handler: (event: AgentEvent) => void): () => void {
      this.eventHandler = handler;
      return () => {};
    }
    onDisconnect(handler: () => void): () => void {
      this.disconnectHandler = handler;
      return () => {};
    }
    emit(event: AgentEvent): void {
      this.eventHandler(event);
    }
    disconnect(): void {
      this.disconnectHandler();
    }
  }

  function snapshot(threadId: string, epoch: number, sequence: number): ThreadSnapshot {
    const stream = { threadId, epoch, sequence };
    return {
      stream,
      meta: {
        id: threadId,
        revision: 0,
        title: threadId,
        createdAt: 1,
        updatedAt: 1,
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
  }

  it('keeps construction pure and start/stop idempotent across a StrictMode replay', () => {
    const transports: FakeTransport[] = [];
    const factory = vi.fn(() => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    });
    const session = new EngineSession(factory);

    expect(factory).not.toHaveBeenCalled();
    session.start();
    session.start();
    expect(factory).toHaveBeenCalledTimes(1);

    session.stop();
    session.stop();
    expect(transports[0]!.close).toHaveBeenCalledTimes(1);

    session.start();
    expect(factory).toHaveBeenCalledTimes(2);
    const active = transports[1]!;
    const init = active.sent[0]!;
    transports[0]!.emit({
      type: 'initialized',
      submissionId: 'stale',
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
    });
    expect(session.store.getState().connected).toBe(false);
    active.emit({
      type: 'initialized',
      submissionId: init.submissionId,
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
    });
    expect(session.store.getState().connected).toBe(true);
    session.stop();
  });

  it('rejects a stale cross-thread snapshot and non-increasing stream cursor', () => {
    const transport = new FakeTransport();
    const session = new EngineSession(() => transport);
    session.start();
    try {
      session.openThread('thread-a');
      const subscribeA = transport.sent.find(
        (op) => op.type === 'thread.subscribe' && op.threadId === 'thread-a',
      )!;
      session.openThread('thread-b');
      const subscribeB = transport.sent.find(
        (op) => op.type === 'thread.subscribe' && op.threadId === 'thread-b',
      )!;

      const snapshotA = snapshot('thread-a', 10, 1);
      transport.emit({
        type: 'initialized',
        submissionId: subscribeA.submissionId,
        protocol: ENGINE_PROTOCOL,
        schemaHash: ENGINE_SCHEMA_HASH,
        snapshot: snapshotA,
        stream: snapshotA.stream,
      });
      expect(session.store.getState()).toMatchObject({
        threadId: 'thread-b',
        meta: null,
        loading: true,
      });

      const snapshotB = snapshot('thread-b', 10, 5);
      transport.emit({
        type: 'initialized',
        submissionId: subscribeB.submissionId,
        protocol: ENGINE_PROTOCOL,
        schemaHash: ENGINE_SCHEMA_HASH,
        snapshot: snapshotB,
        stream: snapshotB.stream,
      });
      expect(session.store.getState().meta?.title).toBe('thread-b');

      transport.emit({
        type: 'thread.updated',
        threadId: 'thread-b',
        revision: 9,
        patch: { title: 'stale update' },
        stream: { threadId: 'thread-b', epoch: 10, sequence: 4 },
      });
      expect(session.store.getState().meta?.title).toBe('thread-b');

      transport.emit({
        type: 'thread.updated',
        threadId: 'thread-b',
        revision: 1,
        patch: { title: 'new worker update' },
        stream: { threadId: 'thread-b', epoch: 11, sequence: 1 },
      });
      expect(session.store.getState().meta?.title).toBe('new worker update');
    } finally {
      session.stop();
    }
  });

  it('retains provider stop semantics from the event and the persisted assistant snapshot', () => {
    const transport = new FakeTransport();
    const session = new EngineSession(() => transport);
    session.start();
    try {
      session.openThread('thread-a');
      const subscribe = transport.sent.find(
        (op) => op.type === 'thread.subscribe' && op.threadId === 'thread-a',
      )!;
      const initial = snapshot('thread-a', 20, 1);
      transport.emit({
        type: 'initialized',
        submissionId: subscribe.submissionId,
        protocol: ENGINE_PROTOCOL,
        schemaHash: ENGINE_SCHEMA_HASH,
        snapshot: initial,
        stream: initial.stream,
      });
      transport.emit({
        type: 'turn.start',
        threadId: 'thread-a',
        turnId: 'turn-a',
        turnKind: 'user',
        steerable: true,
        stream: { threadId: 'thread-a', epoch: 20, sequence: 2 },
      });
      transport.emit({
        type: 'turn.complete',
        threadId: 'thread-a',
        turnId: 'turn-a',
        stopReason: 'max_tokens',
        stream: { threadId: 'thread-a', epoch: 20, sequence: 3 },
      });
      expect(session.store.getState().lastStopReason).toBe('max_tokens');

      const refresh = transport.sent
        .filter((op) => op.type === 'thread.subscribe' && op.threadId === 'thread-a')
        .at(-1)!;
      const persisted = snapshot('thread-a', 20, 4);
      persisted.items = [
        {
          nodeId: 'assistant-a',
          kind: 'assistant_message',
          ts: 1,
          payload: {
            content: [{ type: 'text', text: 'partial' }],
            model: 'mock',
            connectionId: 'connection',
            providerStopReason: 'max_tokens',
          },
        },
      ];
      session.store.setState({ lastStopReason: null });
      transport.emit({
        type: 'initialized',
        submissionId: refresh.submissionId,
        protocol: ENGINE_PROTOCOL,
        schemaHash: ENGINE_SCHEMA_HASH,
        snapshot: persisted,
        stream: persisted.stream,
      });

      expect(session.store.getState().lastStopReason).toBe('max_tokens');
    } finally {
      session.stop();
    }
  });

  it('does not connect when session restore completes after stop', async () => {
    let resolveGet!: (value: Record<string, unknown>) => void;
    const pendingGet = new Promise<Record<string, unknown>>((resolve) => {
      resolveGet = resolve;
    });
    vi.stubGlobal('chrome', {
      storage: {
        session: {
          get: vi.fn(() => pendingGet),
          set: vi.fn(async () => {}),
        },
      },
    });
    const factory = vi.fn(() => new FakeTransport());
    const session = new EngineSession(factory);

    session.start();
    session.stop();
    resolveGet({});
    await pendingGet;
    await Promise.resolve();

    expect(factory).not.toHaveBeenCalled();
  });

  it('cancels a scheduled reconnect when stopped', async () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const session = new EngineSession(() => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    });
    session.start();
    transports[0]!.disconnect();
    session.stop();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(transports).toHaveLength(1);
    vi.useRealTimers();
  });

  it('blocks reconnect when an older protocol receives the stable fatal envelope', async () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const factory = vi.fn(() => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    });
    const session = new EngineSession(factory);
    session.start();
    try {
      const transport = transports[0]!;
      transport.emit({
        type: 'fatal.reload_required',
        submissionId: transport.sent[0]!.submissionId,
        protocol: 'panelot/engine-v0',
        schemaHash: 'future-schema',
        message: 'Reload required.',
      });
      transport.disconnect();
      await vi.advanceTimersByTimeAsync(10_000);

      expect(session.store.getState()).toMatchObject({
        connected: false,
        reloadRequired: true,
        lastError: { message: 'Reload required.', retryable: false, kind: 'protocol' },
      });
      expect(transport.close).toHaveBeenCalledOnce();
      expect(factory).toHaveBeenCalledOnce();
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });

  it('rejects a branch selection resolved for a thread that is no longer active', () => {
    const transport = new FakeTransport();
    const session = new EngineSession(() => transport);
    session.start();
    session.store.setState({ threadId: 'thread-b' });
    transport.sent.length = 0;

    expect(session.selectBranch('thread-a', 'a-2')).toBe(false);
    expect(transport.sent).toEqual([]);
    session.stop();
  });

  it('surfaces maintenance admission rejection in the session shared by Chat and Side Panel', () => {
    const transport = new FakeTransport();
    const session = new EngineSession(() => transport);
    session.start();
    try {
      const initialization = transport.sent[0]!;
      transport.emit({
        type: 'initialized',
        submissionId: initialization.submissionId,
        protocol: ENGINE_PROTOCOL,
        schemaHash: ENGINE_SCHEMA_HASH,
      });
      session.submit({ text: 'continue' });
      const creation = transport.sent.find((op) => op.type === 'thread.create')!;
      transport.emit({
        type: 'thread.created',
        submissionId: creation.submissionId,
        threadId: 'maintenance-thread',
      });
      const submission = transport.sent.find((op) => op.type === 'turn.submit')!;

      transport.emit({
        type: 'command.rejected',
        submissionId: submission.submissionId,
        code: 'overloaded',
        message: 'Data maintenance is in progress. Reload the extension before retrying.',
      });

      expect(session.store.getState().lastError).toEqual({
        message: 'Data maintenance is in progress. Reload the extension before retrying.',
        retryable: true,
      });
    } finally {
      session.stop();
    }
  });
});

describe('EngineSession self-heal on thread_not_found', () => {
  it('openThread(missing id) recovers by falling back to a draft', async () => {
    const { session } = buildSession();
    try {
      await waitFor(() => session.store.getState().connected);

      session.openThread('e08546b3-3562-43b9-b449-086380244e42');
      await waitFor(() => {
        const s = session.store.getState();
        return s.threadId === null && s.lastError === null && s.connected;
      });
    } finally {
      session.dispose();
    }
  });

  it('draft submit materializes the thread and delivers the first message', async () => {
    const { session, db } = buildSession();
    try {
      await waitFor(() => session.store.getState().connected);
      session.startDraft();
      expect(session.store.getState().threadId).toBeNull();
      expect(await db.threads.count()).toBe(0); // draft persists nothing

      session.submit({ text: 'first message' });
      // thread.created → subscribe → submit; the turn errors (no provider in
      // this harness) but the thread row now exists.
      await waitFor(() => session.store.getState().threadId !== null);
      expect(await db.threads.count()).toBe(1);
    } finally {
      session.dispose();
    }
  });

  it('clears the previous thread permission override when starting a new draft', () => {
    const { session } = buildSession();
    try {
      session.setOverrides({
        permissionPolicy: 'always',
        enabledToolLevels: ['L0', 'L1'],
      });
      session.startDraft();
      expect(session.store.getState().pendingOverrides).toEqual({
        enabledToolLevels: ['L0', 'L1'],
      });
    } finally {
      session.dispose();
    }
  });
});

describe('optimistic user echo (ChatGPT semantics)', () => {
  it('the message is visible synchronously on submit, before any engine event', () => {
    const { session } = buildSession();
    try {
      session.submit({ text: 'hello there' });
      // No await: the echo must be in the store the instant submit returns.
      const live = session.store.getState().liveItems;
      expect(
        live.some((it) => it.kind === 'user_message' && it.local && it.text === 'hello there'),
      ).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it('survives the draft→thread transition and reconciles once persisted', async () => {
    const { session } = buildSession();
    try {
      await waitFor(() => session.store.getState().connected);
      session.startDraft();
      session.submit({ text: 'persist me' });
      // Echo present throughout materialization (no blink-out window).
      expect(session.store.getState().liveItems.some((it) => it.local)).toBe(true);
      await waitFor(() => session.store.getState().threadId !== null);
      // After the persisted user_message lands in a snapshot, exactly one
      // rendering of the message remains (persisted item, echo gone).
      await waitFor(() => {
        const s = session.store.getState();
        const persisted = s.items.filter((i) => i.kind === 'user_message').length;
        const echoes = s.liveItems.filter((it) => it.kind === 'user_message').length;
        return persisted + echoes === 1;
      });
    } finally {
      session.dispose();
    }
  });

  it('two real sends of the same text show two bubbles; a retry does not add one', () => {
    const { session } = buildSession();
    try {
      // Two genuine submits (e.g. "继续" twice) are two messages.
      session.submit({ text: 'same text' });
      session.submit({ text: 'same text' });
      expect(session.store.getState().liveItems.filter((it) => it.local)).toHaveLength(2);

      // A retry re-submits lastInput — its bubble already exists.
      session.store.setState({
        lastError: { message: 'x', retryable: true },
        lastInput: { text: 'same text' },
      });
      session.retryLast();
      expect(session.store.getState().liveItems.filter((it) => it.local)).toHaveLength(2);
    } finally {
      session.dispose();
    }
  });
});

describe('thread.updated before snapshot (title race)', () => {
  it('a title patch arriving while meta is null is applied over the eventual snapshot', async () => {
    const { session, db } = buildSession();
    try {
      await waitFor(() => session.store.getState().connected);
      session.startDraft();
      session.submit({ text: 'title me' });
      await waitFor(() => session.store.getState().threadId !== null);
      const threadId = session.store.getState().threadId!;
      await waitFor(() => session.store.getState().meta !== null);
      // Engine-side title write broadcast (what generateTitle does).
      await db.threads.update(threadId, { title: '生成的标题' });
      // Simulate the broadcast arriving through the transport by re-opening:
      // the snapshot path must carry the persisted title.
      session.openThread(threadId);
      await waitFor(() => session.store.getState().meta?.title === '生成的标题');
    } finally {
      session.dispose();
    }
  });
});

describe('session outbox', () => {
  it('resends the same submission id after a disconnect until acked', async () => {
    vi.useFakeTimers();
    class FakeTransport implements EngineTransport {
      sent: Op[] = [];
      private eventHandler: (event: AgentEvent) => void = () => {};
      private disconnectHandler: () => void = () => {};
      send(op: Op): void {
        this.sent.push(op);
      }
      onEvent(handler: (event: AgentEvent) => void): () => void {
        this.eventHandler = handler;
        return () => {};
      }
      onDisconnect(handler: () => void): () => void {
        this.disconnectHandler = handler;
        return () => {};
      }
      close(): void {}
      emit(event: AgentEvent): void {
        this.eventHandler(event);
      }
      disconnect(): void {
        this.disconnectHandler();
      }
    }

    const transports: FakeTransport[] = [];
    const session = new EngineSession(() => {
      const transport = new FakeTransport();
      transports.push(transport);
      return transport;
    });
    session.start();
    try {
      const first = transports[0]!;
      const init = first.sent[0]!;
      first.emit({
        type: 'initialized',
        submissionId: init.submissionId,
        protocol: ENGINE_PROTOCOL,
        schemaHash: ENGINE_SCHEMA_HASH,
      });
      first.emit({
        type: 'error',
        code: 'provider_error',
        message: 'unexpected HTTP 404',
        retryable: false,
        errorKind: 'protocol',
        providerDetails: { status: 404, reason: 'endpoint_not_found' },
      });
      expect(session.store.getState().lastError).toMatchObject({
        kind: 'protocol',
        details: { status: 404, reason: 'endpoint_not_found' },
      });
      session.createThread();
      const original = first.sent.find((op) => op.type === 'thread.create')!;

      first.disconnect();
      await vi.advanceTimersByTimeAsync(500);
      const second = transports[1]!;
      const reconnectInit = second.sent[0]!;
      second.emit({
        type: 'initialized',
        submissionId: reconnectInit.submissionId,
        protocol: ENGINE_PROTOCOL,
        schemaHash: ENGINE_SCHEMA_HASH,
      });

      const replay = second.sent.find((op) => op.type === 'thread.create');
      expect(replay?.submissionId).toBe(original.submissionId);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  });
});
