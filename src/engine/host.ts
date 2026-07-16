/**
 * EngineHost — connection management, handshake, bounded op queues (docs/01 §3).
 *
 * This is the transport-facing shell of the engine. It owns:
 *  - client connections and per-thread subscription fan-out
 *  - the initialize handshake (protocol version + snapshot)
 *  - per-thread bounded Op queues with explicit rejection backpressure
 *  - 16ms delta coalescing before postMessage (docs/01 §3.5)
 *
 * The actual agent behavior lives behind `EngineCore`, so the shell is
 * testable in isolation with a stub core.
 */

import { ENGINE_PROTOCOL, ENGINE_SCHEMA_HASH } from '../messaging/protocol';
import type { AgentEvent, Op, ThreadSnapshot, ThreadStreamCursor } from '../messaging/protocol';
import type { ConnectionHandler, EngineConnection } from '../messaging/transport';
import { parseOp } from '../messaging/validation';

/** Engine business logic consumed by the host. */
export interface EngineCore {
  /** Handle one Op. Emit events via the provided sink; return when accepted. */
  handleOp(op: Op, emit: (ev: AgentEvent) => void): Promise<void>;
  /** Build a reconnect snapshot for a thread, or null if it doesn't exist. */
  getSnapshot(threadId: string): Promise<ThreadSnapshot | null>;
  /** Which thread an Op belongs to (for queue partitioning); null = global. */
  threadIdOf(op: Op): string | null;
  /** Runtime work that must drain before destructive data maintenance starts. */
  waitForAdmissionIdle?(): Promise<void>;
  /** Threads whose runtime work has not reached a durable terminal state. */
  activeThreadIds?(): readonly string[];
}

const QUEUE_CAPACITY = 32; // docs/01 §3.5
const DELTA_COALESCE_MS = 16;
const STARTUP_RECOVERY_TIMEOUT_MS = 30_000;

export interface EngineHostOptions {
  startupRecoveryTimeoutMs?: number;
  /** Monotonic identity for this background worker, normally allocated from storage.session. */
  streamEpoch?: number | Promise<number>;
  /** Fail closed while a destructive maintenance operation owns admission. */
  isAdmissionBlocked?: () => boolean;
}

const STREAM_EPOCH_STORAGE_KEY = 'panelot_engine_stream_epoch';

type EpochStorageArea = Pick<chrome.storage.StorageArea, 'get' | 'set'>;

export async function allocateEngineStreamEpoch(
  area: EpochStorageArea = chrome.storage.session,
): Promise<number> {
  const stored = await area.get(STREAM_EPOCH_STORAGE_KEY);
  const previous = stored[STREAM_EPOCH_STORAGE_KEY];
  const epoch =
    typeof previous === 'number' && Number.isSafeInteger(previous) && previous > 0
      ? previous + 1
      : 1;
  await area.set({ [STREAM_EPOCH_STORAGE_KEY]: epoch });
  return epoch;
}

class StartupRecoveryError extends Error {
  constructor(
    readonly reason: 'failed' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'StartupRecoveryError';
  }
}

interface Client {
  conn: EngineConnection;
  subscribedThreadId: string | null;
  initialized: boolean;
  clientId: string | null;
  startupFailed: boolean;
  inputTail: Promise<void>;
  /** Coalescing buffer: itemId → accumulated text/reasoning deltas. */
  pendingDeltas: Map<
    string,
    { threadId: string; text: string; reasoning: string; stream: ThreadStreamCursor }
  >;
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
  #clients = new Set<Client>();
  /** One serialized queue per thread ('' = global ops). */
  #queues = new Map<string, OpQueue>();
  #idleWaiters = new Set<() => void>();
  #threadSequences = new Map<string, number>();
  #streamEpoch = 1;
  #isAdmissionBlocked: () => boolean;
  #core: EngineCore;

  #ready: Promise<void>;

