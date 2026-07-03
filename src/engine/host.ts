/**
 * EngineHost — connection management, handshake, bounded op queues (docs/01 §3).
 *
 * This is the transport-facing shell of the engine. It owns:
 *  - client connections and per-thread subscription fan-out
 *  - the initialize handshake (protocol version + snapshot)
 *  - per-thread bounded Op queues with `overloaded` backpressure
 *  - 16ms delta coalescing before postMessage (docs/01 §3.5)
 *
 * The actual agent behavior lives behind `EngineCore` (Phase 4); Phase 1
 * ships a stub so the shell is fully testable now.
 */

import { PROTOCOL_VERSION, isOp } from '../messaging/protocol';
import type { AgentEvent, Op, ThreadSnapshot } from '../messaging/protocol';
import type { ConnectionHandler, EngineConnection } from '../messaging/transport';

/** Engine business logic consumed by the host. Implemented fully in Phase 4. */
export interface EngineCore {
  /** Handle one Op. Emit events via the provided sink; return when accepted. */
  handleOp(op: Op, emit: (ev: AgentEvent) => void): Promise<void>;
  /** Build a reconnect snapshot for a thread, or null if it doesn't exist. */
  getSnapshot(threadId: string): Promise<ThreadSnapshot | null>;
  /** Which thread an Op belongs to (for queue partitioning); null = global. */
  threadIdOf(op: Op): string | null;
}

const QUEUE_CAPACITY = 32; // docs/01 §3.5
const DELTA_COALESCE_MS = 16;

interface Client {
  conn: EngineConnection;
  subscribedThreadId: string | null;
  initialized: boolean;
  /** Coalescing buffer: itemId → accumulated text/reasoning deltas. */
  pendingDeltas: Map<string, { text: string; reasoning: string }>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

interface QueuedOp {
  op: Op;
  from: Client;
}

interface OpQueue {
  ops: QueuedOp[];
  running: boolean;
}

export class EngineHost {
  private clients = new Set<Client>();
  /** One serialized queue per thread ('' = global ops). */
  private queues = new Map<string, OpQueue>();

  constructor(private core: EngineCore) {}

  /** Attach as ConnectionHandler on a transport acceptor. */
  readonly onConnection: ConnectionHandler = (conn) => {
    const client: Client = {
      conn,
      subscribedThreadId: null,
      initialized: false,
      pendingDeltas: new Map(),
      flushTimer: null,
    };
    this.clients.add(client);
    conn.onOp((op) => this.receive(client, op));
    conn.onClose(() => {
      if (client.flushTimer !== null) clearTimeout(client.flushTimer);
      this.clients.delete(client);
    });
  };

  /** Broadcast an event to every client subscribed to the thread (or all, for global). */
  broadcast(ev: AgentEvent): void {
    const threadId = 'threadId' in ev ? (ev as { threadId?: string }).threadId : undefined;
    for (const client of this.clients) {
      if (!client.initialized) continue;
      if (threadId && client.subscribedThreadId !== threadId) continue;
      this.postToClient(client, ev);
    }
  }

  // -------------------------------------------------------------------------

  private receive(client: Client, raw: unknown): void {
    if (!isOp(raw)) {
      client.conn.post({
        type: 'error',
        code: 'internal',
        message: 'malformed Op',
        retryable: false,
      });
      return;
    }
    const op = raw;

    // Handshake and ping bypass the queue — they must answer even under load.
    if (op.type === 'initialize') {
      void this.handleInitialize(client, op);
      return;
    }
    if (op.type === 'ping') {
      client.conn.post({ type: 'pong', submissionId: op.submissionId });
      return;
    }
    if (!client.initialized) {
      client.conn.post({
        type: 'error',
        submissionId: op.submissionId,
        code: 'internal',
        message: 'initialize first',
        retryable: true,
      });
      return;
    }

    if (op.type === 'thread.subscribe') {
      void this.handleSubscribe(client, op);
      return;
    }

    this.enqueue(client, op);
  }

  private async handleInitialize(
    client: Client,
    op: Extract<Op, { type: 'initialize' }>,
  ): Promise<void> {
    client.initialized = true;
    // V1 policy (docs/01 §6): version mismatch warns, does not block.
    let snapshot: ThreadSnapshot | undefined;
    if (op.subscribe) {
      const snap = await this.core.getSnapshot(op.subscribe.threadId);
      if (snap) {
        client.subscribedThreadId = op.subscribe.threadId;
        snapshot = snap;
      }
    }
    client.conn.post({
      type: 'initialized',
      submissionId: op.submissionId,
      protocolVersion: PROTOCOL_VERSION,
      snapshot,
    });
  }

