/**
 * Client-side engine session: connection lifecycle (auto-reconnect on SW
 * death), snapshot-based state, incremental event application (docs/01 §3.4).
 *
 * UI state = replayed snapshot + live event overlay. The UI holds no truth of
 * its own (docs/01 §1).
 */

import { create } from 'zustand';
import {
  ENGINE_PROTOCOL,
  ENGINE_SCHEMA_HASH,
  type AgentEvent,
  type ApprovalDecision,
  type ContextBlock,
  type Op,
  type PendingApproval,
  type RunRecoveryState,
  type SnapshotItem,
  type ThreadSnapshot,
  type ThreadSnapshotMeta,
  type TurnOverrides,
  type UserInput,
} from '../messaging/protocol';
import { createPortTransport, type EngineTransport } from '../messaging/transport';
import type { ProviderErrorDetails } from '../providers/types';
import { SettingsStore } from '../settings/store';
import { hostPermissionBroker } from '../permissions/hostPermissionBroker';

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
  /** Client-side optimistic echo (user message shown before persistence). */
  local?: boolean;
  /** Context chips (@page etc.) on an echoed user message, mirrored from the input. */
  attachedContext?: ContextBlock[];
}

export interface ThreadUiState {
  connected: boolean;
  reloadRequired: boolean;
  /** True between openThread and the snapshot's arrival (skeleton, not empty state). */
  loading: boolean;
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
  queuedRuns: ThreadSnapshot['queuedRuns'];
  recoverableRuns: RunRecoveryState[];
  /**
   * Local echo of enqueued input texts (queue dock). The protocol only
   * broadcasts a count, so texts survive only within this session — after a
   * reconnect the dock degrades to "N queued" placeholders.
   */
  queuedTexts: string[];
  todos: { text: string; done: boolean }[];
  lastError: {
    message: string;
    retryable: boolean;
    kind?: string;
    details?: ProviderErrorDetails;
  } | null;
  /** Last submitted input, kept for the error-banner retry (docs/09 §7). */
  lastInput: UserInput | null;
  /** Tabs the agent has operated on — audit trail for the task panel (docs/09 §3.1). */
  agentTabs: { tabId: number; title: string; url: string }[];
  /** Sticky per-session overrides (model selector / tool-level switch). */
  pendingOverrides: TurnOverrides;
}

/** Per-thread agent activity for sidebar indicators (activity.updated). */
export interface ThreadActivity {
  running: boolean;
  pendingApprovals: number;
}

