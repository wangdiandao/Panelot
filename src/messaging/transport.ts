/**
 * Transport abstraction (docs/04 §7).
 *
 * The UI talks to the engine exclusively through `EngineTransport`;
 * the engine accepts clients exclusively through `EngineConnection`.
 * Production wires these over a chrome.runtime Port; tests wire them
 * directly in-process — neither side can tell the difference.
 */

import type { AgentEvent, Op } from './protocol';
import { parseAgentEvent } from './agentEventValidation';
import { ENGINE_PORT_NAME, type EngineConnection } from './engineConnection';

export {
  ENGINE_PORT_NAME,
  wrapBufferedPortConnection,
  wrapPortConnection,
} from './engineConnection';
export type { ConnectionHandler, EngineConnection } from './engineConnection';

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

/**
 * Decode an untrusted background message at the UI boundary. New event names
 * are ignored for rolling extension updates; malformed payloads for event
 * names this UI understands remain visible as protocol errors.
 */
export function decodeAgentEvent(message: unknown): AgentEvent | undefined {
  const parsed = parseAgentEvent(message);
  if (parsed.ok) return parsed.value;
  if (parsed.kind === 'unsupported') return undefined;
  return {
    type: 'error',
    code: 'protocol_mismatch',
    message: `Malformed engine event: ${parsed.diagnostic}`,
    retryable: false,
    submissionId: parsed.submissionId,
  };
}

// ---------------------------------------------------------------------------
// DirectTransport — in-process pair for tests (no chrome APIs)
// ---------------------------------------------------------------------------

export function createDirectPair(): { transport: EngineTransport; connection: EngineConnection } {
  let opHandler: ((op: unknown) => void) | null = null;
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
        const event = decodeAgentEvent(ev);
        if (!event) return;
        for (const cb of eventSubs) cb(event);
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

export function createPortTransport(): EngineTransport {
  const port = chrome.runtime.connect({ name: ENGINE_PORT_NAME });
  const eventSubs = new Set<(ev: AgentEvent) => void>();
  const disconnectSubs = new Set<() => void>();

  port.onMessage.addListener((msg) => {
    const event = decodeAgentEvent(msg);
    if (!event) return;
    for (const cb of eventSubs) cb(event);
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