  private async handleSubscribe(
    client: Client,
    op: Extract<Op, { type: 'thread.subscribe' }>,
  ): Promise<void> {
    const snap = await this.core.getSnapshot(op.threadId);
    if (!snap) {
      client.conn.post({
        type: 'error',
        submissionId: op.submissionId,
        code: 'thread_not_found',
        message: `thread ${op.threadId} not found`,
        retryable: false,
      });
      return;
    }
    client.subscribedThreadId = op.threadId;
    client.conn.post({
      type: 'initialized',
      submissionId: op.submissionId,
      protocolVersion: PROTOCOL_VERSION,
      snapshot: snap,
    });
  }

  private enqueue(client: Client, op: Op): void {
    const key = this.core.threadIdOf(op) ?? '';
    let queue = this.queues.get(key);
    if (!queue) {
      queue = { ops: [], running: false };
      this.queues.set(key, queue);
    }
    if (queue.ops.length >= QUEUE_CAPACITY) {
      client.conn.post({ type: 'overloaded', submissionId: op.submissionId });
      return;
    }
    queue.ops.push({ op, from: client });
    void this.drain(key, queue);
  }

  private async drain(key: string, queue: OpQueue): Promise<void> {
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.ops.length > 0) {
        const { op, from } = queue.ops.shift()!;
        try {
          await this.core.handleOp(op, (ev) => this.emit(ev, from));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.postToClient(from, {
            type: 'error',
            submissionId: op.submissionId,
            code: 'internal',
            message,
            retryable: false,
          });
        }
      }
    } finally {
      queue.running = false;
      if (queue.ops.length === 0) this.queues.delete(key);
    }
  }

  /**
   * Route a core-emitted event: events echoing a submissionId are responses
   * and go to the originating client (which may not be subscribed yet, e.g.
   * thread.created); everything else fans out by thread subscription.
   */
  private emit(ev: AgentEvent, from: Client): void {
    if ('submissionId' in ev && ev.submissionId !== undefined) {
      if (this.clients.has(from)) this.postToClient(from, ev);
      return;
    }
    this.broadcast(ev);
  }

  // ---- delta coalescing (docs/01 §3.5) --------------------------------------

  private postToClient(client: Client, ev: AgentEvent): void {
    if (ev.type === 'item.delta' && (ev.delta.text !== undefined || ev.delta.reasoning !== undefined)) {
      const buf = client.pendingDeltas.get(ev.itemId) ?? { text: '', reasoning: '' };
      buf.text += ev.delta.text ?? '';
      buf.reasoning += ev.delta.reasoning ?? '';
      client.pendingDeltas.set(ev.itemId, buf);
      if (client.flushTimer === null) {
        client.flushTimer = setTimeout(() => this.flushDeltas(client), DELTA_COALESCE_MS);
      }
      return;
    }
    // Non-coalescable events must not overtake buffered deltas for the same items.
    this.flushDeltas(client);
    client.conn.post(ev);
  }

  private flushDeltas(client: Client): void {
    if (client.flushTimer !== null) {
      clearTimeout(client.flushTimer);
      client.flushTimer = null;
    }
    for (const [itemId, buf] of client.pendingDeltas) {
      const delta: { text?: string; reasoning?: string } = {};
      if (buf.text) delta.text = buf.text;
      if (buf.reasoning) delta.reasoning = buf.reasoning;
      client.conn.post({ type: 'item.delta', itemId, delta });
    }
    client.pendingDeltas.clear();
  }
}

/** Phase-1 stub core: knows no threads, accepts nothing. Replaced in Phase 4. */
export class StubEngineCore implements EngineCore {
  async handleOp(op: Op, emit: (ev: AgentEvent) => void): Promise<void> {
    emit({
      type: 'error',
      submissionId: op.submissionId,
      code: 'not_configured',
      message: 'engine core not implemented yet',
      retryable: false,
    });
  }
  async getSnapshot(): Promise<ThreadSnapshot | null> {
    return null;
  }
  threadIdOf(op: Op): string | null {
    return 'threadId' in op ? (op as { threadId: string }).threadId : null;
  }
}