const initialState: ThreadUiState = {
  connected: false,
  reloadRequired: false,
  loading: false,
  threadId: null,
  meta: null,
  items: [],
  liveItems: [],
  activeTurn: null,
  wasInterrupted: false,
  pendingApprovals: [],
  queuedInputs: 0,
  queuedRuns: [],
  recoverableRuns: [],
  queuedTexts: [],
  todos: [],
  lastError: null,
  lastInput: null,
  agentTabs: [],
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
  private clientId: string = crypto.randomUUID();
  private readonly outbox = new Map<string, Op>();
  private readonly storageScope =
    typeof location === 'undefined' ? 'test' : location.pathname.replace(/[^a-z0-9_-]/gi, '_');
  /** Draft-mode input waiting for thread.created before it can be submitted. */
  private pendingDraft: UserInput | null = null;
  /** thread.updated patch that arrived before the snapshot (meta still null). */
  private pendingMetaPatch: Partial<ThreadSnapshotMeta> | null = null;
  /** submissionId → echo itemId: rejected ops retract their echo bubble. */
  private echoOps = new Map<string, string>();

  readonly store = create<ThreadUiState>(() => ({ ...initialState }));

  /**
   * Cross-thread activity (activity.updated) — a SEPARATE store so sidebar
   * indicator updates for background threads never re-render the message
   * stream subscribed to ThreadUiState.
   */
  readonly activityStore = create<{ activity: Map<string, ThreadActivity> }>(() => ({
    activity: new Map(),
  }));

  constructor(private makeTransport: () => EngineTransport = createPortTransport) {
    if (this.hasSessionStorage()) {
      void this.restoreSession().finally(() => this.connect());
    } else {
      this.connect();
    }
    void this.restoreModelOverride();
  }

  private hasSessionStorage(): boolean {
    return typeof chrome !== 'undefined' && !!chrome.storage?.session;
  }

  private get clientStorageKey(): string {
    return `engine_client_id:${this.storageScope}`;
  }

  private get outboxStorageKey(): string {
    return `engine_outbox:${this.storageScope}`;
  }

  private async restoreSession(): Promise<void> {
    try {
      const stored = await chrome.storage.session.get([
        this.clientStorageKey,
        this.outboxStorageKey,
      ]);
      const clientId = stored[this.clientStorageKey];
      if (typeof clientId === 'string' && clientId) this.clientId = clientId;
      const commands = stored[this.outboxStorageKey];
      if (Array.isArray(commands)) {
        for (const command of commands) {
          if (typeof command?.submissionId === 'string') {
            this.outbox.set(command.submissionId, command as Op);
          }
        }
      }
      await chrome.storage.session.set({ [this.clientStorageKey]: this.clientId });
    } catch {
      // The in-memory outbox remains authoritative for this UI lifetime.
    }
  }

  private persistOutbox(): void {
    if (!this.hasSessionStorage()) return;
    void chrome.storage.session
      .set({ [this.outboxStorageKey]: [...this.outbox.values()] })
      .catch(() => {});
  }

  private shouldTrack(op: Op): boolean {
    return op.type !== 'initialize' && op.type !== 'ping' && op.type !== 'thread.subscribe';
  }

  private acknowledge(submissionId: string): void {
    this.outbox.delete(submissionId);
    this.echoOps.delete(submissionId);
    this.persistOutbox();
  }

  private replayOutbox(): void {
    const transport = this.transport;
    if (!transport) return;
    for (const command of this.outbox.values()) transport.send(command);
  }

  /**
   * Seed pendingOverrides.model from last-used / global default so new chats
   * keep the user's model choice (ChatGPT semantics). Only fills the gap —
   * never clobbers a choice made while the async read was in flight.
   */
  private async restoreModelOverride(): Promise<void> {
    const threadIdAtStart = this.store.getState().threadId;
    try {
      const model =
        (await SettingsStore.lastModel.get()) ?? (await SettingsStore.global.get()).defaultModel;
      if (!model) return;
      const s = this.store.getState();
      if (s.threadId !== threadIdAtStart || s.pendingOverrides.model !== undefined) return;
      this.store.setState({ pendingOverrides: { ...s.pendingOverrides, model } });
    } catch {
      // storage unavailable (tests) — overrides simply stay empty
    }
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
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
      clientId: this.clientId,
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
    const command = { ...op, submissionId } as Op;
    if (this.shouldTrack(command)) {
      this.outbox.set(submissionId, command);
      this.persistOutbox();
    }
    this.transport?.send(command);
    return submissionId;
  }

  createThread(preset?: string): void {
    this.send({ type: 'thread.create', preset });
  }

  /**
   * Draft mode (ChatGPT semantics): "new chat" shows an empty conversation
   * WITHOUT persisting anything — the thread row is only created when the
   * first message is submitted, so the list never fills with empty chats.
   */
  startDraft(): void {
    const { connected, pendingOverrides } = this.store.getState();
    this.pendingDraft = null;
    this.pendingMetaPatch = null;
    this.echoOps.clear();
    this.store.setState({ ...initialState, connected, pendingOverrides });
    void this.restoreModelOverride();
  }

  openThread(threadId: string): void {
    this.pendingMetaPatch = null;
    this.echoOps.clear();
    this.store.setState({
      ...initialState,
      connected: this.store.getState().connected,
      threadId,
      loading: true,
    });
    this.send({ type: 'thread.subscribe', threadId });
    void this.restoreModelOverride();
  }

  /**
   * Optimistic echo (ChatGPT/OpenWebUI semantics): the user's message renders
   * the instant they hit send, regardless of transport/subscription timing.
   * applySnapshot reconciles echoes away once the persisted node arrives; a
   * rejected op retracts its echo via echoOps.
   */
  private echoUser(input: UserInput, isRetry = false): string | null {
    // A retry re-submits lastInput — its echo bubble already exists.
    if (
      isRetry &&
      this.store.getState().liveItems.some((it) => it.local && it.text === input.text)
    ) {
      return null;
    }
    const itemId = `local-${crypto.randomUUID()}`;
    this.store.setState((s) => ({
      liveItems: [
        ...s.liveItems,
        {
          itemId,
          kind: 'user_message',
          meta: {},
          text: input.text,
          reasoning: '',
          status: 'ok' as const,
          local: true,
          attachedContext: input.attachedContext,
        },
      ],
    }));
    return itemId;
  }

  private retractEcho(itemId: string): void {
    this.store.setState((s) => ({ liveItems: s.liveItems.filter((it) => it.itemId !== itemId) }));
  }

  submit(input: UserInput, opts?: { isRetry?: boolean }): void {
    const { threadId, activeTurn, pendingOverrides } = this.store.getState();
    const echoId = this.echoUser(input, opts?.isRetry ?? false);
    const track = (submissionId: string) => {
      if (echoId) this.echoOps.set(submissionId, echoId);
    };
    if (!threadId) {
      // Draft mode: materialize the thread first, then submit on created.
      this.pendingDraft = input;
      this.store.setState({ lastInput: input });
      this.send({ type: 'thread.create' });
      return;
    }
    if (activeTurn) {
      if (activeTurn.steerable) {
        track(
          this.send({ type: 'turn.steer', threadId, expectedTurnId: activeTurn.turnId, input }),
        );
      } else {
        track(this.send({ type: 'turn.enqueue', threadId, input }));
      }
      return;
    }
    const hasOverrides = Object.values(pendingOverrides).some((v) => v !== undefined);
    this.store.setState({ lastInput: input });
    track(
      this.send({
        type: 'turn.submit',
        threadId,
        input,
        ...(hasOverrides ? { overrides: pendingOverrides } : {}),
      }),
    );
  }

  /** Re-submit the last input (error-banner retry). */
  retryLast(): void {
    const { lastInput } = this.store.getState();
    if (!lastInput) return;
    this.store.setState({ lastError: null });
    this.submit(lastInput, { isRetry: true });
  }

  /** Merge sticky per-session overrides (model selector / tool-level switch). */
  setOverrides(patch: Partial<TurnOverrides>): void {
    this.store.setState((s) => ({ pendingOverrides: { ...s.pendingOverrides, ...patch } }));
    // Model picks persist as "last used" so the next chat reuses them;
    // picking the default clears the memory.
    if ('model' in patch) {
      try {
        void SettingsStore.lastModel.set(patch.model ?? null);
      } catch {
        /* storage unavailable (tests) */
      }
    }
  }

  /** Branch switch (docs/09 §2): engine moves leafId, then we re-subscribe. */
  selectBranch(nodeId: string): void {
    const { threadId } = this.store.getState();
    if (!threadId) return;
    this.send({ type: 'thread.selectBranch', threadId, nodeId });
    this.send({ type: 'thread.subscribe', threadId });
  }

  /**
   * Branch-and-run (docs/02 §3.2): regenerate = fork at the assistant node
   * with its parent user text; edit-and-resend = fork at the user node with
   * the edited text. The new turn becomes a sibling; BranchSwitcher shows n/m.
   */
  forkTurn(siblingOfNodeId: string, input: UserInput): void {
    const { threadId, activeTurn, pendingOverrides } = this.store.getState();
    if (!threadId || activeTurn) return;
    // Reset local view: the fork rewrites the visible path from the anchor.
    this.store.setState({ lastInput: input, lastError: null });
    const echoId = this.echoUser(input);
    const hasOverrides = Object.values(pendingOverrides).some((v) => v !== undefined);
    const submissionId = this.send({
      type: 'turn.fork',
      threadId,
      siblingOfNodeId,
      input,
      ...(hasOverrides ? { overrides: pendingOverrides } : {}),
    });
    if (echoId) this.echoOps.set(submissionId, echoId);
    // Fetch the repositioned path (pre-fork items vanish from the old branch).
    this.send({ type: 'thread.subscribe', threadId });
  }

  enqueue(input: UserInput): void {
    const { threadId } = this.store.getState();
    if (!threadId) return;
    const echoId = this.echoUser(input);
    // Local text echo for the queue dock (protocol carries only a count).
    this.store.setState((s) => ({ queuedTexts: [...s.queuedTexts, input.text] }));
    const submissionId = this.send({ type: 'turn.enqueue', threadId, input });
    if (echoId) this.echoOps.set(submissionId, echoId);
  }

  updateQueued(runId: string, input: UserInput, overrides?: TurnOverrides): void {
    const { threadId } = this.store.getState();
    if (!threadId) return;
    this.send({ type: 'queue.update', threadId, runId, input, overrides });
  }

  removeQueued(runId: string): void {
    const { threadId } = this.store.getState();
    if (!threadId) return;
    this.send({ type: 'queue.remove', threadId, runId });
  }

  resumeRun(runId: string): void {
    const { threadId } = this.store.getState();
    if (!threadId) return;
    this.store.setState((state) => ({
      recoverableRuns: state.recoverableRuns.filter((run) => run.runId !== runId),
      wasInterrupted: false,
    }));
    this.send({ type: 'run.resume', threadId, runId });
  }

  resolveUncertain(runId: string, resolution: 'retry' | 'mark_done' | 'fail'): void {
    const { threadId } = this.store.getState();
    if (!threadId) return;
    this.store.setState((state) => ({
      recoverableRuns: state.recoverableRuns.filter((run) => run.runId !== runId),
    }));
    this.send({ type: 'run.resolveUncertain', threadId, runId, resolution });
  }

  interrupt(): void {
    const { threadId } = this.store.getState();
    if (threadId) this.send({ type: 'turn.interrupt', threadId });
  }

  async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.store
      .getState()
      .pendingApprovals.find((item) => item.approvalId === approvalId);
    let resolvedDecision = decision;
    if (
      pending?.request.flags.includes('host_permission') &&
      decision.kind !== 'decline' &&
      decision.kind !== 'cancel'
    ) {
      try {
        const granted = await hostPermissionBroker.request(pending.request.targetOrigin);
        if (!granted) {
          resolvedDecision = {
            kind: 'decline',
            note: 'Browser host permission was not granted.',
          };
        }
      } catch {
        resolvedDecision = {
          kind: 'decline',
          note: 'Browser host permission request failed.',
        };
      }
    }
    this.send({ type: 'approval.response', approvalId, decision: resolvedDecision });
    this.store.setState((s) => ({
      pendingApprovals: s.pendingApprovals.filter((p) => p.approvalId !== approvalId),
    }));
  }

  // ---- event application -----------------------------------------------------

  private apply(ev: AgentEvent): void {
    const s = this.store;
    // Thread-scoped events for another thread must not leak into this view —
    // the host broadcast is per-subscription, but subscribe ops race turn
    // events during thread switches (the old thread's stream is still in
    // flight while store.threadId already points at the new one), and a
    // draft (threadId null) must ignore the previous thread's stream too.
    if (
      'threadId' in ev &&
      ev.type !== 'thread.created' &&
      ev.type !== 'thread.forked' &&
      (ev as { threadId: string }).threadId !== s.getState().threadId
    ) {
      return;
    }
    switch (ev.type) {
      case 'initialized': {
        this.reconnectDelay = 500;
        if (ev.snapshot) this.applySnapshot(ev.snapshot);
        s.setState({ connected: true });
        this.replayOutbox();
        break;
      }
      case 'fatal.reload_required': {
        this.disposed = true;
        this.transport?.close();
        s.setState({
          connected: false,
          reloadRequired: true,
          lastError: { message: ev.message, retryable: false, kind: 'protocol' },
        });
        break;
      }
      case 'command.ack': {
        this.acknowledge(ev.submissionId);
        break;
      }
      case 'command.rejected': {
        const echoId = this.echoOps.get(ev.submissionId);
        if (echoId) this.retractEcho(echoId);
        this.acknowledge(ev.submissionId);
        s.setState({
          lastError: { message: ev.message, retryable: ev.code === 'overloaded' },
        });
        break;
      }
      case 'thread.created': {
        const { pendingOverrides, liveItems, lastInput } = s.getState();
        // Keep optimistic echoes across the draft→thread transition so the
        // just-sent message doesn't blink out and back in.
        const echoes = liveItems.filter((it) => it.local);
        s.setState({
          ...initialState,
          connected: true,
          threadId: ev.threadId,
          pendingOverrides,
          liveItems: echoes,
          lastInput,
        });
        this.send({ type: 'thread.subscribe', threadId: ev.threadId });
        const draft = this.pendingDraft;
        this.pendingDraft = null;
        // Internal re-submit: the draft's echo bubble already exists —
        // echoing again here rendered the message twice.
        if (draft) this.submit(draft, { isRetry: true });
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
            {
              itemId: ev.itemId,
              kind: ev.kind,
              meta: ev.meta,
              text: '',
              reasoning: '',
              status: 'streaming',
            },
          ],
        }));
        break;
      case 'item.delta':
        s.setState((st) => {
          let found = false;
          let liveItems = st.liveItems.map((it) => {
            if (it.itemId !== ev.itemId) return it;
            found = true;
            return {
              ...it,
              text: it.text + (ev.delta.text ?? ''),
              reasoning: it.reasoning + (ev.delta.reasoning ?? ''),
              toolProgress: ev.delta.toolProgress ?? it.toolProgress,
            };
          });
          if (!found) {
            // Mid-turn subscribe: item.start predates our subscription.
            // Upsert so the ongoing stream is visible instead of dropped.
            liveItems = [
              ...liveItems,
              {
                itemId: ev.itemId,
                kind: ev.delta.toolProgress !== undefined ? 'tool_call' : 'assistant_message',
                meta: {},
                text: ev.delta.text ?? '',
                reasoning: ev.delta.reasoning ?? '',
                toolProgress: ev.delta.toolProgress,
                status: 'streaming' as const,
              },
            ];
          }
          return { liveItems };
        });
        break;
      case 'item.complete': {
        // todo_write surfaces the plan via the details channel (docs/05 §3).
        const details = ev.result?.details as
          { todos?: { text: string; done: boolean }[] } | undefined;
        s.setState((st) => ({
          liveItems: st.liveItems.map((it) =>
            it.itemId === ev.itemId
              ? {
                  ...it,
                  status: ev.result?.ok === false ? 'fail' : 'ok',
                  details: ev.result?.details,
                }
              : it,
          ),
          todos: details?.todos ?? st.todos,
        }));
        break;
      }
      case 'approval.request':
        s.setState((st) => ({
          pendingApprovals: [
            ...st.pendingApprovals,
            {
              approvalId: ev.approvalId,
              turnId: ev.turnId,
              request: ev.request,
              requestedAt: Date.now(),
            },
          ],
        }));
        break;
      case 'queue.updated':
        // Reconcile the local text echo against the authoritative count:
        // engine drains FIFO, so drop from the head when the count shrinks;
        // if the count exceeds what we echoed (another surface enqueued),
        // keep what we have — the dock shows placeholders for the rest.
        s.setState((prev) => ({
          queuedInputs: ev.pending,
          queuedRuns: ev.runs,
          queuedTexts:
            prev.queuedTexts.length > ev.pending
              ? prev.queuedTexts.slice(prev.queuedTexts.length - ev.pending)
              : prev.queuedTexts,
        }));
        break;
      case 'run.recovery_required':
        s.setState((state) => ({
          recoverableRuns: [
            ...state.recoverableRuns.filter((run) => run.runId !== ev.run.runId),
            ev.run,
          ],
          wasInterrupted: state.wasInterrupted || ev.run.state === 'interrupted',
        }));
        break;
      case 'tabs.updated':
        if (ev.threadId === s.getState().threadId) s.setState({ agentTabs: ev.tabs });
        break;
      case 'activity.updated': {
        // Separate store: background-thread indicators must not re-render
        // ThreadUiState subscribers (the virtualized message stream).
        const next = new Map(this.activityStore.getState().activity);
        if (!ev.activity.running && ev.activity.pendingApprovals === 0)
          next.delete(ev.activity.threadId);
        else
          next.set(ev.activity.threadId, {
            running: ev.activity.running,
            pendingApprovals: ev.activity.pendingApprovals,
          });
        this.activityStore.setState({ activity: next });
        break;
      }
      case 'thread.updated':
        if (ev.threadId !== s.getState().threadId) break;
        s.setState((st) => {
          if (st.meta && ev.revision < st.meta.revision) return st;
          if (st.meta) return { meta: { ...st.meta, ...ev.patch, revision: ev.revision } };
          // Snapshot not here yet (subscribe still in flight): stash the
          // patch so the title isn't lost, apply it over the snapshot meta.
          this.pendingMetaPatch = { ...this.pendingMetaPatch, ...ev.patch, revision: ev.revision };
          return st;
        });
        break;
      case 'error': {
        // The engine dropped the op — its optimistic echo must not linger
        // as a phantom "sent" bubble (no_active_turn / queue_full / ...).
        if (ev.submissionId !== undefined) {
          const echoId = this.echoOps.get(ev.submissionId);
          if (echoId) {
            this.echoOps.delete(ev.submissionId);
            this.retractEcho(echoId);
          }
        }
        if (ev.code === 'thread_not_found') {
          // Every op this client sends targets its current thread, so this
          // means the thread vanished underneath us (deleted from another
          // surface, or a data import replaced the DB). Self-heal by falling
          // back to a fresh draft instead of dead-ending on an error banner.
          this.startDraft();
          break;
        }
        s.setState({
          lastError: {
            message: ev.message,
            retryable: ev.retryable,
            kind: ev.errorKind,
            details: ev.providerDetails,
          },
        });
        break;
      }
      // pong / unknown types: ignored here.
      default:
        break;
    }
  }

  private applySnapshot(snap: ThreadSnapshot): void {
    const current = this.store.getState();
    if (current.meta?.id === snap.meta.id && current.meta.revision > snap.meta.revision) return;
    const metaPatch = this.pendingMetaPatch;
    this.pendingMetaPatch = null;
    this.store.setState((st) => {
      // Snapshot supersedes the overlay — except for what the snapshot can't
      // contain yet: user messages not yet persisted (echoes / queued inputs)
      // and items belonging to the still-running turn. Reconciliation rules:
      //  - user items: multiset by text — N persisted copies absorb at most
      //    N live copies, so a queued duplicate ("继续" twice) keeps its bubble.
      //  - other live items exist only while a turn is live; with no active
      //    turn nothing can still be feeding them (SW-crash ghosts) → drop.
      //  - tool cards persist with the SAME itemId → exact dedup.
      //  - assistant text has no shared id → dedup by text; keep completed
      //    live text the snapshot hasn't caught up to (mid-turn resubscribe).
      const userCounts = new Map<string, number>();
      const assistantTexts = new Set<string>();
      const toolItemIds = new Set<string>();
      for (const item of snap.items) {
        if (item.kind === 'user_message') {
          const text =
            (item.payload as { content?: { type: string; text?: string }[] }).content
              ?.map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
              .join('\n') ?? '';
          userCounts.set(text, (userCounts.get(text) ?? 0) + 1);
        } else if (item.kind === 'assistant_message') {
          const text =
            (item.payload as { content?: { type: string; text?: string }[] }).content
              ?.map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
              .join('') ?? '';
          if (text) assistantTexts.add(text);
        } else if (item.kind === 'tool_call') {
          const id = (item.payload as { itemId?: string }).itemId;
          if (id) toolItemIds.add(id);
        }
      }
      const turnLive = snap.activeTurn !== null && !snap.activeTurn.wasInterrupted;
      const liveItems = st.liveItems.filter((it) => {
        if (it.kind === 'user_message') {
          const c = userCounts.get(it.text) ?? 0;
          if (c > 0) {
            userCounts.set(it.text, c - 1);
            return false;
          }
          return true;
        }
        if (it.local || !turnLive) return false;
        if (it.kind === 'tool_call') return !toolItemIds.has(it.itemId);
        if (it.kind === 'assistant_message')
          return it.status === 'streaming' || !assistantTexts.has(it.text);
        return it.status === 'streaming';
      });
      return {
        loading: false,
        threadId: snap.meta.id,
        meta: metaPatch ? { ...snap.meta, ...metaPatch } : snap.meta,
        items: snap.items,
        liveItems,
        activeTurn:
          snap.activeTurn && !snap.activeTurn.wasInterrupted
            ? { turnId: snap.activeTurn.turnId, steerable: snap.activeTurn.steerable }
            : null,
        wasInterrupted: snap.activeTurn?.wasInterrupted ?? false,
        pendingApprovals: snap.pendingApprovals,
        queuedInputs: snap.queuedInputs,
        queuedRuns: snap.queuedRuns,
        recoverableRuns: snap.recoverableRuns,
        // Restore todos from the latest todo_write result persisted in the
        // snapshot. The snapshot doesn't have a dedicated todos field, so we
        // scan backward for the last tool_result whose details carry todos[].
        todos: (() => {
          for (let i = snap.items.length - 1; i >= 0; i--) {
            const it = snap.items[i]!;
            if (it.kind !== 'tool_result') continue;
            const d = (it.payload as { details?: { todos?: { text: string; done: boolean }[] } })
              .details;
            if (Array.isArray(d?.todos)) return d.todos;
          }
          return st.todos; // no todo_write in snapshot → keep live value
        })(),
      };
    });
  }
}