  constructor(
    core: EngineCore,
    ready: Promise<void> = Promise.resolve(),
    options: EngineHostOptions = {},
  ) {
    this.#core = core;
    this.#isAdmissionBlocked = options.isAdmissionBlocked ?? (() => false);
    const timeoutMs = options.startupRecoveryTimeoutMs ?? STARTUP_RECOVERY_TIMEOUT_MS;
    const startup = Promise.all([
      ready,
      Promise.resolve(options.streamEpoch ?? 1).then((epoch) => {
        if (!Number.isSafeInteger(epoch) || epoch <= 0) {
          throw new Error('Engine stream epoch must be a positive safe integer.');
        }
        this.#streamEpoch = epoch;
      }),
    ]).then(() => undefined);
    this.#ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new StartupRecoveryError(
              'timeout',
              'Background recovery did not finish before the startup deadline.',
            ),
          ),
        timeoutMs,
      );
      void startup.then(
        () => {
          clearTimeout(timeout);
          resolve();
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(
            new StartupRecoveryError(
              'failed',
              `Background recovery failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        },
      );
    });
    void this.#ready.catch(() => undefined);
  }

  activeThreadIds(): string[] {
    const ids = new Set(this.#core.activeThreadIds?.() ?? []);
    for (const [threadId, queue] of this.#queues) {
      if (threadId && (queue.running || queue.ops.length > 0)) ids.add(threadId);
    }
    return [...ids];
  }

  async waitForAdmissionIdle(): Promise<void> {
    while (true) {
      if (this.#queues.size > 0) {
        await new Promise<void>((resolve) => this.#idleWaiters.add(resolve));
      }
      await this.#core.waitForAdmissionIdle?.();
      if (this.#queues.size === 0) return;
    }
  }

  /** Attach as ConnectionHandler on a transport acceptor. */
  readonly onConnection: ConnectionHandler = (conn) => {
    const client: Client = {
      conn,
      subscribedThreadId: null,
      initialized: false,
      clientId: null,
      startupFailed: false,
      inputTail: Promise.resolve(),
      pendingDeltas: new Map(),
      flushTimer: null,
    };
    this.#clients.add(client);
    void this.#ready.catch((error: unknown) => this.#failStartup(client, error));
    conn.onOp((op) => {
      client.inputTail = client.inputTail
        .then(async () => {
          await this.#ready;
          if (this.#clients.has(client)) await this.#receive(client, op);
        })
        .catch((error: unknown) => this.#failStartup(client, error, op));
    });
    conn.onClose(() => {
      if (client.flushTimer !== null) clearTimeout(client.flushTimer);
      this.#clients.delete(client);
    });
  };

  #failStartup(client: Client, error: unknown, op?: unknown): void {
    if (!this.#clients.has(client) || client.startupFailed) return;
    client.startupFailed = true;
    const failure =
      error instanceof StartupRecoveryError
        ? error
        : new StartupRecoveryError(
            'failed',
            `Background recovery failed: ${error instanceof Error ? error.message : String(error)}`,
          );
    const submissionId =
      typeof op === 'object' && op !== null && 'submissionId' in op
        ? String(op.submissionId)
        : undefined;
    client.conn.post({
      type: 'fatal.reload_required',
      submissionId: submissionId ?? crypto.randomUUID(),
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
      message:
        failure.reason === 'timeout'
          ? `${failure.message} Reload the extension before reconnecting.`
          : `${failure.message} Reload the extension to start a fresh background worker.`,
    });
    queueMicrotask(() => client.conn.close());
  }

  /** Broadcast an event to every client subscribed to the thread (or all, for global). */
  broadcast(ev: AgentEvent): void {
    const stamped = this.#stampThreadEvent(ev);
    const threadId = 'threadId' in stamped ? stamped.threadId : undefined;
    for (const client of this.#clients) {
      if (!client.initialized) continue;
      if (threadId && client.subscribedThreadId !== threadId) continue;
      this.#postToClient(client, stamped);
    }
  }

  // -------------------------------------------------------------------------

  async #receive(client: Client, raw: unknown): Promise<void> {
    const parsed = parseOp(raw);
    if (!parsed.ok) {
      if (parsed.submissionId) {
        client.conn.post({
          type: 'command.rejected',
          submissionId: parsed.submissionId,
          code: 'invalid_command',
          message: `Malformed engine command: ${parsed.diagnostic}`,
        });
      } else {
        client.conn.post({
          type: 'error',
          code: 'invalid_command',
          message: `Malformed engine command: ${parsed.diagnostic}`,
          retryable: false,
        });
      }
      return;
    }
    const op = parsed.value;

    // Handshake and ping bypass the queue — they must answer even under load.
    if (op.type === 'initialize') {
      await this.#handleInitialize(client, op);
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
      await this.#handleSubscribe(client, op);
      return;
    }

    if (this.#isAdmissionBlocked()) {
      client.conn.post({
        type: 'command.rejected',
        submissionId: op.submissionId,
        code: 'overloaded',
        message: 'Data maintenance is in progress. Reload the extension before retrying.',
      });
      return;
    }

    this.#enqueue(client, op);
  }

  async #handleInitialize(client: Client, op: Extract<Op, { type: 'initialize' }>): Promise<void> {
    if (
      op.protocol !== ENGINE_PROTOCOL ||
      op.schemaHash !== ENGINE_SCHEMA_HASH ||
      typeof op.clientId !== 'string' ||
      op.clientId.length === 0
    ) {
      client.conn.post({
        type: 'fatal.reload_required',
        submissionId: op.submissionId,
        // Echo the requesting protocol so an older UI can parse this minimal
        // control envelope and stop reconnecting instead of discarding it.
        protocol:
          typeof op.protocol === 'string' && op.protocol.length > 0 ? op.protocol : ENGINE_PROTOCOL,
        schemaHash: ENGINE_SCHEMA_HASH,
        message:
          'The extension UI and background engine use different protocol schemas. Reload required.',
      });
      queueMicrotask(() => client.conn.close());
      return;
    }
    client.initialized = true;
    client.clientId = op.clientId;
    let snapshot: ThreadSnapshot | undefined;
    if (op.subscribe) {
      // Subscribe BEFORE the async snapshot build: events broadcast while
      // getSnapshot awaits IndexedDB (turn.start, live items, thread.updated)
      // must reach this client, not be dropped as "not subscribed".
      client.subscribedThreadId = op.subscribe.threadId;
      const snap = await this.#core.getSnapshot(op.subscribe.threadId).catch(() => null);
      if (snap) snapshot = snap;
      else client.subscribedThreadId = null;
    }
    let stream: ThreadStreamCursor | undefined;
    if (snapshot && op.subscribe) {
      stream = this.#nextCursor(op.subscribe.threadId);
      snapshot = { ...snapshot, stream };
    }
    client.conn.post({
      type: 'initialized',
      submissionId: op.submissionId,
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
      snapshot,
      stream,
    });
  }

  async #handleSubscribe(
    client: Client,
    op: Extract<Op, { type: 'thread.subscribe' }>,
  ): Promise<void> {
    // Same ordering rule as handleInitialize: register the subscription
    // first so mid-snapshot broadcasts are delivered, then roll back if the
    // thread turns out not to exist (or the snapshot build fails).
    const previous = client.subscribedThreadId;
    client.subscribedThreadId = op.threadId;
    const snap = await this.#core.getSnapshot(op.threadId).catch(() => null);
    if (!snap) {
      client.subscribedThreadId = previous;
      client.conn.post({
        type: 'error',
        submissionId: op.submissionId,
        code: 'thread_not_found',
        message: `thread ${op.threadId} not found`,
        retryable: false,
      });
      return;
    }
    const stream = this.#nextCursor(op.threadId);
    client.conn.post({
      type: 'initialized',
      submissionId: op.submissionId,
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
      snapshot: { ...snap, stream },
      stream,
    });
  }

  #enqueue(client: Client, op: Op): void {
    const key = this.#core.threadIdOf(op) ?? '';
    let queue = this.#queues.get(key);
    if (!queue) {
      queue = { ops: [], running: false };
      this.#queues.set(key, queue);
    }
    if (queue.ops.length >= QUEUE_CAPACITY) {
      client.conn.post({
        type: 'command.rejected',
        submissionId: op.submissionId,
        code: 'overloaded',
        message: 'Engine command queue is full. Retry after current work drains.',
      });
      return;
    }
    queue.ops.push({ op, from: client });
    void this.#drain(key, queue);
  }

  async #drain(key: string, queue: OpQueue): Promise<void> {
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.ops.length > 0) {
        const queued = queue.ops.shift();
        if (!queued) continue;
        const { op, from } = queued;
        try {
          await this.#core.handleOp(
            { ...op, clientId: from.clientId ?? 'unidentified-client' } as Op,
            (ev) => this.#emit(ev, from),
          );
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.#postToClient(from, {
            type: 'command.rejected',
            submissionId: op.submissionId,
            code: 'internal',
            message,
          });
        }
      }
    } finally {
      queue.running = false;
      if (queue.ops.length === 0) this.#queues.delete(key);
      if (this.#queues.size === 0) {
        for (const resolve of this.#idleWaiters) resolve();
        this.#idleWaiters.clear();
      }
    }
  }

  /**
   * Route a core-emitted event: events echoing a submissionId are responses
   * and go to the originating client (which may not be subscribed yet, e.g.
   * thread.created); everything else fans out by thread subscription.
   */
  #emit(ev: AgentEvent, from: Client): void {
    if ('submissionId' in ev && ev.submissionId !== undefined) {
      if (this.#clients.has(from)) this.#postToClient(from, this.#stampThreadEvent(ev));
      return;
    }
    this.broadcast(ev);
  }

  // ---- delta coalescing (docs/01 §3.5) --------------------------------------

  #postToClient(client: Client, ev: AgentEvent): void {
    if (
      ev.type === 'item.delta' &&
      (ev.delta.text !== undefined || ev.delta.reasoning !== undefined)
    ) {
      if (!ev.stream) throw new Error('item.delta is missing its stream cursor');
      const buf = client.pendingDeltas.get(ev.itemId) ?? {
        threadId: ev.threadId,
        text: '',
        reasoning: '',
        stream: ev.stream,
      };
      buf.text += ev.delta.text ?? '';
      buf.reasoning += ev.delta.reasoning ?? '';
      buf.stream = ev.stream;
      client.pendingDeltas.set(ev.itemId, buf);
      if (client.flushTimer === null) {
        client.flushTimer = setTimeout(() => this.#flushDeltas(client), DELTA_COALESCE_MS);
      }
      return;
    }
    // Non-coalescable events must not overtake buffered deltas for the same items.
    this.#flushDeltas(client);
    client.conn.post(ev);
  }

  #flushDeltas(client: Client): void {
    if (client.flushTimer !== null) {
      clearTimeout(client.flushTimer);
      client.flushTimer = null;
    }
    for (const [itemId, buf] of client.pendingDeltas) {
      const delta: { text?: string; reasoning?: string } = {};
      if (buf.text) delta.text = buf.text;
      if (buf.reasoning) delta.reasoning = buf.reasoning;
      client.conn.post({
        type: 'item.delta',
        threadId: buf.threadId,
        itemId,
        delta,
        stream: buf.stream,
      });
    }
    client.pendingDeltas.clear();
  }

  #nextCursor(threadId: string): ThreadStreamCursor {
    const sequence = (this.#threadSequences.get(threadId) ?? 0) + 1;
    this.#threadSequences.set(threadId, sequence);
    return { threadId, epoch: this.#streamEpoch, sequence };
  }

  #stampThreadEvent(ev: AgentEvent): AgentEvent {
    const threadId =
      'threadId' in ev && typeof ev.threadId === 'string'
        ? ev.threadId
        : ev.type === 'activity.updated'
          ? ev.activity.threadId
          : undefined;
    if (!threadId) return ev;
    return { ...ev, stream: this.#nextCursor(threadId) };
  }
}

/** Inert core for shell tests: knows no threads, accepts nothing. */
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
