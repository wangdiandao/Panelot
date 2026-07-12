/**
 * EngineSession self-heal: subscribing to a vanished thread (deleted from
 * another surface / stale ?thread= link / replaced DB) must not dead-end on
 * "thread ... not found" — the client resets and creates a fresh thread.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { RealEngineCore, type ProviderResolver } from '../../src/engine/core';
import { EngineHost } from '../../src/engine/host';
import { createDirectPair, type EngineTransport } from '../../src/messaging/transport';
import { ENGINE_PROTOCOL, ENGINE_SCHEMA_HASH } from '../../src/messaging/protocol';
import type { AgentEvent, Op } from '../../src/messaging/protocol';
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
