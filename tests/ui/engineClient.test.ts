/**
 * EngineSession self-heal: subscribing to a vanished thread (deleted from
 * another surface / stale ?thread= link / replaced DB) must not dead-end on
 * "thread ... not found" — the client resets and creates a fresh thread.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { RealEngineCore, type ProviderResolver } from '../../src/engine/core';
import { EngineHost } from '../../src/engine/host';
import { createDirectPair } from '../../src/messaging/transport';
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
