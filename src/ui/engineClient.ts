/**
 * Client-side engine session: connection lifecycle (auto-reconnect on SW
 * death), snapshot-based state, incremental event application (docs/01 §3.4).
 *
 * UI state = replayed snapshot + live event overlay. The UI holds no truth of
 * its own (docs/01 §1).
 */

import { create } from 'zustand';
import {
  PROTOCOL_VERSION,
  type AgentEvent,
  type ApprovalDecision,
  type Op,
  type PendingApproval,
  type SnapshotItem,
  type ThreadSnapshot,
  type ThreadSnapshotMeta,
  type TurnOverrides,
  type UserInput,
} from '../messaging/protocol';
import { createPortTransport, type EngineTransport } from '../messaging/transport';

// ---------------------------------------------------------------------------
// Live item state (streaming overlay)
// ---------------------------------------------------------------------------

export interface LiveItem {
  itemId: string;
  kind: string;
  meta: { toolName?: string; label?: string; level?: string };
  text: string;
  reasoning: string;
  toolProgress?: unknown;
  status: 'streaming' | 'ok' | 'fail';
  details?: unknown;
}

export interface ThreadUiState {
  connected: boolean;
  threadId: string | null;
  meta: ThreadSnapshotMeta | null;
  /** Persisted items from the snapshot. */
  items: SnapshotItem[];
  /** Streaming overlay, keyed in arrival order. */
  liveItems: LiveItem[];
  activeTurn: { turnId: string; steerable: boolean } | null;
  /** True when the prior SW died mid-turn — UI offers a "continue" button. */
  wasInterrupted: boolean;
  pendingApprovals: PendingApproval[];
  queuedInputs: number;
  lastUsage: {
    contextPct: number;
    costUsd?: number;
    totalTokens: number;
    /** Session-accumulated breakdown for the cost popover. */
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
  } | null;
  todos: { text: string; done: boolean }[];
  lastError: { message: string; retryable: boolean; kind?: string } | null;
  /** Last submitted input, kept for the error-banner retry (docs/09 §7). */
  lastInput: UserInput | null;
  /** Controlled tabs for the task panel (docs/09 §3.1). */
  controlledTabs: { tabId: number; title: string; url: string }[];
  /** Sticky per-session overrides (model selector / tool-level switch). */
  pendingOverrides: TurnOverrides;
}

const initialState: ThreadUiState = {
  connected: false,
  threadId: null,
  meta: null,
  items: [],
  liveItems: [],
  activeTurn: null,
  wasInterrupted: false,
  pendingApprovals: [],
  queuedInputs: 0,
  lastUsage: null,
  todos: [],
  lastError: null,
  lastInput: null,
  controlledTabs: [],
  pendingOverrides: {},
};

// ---------------------------------------------------------------------------

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type OpInput = DistributiveOmit<Op, 'submissionId'>;

export class EngineSession {
  private transport: EngineTransport | null = null;
  private reconnectDelay = 500;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  readonly store = create<ThreadUiState>(() => ({ ...initialState }));

  constructor(private makeTransport: () => EngineTransport = createPortTransport) {
    this.connect();
  }

  // ---- connection lifecycle -----------------------------------------------

