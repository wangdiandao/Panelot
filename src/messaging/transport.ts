/**
 * Transport abstraction (docs/04 §7).
 *
 * The UI talks to the engine exclusively through `EngineTransport`;
 * the engine accepts clients exclusively through `EngineConnection`.
 * Production wires these over a chrome.runtime Port; tests wire them
 * directly in-process — neither side can tell the difference.
 */

import type { AgentEvent, Op } from './protocol';

// ---------------------------------------------------------------------------
// Client side
// ---------------------------------------------------------------------------

export interface EngineTransport {
  send(op: Op): void;
  /** Returns an unsubscribe function. */
  onEvent(cb: (ev: AgentEvent) => void): () => void;
  /** Fired when the underlying channel drops (SW killed). Client should reconnect. */
  onDisconnect(cb: () => void): () => void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Engine side
// ---------------------------------------------------------------------------

/** One connected client, as seen by the engine. */
export interface EngineConnection {
  post(ev: AgentEvent): void;
  onOp(cb: (op: Op) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/** The engine implements this; transports call it for each new client. */
export type ConnectionHandler = (conn: EngineConnection) => void;

// ---------------------------------------------------------------------------
// DirectTransport — in-process pair for tests (no chrome APIs)
// ---------------------------------------------------------------------------

export function createDirectPair(): { transport: EngineTransport; connection: EngineConnection } {
  let opHandler: ((op: Op) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  const eventSubs = new Set<(ev: AgentEvent) => void>();
  const disconnectSubs = new Set<() => void>();
  let closed = false;

  const transport: EngineTransport = {
    send(op) {
      if (closed) throw new Error('transport closed');
      // Defer like a real message channel so senders never re-enter handlers.
      queueMicrotask(() => opHandler?.(op));
    },
    onEvent(cb) {
      eventSubs.add(cb);
      return () => eventSubs.delete(cb);
    },
    onDisconnect(cb) {
      disconnectSubs.add(cb);
      return () => disconnectSubs.delete(cb);
    },
    close() {
      if (closed) return;
      closed = true;
      queueMicrotask(() => {
        closeHandler?.();
        for (const cb of disconnectSubs) cb();
      });
    },
  };

  const connection: EngineConnection = {
    post(ev) {
      if (closed) return;
      queueMicrotask(() => {
        for (const cb of eventSubs) cb(ev);
      });
    },
    onOp(cb) {
      opHandler = cb;
    },
    onClose(cb) {
      closeHandler = cb;
    },
    close() {
      transport.close();
    },
  };

  return { transport, connection };
}

// ---------------------------------------------------------------------------
// PortTransport — production client over chrome.runtime.connect
// ---------------------------------------------------------------------------

export const ENGINE_PORT_NAME = 'panelot-engine';

export function createPortTransport(): EngineTransport {
  const port = chrome.runtime.connect({ name: ENGINE_PORT_NAME });
  const eventSubs = new Set<(ev: AgentEvent) => void>();
  const disconnectSubs = new Set<() => void>();

  port.onMessage.addListener((msg) => {
    for (const cb of eventSubs) cb(msg as AgentEvent);
  });
  port.onDisconnect.addListener(() => {
    for (const cb of disconnectSubs) cb();
  });

  return {
    send(op) {
      port.postMessage(op);
    },
    onEvent(cb) {
      eventSubs.add(cb);
      return () => eventSubs.delete(cb);
    },
    onDisconnect(cb) {
      disconnectSubs.add(cb);
      return () => disconnectSubs.delete(cb);
    },
    close() {
      port.disconnect();
    },
  };
}

/** Engine-side wrapper for an incoming chrome.runtime Port. */
export function wrapPortConnection(port: chrome.runtime.Port): EngineConnection {
  return {
    post(ev) {
      try {
        port.postMessage(ev);
      } catch {
        // Port already gone; onDisconnect will fire.
      }
    },
    onOp(cb) {
      port.onMessage.addListener((msg) => cb(msg as Op));
    },
    onClose(cb) {
      port.onDisconnect.addListener(() => cb());
    },
    close() {
      port.disconnect();
    },
  };
}