  private connect(): void {
    if (this.disposed) return;
    try {
      this.transport = this.makeTransport();
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.transport.onEvent((ev) => this.apply(ev));
    this.transport.onDisconnect(() => {
      this.store.setState({ connected: false });
      this.transport = null;
      this.scheduleReconnect();
    });

    const threadId = this.store.getState().threadId;
    this.send({
      type: 'initialize',
      protocolVersion: PROTOCOL_VERSION,
      ...(threadId ? { subscribe: { threadId } } : {}),
    });

    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20_000);
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8_000);
  }

  dispose(): void {
    this.disposed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.transport?.close();
  }

  // ---- ops ------------------------------------------------------------------

  send(op: OpInput): string {
    const submissionId = crypto.randomUUID();
    this.transport?.send({ ...op, submissionId } as Op);
    return submissionId;
  }

  createThread(preset?: string): void {
    this.send({ type: 'thread.create', preset });
  }

  openThread(threadId: string): void {
    this.store.setState({ ...initialState, connected: this.store.getState().connected, threadId });
    this.send({ type: 'thread.subscribe', threadId });
  }

  submit(input: UserInput): void {
    const { threadId, activeTurn, pendingOverrides } = this.store.getState();
    if (!threadId) return;
    if (activeTurn) {
      if (activeTurn.steerable) {
        this.send({ type: 'turn.steer', threadId, expectedTurnId: activeTurn.turnId, input });
      } else {
        this.send({ type: 'turn.enqueue', threadId, input });
      }
      return;
    }
    const hasOverrides = Object.values(pendingOverrides).some((v) => v !== undefined);
    this.store.setState({ lastInput: input });
    this.send({ type: 'turn.submit', threadId, input, ...(hasOverrides ? { overrides: pendingOverrides } : {}) });
  }

  /** Re-submit the last input (error-banner retry). */
  retryLast(): void {
    const { lastInput } = this.store.getState();
    if (!lastInput) return;
    this.store.setState({ lastError: null });
    this.submit(lastInput);
  }

  /** Merge sticky per-session overrides (model selector / tool-level switch). */
  setOverrides(patch: Partial<TurnOverrides>): void {
    this.store.setState((s) => ({ pendingOverrides: { ...s.pendingOverrides, ...patch } }));
  }

  /** Branch switch (docs/09 §2): engine moves leafId, then we re-subscribe. */
  selectBranch(nodeId: string): void {
    const { threadId } = this.store.getState();
    if (!threadId) return;
    this.send({ type: 'thread.selectBranch', threadId, nodeId });
    this.send({ type: 'thread.subscribe', threadId });
  }

  enqueue(input: UserInput): void {
    const { threadId } = this.store.getState();
    if (threadId) this.send({ type: 'turn.enqueue', threadId, input });
  }

  interrupt(): void {
    const { threadId } = this.store.getState();
    if (threadId) this.send({ type: 'turn.interrupt', threadId });
  }

  respondApproval(approvalId: string, decision: ApprovalDecision): void {
    this.send({ type: 'approval.response', approvalId, decision });
    this.store.setState((s) => ({
      pendingApprovals: s.pendingApprovals.filter((p) => p.approvalId !== approvalId),
    }));
  }

  // ---- event application -----------------------------------------------------

  private apply(ev: AgentEvent): void {
    const s = this.store;
    switch (ev.type) {
      case 'initialized': {
        this.reconnectDelay = 500;
        if (ev.snapshot) this.applySnapshot(ev.snapshot);
        s.setState({ connected: true });
        break;
      }
      case 'thread.created': {
        s.setState({ ...initialState, connected: true, threadId: ev.threadId });
        this.send({ type: 'thread.subscribe', threadId: ev.threadId });
        break;
      }
      case 'turn.start':
        s.setState({
          activeTurn: { turnId: ev.turnId, steerable: ev.steerable },
          wasInterrupted: false,
          lastError: null,
        });
        break;
      case 'turn.complete': {
        // Persisted items now supersede the overlay: re-request the snapshot.
        const threadId = s.getState().threadId;
        if (threadId) this.send({ type: 'thread.subscribe', threadId });
        s.setState({ activeTurn: null });
        break;
      }
      case 'item.start':
        s.setState((st) => ({
          liveItems: [
            ...st.liveItems,
            { itemId: ev.itemId, kind: ev.kind, meta: ev.meta, text: '', reasoning: '', status: 'streaming' },
          ],
        }));
        break;
      case 'item.delta':
        s.setState((st) => ({
          liveItems: st.liveItems.map((it) =>
            it.itemId === ev.itemId
              ? {
                  ...it,
                  text: it.text + (ev.delta.text ?? ''),
                  reasoning: it.reasoning + (ev.delta.reasoning ?? ''),
                  toolProgress: ev.delta.toolProgress ?? it.toolProgress,
                }
              : it,
          ),
        }));
        break;
      case 'item.complete': {
        // todo_write surfaces the plan via the details channel (docs/05 §3).
        const details = ev.result?.details as { todos?: { text: string; done: boolean }[] } | undefined;
        s.setState((st) => ({
          liveItems: st.liveItems.map((it) =>
            it.itemId === ev.itemId
              ? { ...it, status: ev.result?.ok === false ? 'fail' : 'ok', details: ev.result?.details }
              : it,
          ),
          todos: details?.todos ?? st.todos,
        }));
        break;
      }
      case 'token.usage':
        s.setState((st) => ({
          lastUsage: {
            contextPct: ev.contextPct,
            costUsd: (st.lastUsage?.costUsd ?? 0) + (ev.costUsd ?? 0),
            totalTokens: (st.lastUsage?.totalTokens ?? 0) + ev.usage.input + ev.usage.output,
            inputTokens: (st.lastUsage?.inputTokens ?? 0) + ev.usage.input,
            outputTokens: (st.lastUsage?.outputTokens ?? 0) + ev.usage.output,
            cacheReadTokens: (st.lastUsage?.cacheReadTokens ?? 0) + (ev.usage.cacheRead ?? 0),
          },
        }));
        break;
      case 'approval.request':
        s.setState((st) => ({
          pendingApprovals: [
            ...st.pendingApprovals,
            { approvalId: ev.approvalId, turnId: ev.turnId, request: ev.request, requestedAt: Date.now() },
          ],
        }));
        break;
      case 'queue.updated':
        s.setState({ queuedInputs: ev.pending });
        break;
      case 'tabs.updated':
        if (ev.threadId === s.getState().threadId) s.setState({ controlledTabs: ev.tabs });
        break;
      case 'thread.updated':
        s.setState((st) => ({ meta: st.meta ? { ...st.meta, ...ev.patch } : st.meta }));
        break;
      case 'error':
        s.setState({ lastError: { message: ev.message, retryable: ev.retryable, kind: ev.errorKind } });
        break;
      // pong / overloaded / escalation.request / unknown types: ignored here.
      default:
        break;
    }
  }

  private applySnapshot(snap: ThreadSnapshot): void {
    this.store.setState({
      threadId: snap.meta.id,
      meta: snap.meta,
      items: snap.items,
      liveItems: [], // snapshot supersedes the overlay
      activeTurn: snap.activeTurn && !snap.activeTurn.wasInterrupted
        ? { turnId: snap.activeTurn.turnId, steerable: snap.activeTurn.steerable }
        : null,
      wasInterrupted: snap.activeTurn?.wasInterrupted ?? false,
      pendingApprovals: snap.pendingApprovals,
      queuedInputs: snap.queuedInputs,
    });
  }
}
