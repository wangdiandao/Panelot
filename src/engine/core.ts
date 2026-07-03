/**
 * EngineCore — thread management, turn scheduling, approval RPC bookkeeping,
 * snapshot building (docs/01, docs/04). This is the real implementation
 * behind EngineHost.
 */

import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequestPayload,
  Op,
  PendingApproval,
  SnapshotItem,
  ThreadSnapshot,
  UserInput,
} from '../messaging/protocol';
import type { PanelotDB } from '../db/schema';
import { ThreadTree } from '../db/tree';
import { buildSessionContext } from '../db/sessionContext';
import { runTurn, type GatekeeperCheck, type TurnEnv, type TurnHandle } from '../agent/loop';
import { ToolRegistry } from '../agent/tool';
import type { CompactionRunner } from '../agent/compactionRunner';
import { assembleSystemPrompt, type AssembleOptions } from '../prompts/assemble';
import type { ProviderAdapter, GenParams } from '../providers/types';

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // docs/06 §4
const ENQUEUE_CAPACITY = 8; // docs/04 §3

/** Resolves the provider/model/params for a thread (preset & overrides). */
export interface ProviderResolver {
  resolve(threadId: string, overrides?: { connectionId: string; modelId: string }): Promise<{
    provider: ProviderAdapter;
    model: string;
    params: GenParams;
    contextWindow: number;
    /** $/Mtok, for cost accounting (docs/03 §1.2). */
    pricing?: { input: number; output: number; cacheRead?: number };
  }>;
}

interface ActiveTurn {
  handle: TurnHandle;
  threadId: string;
}

interface QueuedInput {
  input: UserInput;
}

export class RealEngineCore {
  private tree: ThreadTree;
  private activeTurns = new Map<string, ActiveTurn>(); // threadId → turn
  private queues = new Map<string, QueuedInput[]>(); // threadId → queued inputs
  private pendingApprovals = new Map<
    string,
    { threadId: string; turnId: string; request: ApprovalRequestPayload; requestedAt: number; resolve: (d: ApprovalDecision) => void; timer: ReturnType<typeof setTimeout> }
  >();
  /** Broadcast sink, wired by the host. */
  onBroadcast: (ev: AgentEvent) => void = () => {};
  /** Optional compaction runner (wired at startup; absent in minimal tests). */
  compaction: CompactionRunner | null = null;
  /** Called after an approval decision to apply its side effects (docs/06 §4). */
  onApprovalDecision?: (threadId: string, tool: string, targetOrigin: string, decision: ApprovalDecision) => Promise<void>;
  /** Most recent context token estimate per thread (from usage events). */
  private lastContextTokens = new Map<string, number>();

  constructor(
    private db: PanelotDB,
    /** Fixed registry, or a factory producing a thread-bound registry per turn. */
    private tools: ToolRegistry | ((threadId: string) => ToolRegistry),
    private gatekeeper: GatekeeperCheck,
    private providers: ProviderResolver,
    private promptOptions: () => Promise<AssembleOptions> = async () => ({}),
  ) {
    this.tree = new ThreadTree(db);
  }

  private toolsFor(threadId: string): ToolRegistry {
    return typeof this.tools === 'function' ? this.tools(threadId) : this.tools;
  }

  threadIdOf(op: Op): string | null {
    return 'threadId' in op ? (op as { threadId: string }).threadId : null;
  }

  // -------------------------------------------------------------------------
  // Op dispatch
  // -------------------------------------------------------------------------

  async handleOp(op: Op, emit: (ev: AgentEvent) => void): Promise<void> {
    switch (op.type) {
      case 'thread.create': {
        const thread = await this.tree.createThread({ preset: op.preset, folderId: op.folderId });
        emit({ type: 'thread.created', submissionId: op.submissionId, threadId: thread.id });
        return;
      }
      case 'turn.submit':
        return this.handleSubmit(op, emit);
      case 'turn.steer': {
        const active = this.activeTurns.get(op.threadId);
        if (!active) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'no_active_turn', message: 'no active turn to steer', retryable: false });
          return;
        }
        if (active.handle.turnId !== op.expectedTurnId) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'turn_mismatch', message: 'expectedTurnId does not match the active turn', retryable: false });
          return;
        }
        if (!active.handle.steerable) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'turn_not_steerable', message: 'this turn cannot be steered — enqueue instead', retryable: false });
          return;
        }
        active.handle.steer(op.input);
        return;
      }
      case 'turn.enqueue': {
        const queue = this.queues.get(op.threadId) ?? [];
        if (queue.length >= ENQUEUE_CAPACITY) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'queue_full', message: `queue is full (${ENQUEUE_CAPACITY})`, retryable: true });
          return;
        }
        queue.push({ input: op.input });
        this.queues.set(op.threadId, queue);
        this.onBroadcast({ type: 'queue.updated', threadId: op.threadId, pending: queue.length });
        // If idle, start immediately.
        if (!this.activeTurns.has(op.threadId)) void this.drainQueue(op.threadId);
        return;
      }
      case 'turn.interrupt': {
        this.activeTurns.get(op.threadId)?.handle.interrupt();
        return;
      }
      case 'approval.response': {
        const pending = this.pendingApprovals.get(op.approvalId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingApprovals.delete(op.approvalId);
          // Persist the decision's side effects (scopeOrigins growth,
          // session/site grants) before resolving so the next check sees them.
          await this.onApprovalDecision?.(pending.threadId, pending.request.tool, pending.request.targetOrigin, op.decision);
          pending.resolve(op.decision);
        }
        return;
      }
      case 'thread.fork': {
        const source = await this.tree.getThread(op.threadId);
        if (!source) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'thread_not_found', message: 'source thread not found', retryable: false });
          return;
        }
        const forked = await this.tree.createThread({
          title: `${source.title} (fork)`,
          parentThreadId: source.id,
          preset: source.preset,
        });
        emit({ type: 'thread.forked', submissionId: op.submissionId, threadId: op.threadId, newThreadId: forked.id });
        return;
      }
      case 'thread.compact': {
        if (!this.compaction) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'not_configured', message: 'compaction not available', retryable: false });
          return;
        }
        await this.compaction.compact(op.threadId);
        return;
      }
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Turn execution
  // -------------------------------------------------------------------------

  private async handleSubmit(
    op: Extract<Op, { type: 'turn.submit' }>,
    emit: (ev: AgentEvent) => void,
  ): Promise<void> {
    if (this.activeTurns.has(op.threadId)) {
      // Busy → auto-enqueue (UI may also enqueue explicitly).
      await this.handleOp({ ...op, type: 'turn.enqueue' }, emit);
      return;
    }
    const thread = await this.tree.getThread(op.threadId);
    if (!thread) {
      emit({ type: 'error', submissionId: op.submissionId, code: 'thread_not_found', message: `thread ${op.threadId} not found`, retryable: false });
      return;
    }
    await this.startTurn(op.threadId, op.input, op.overrides?.model);
  }

  private async startTurn(
    threadId: string,
    input: UserInput,
    modelOverride?: { connectionId: string; modelId: string },
  ): Promise<void> {
    const resolved = await this.providers.resolve(threadId, modelOverride);
    const promptOpts = await this.promptOptions();
    const systemPrompt = assembleSystemPrompt(promptOpts);

    const env: TurnEnv = {
      tree: this.tree,
      tools: this.toolsFor(threadId),
      gatekeeper: this.gatekeeper,
      requestApproval: (turnId, request) => this.requestApproval(threadId, turnId, request),
      emit: (ev) => {
        if (ev.type === 'token.usage') {
          const contextTokens = ev.usage.input + ev.usage.output + (ev.usage.cacheRead ?? 0);
          this.lastContextTokens.set(threadId, contextTokens);
          // Cost from pricing ($/Mtok), if the resolver supplied it (docs/03 §1.2).
          const pricing = resolved.pricing;
          const costUsd = pricing
            ? (ev.usage.input * pricing.input + ev.usage.output * pricing.output +
               (ev.usage.cacheRead ?? 0) * (pricing.cacheRead ?? pricing.input)) / 1_000_000
            : undefined;
          ev = {
            ...ev,
            costUsd,
            contextPct: Math.min(100, Math.round((contextTokens / resolved.contextWindow) * 100)),
          };
          // Accumulate into thread.stats for the session list (docs/02 §2.1).
          const addedTokens = ev.usage.input + ev.usage.output;
          void this.tree.getThread(threadId).then((t) => {
            if (!t) return;
            void this.tree.updateThread(threadId, {
              stats: {
                turns: t.stats.turns,
                totalTokens: t.stats.totalTokens + addedTokens,
                costUsd: t.stats.costUsd + (costUsd ?? 0),
              },
            });
          });
        }
        this.onBroadcast(ev);
      },
      provider: resolved.provider,
      model: resolved.model,
      systemPrompt,
      params: resolved.params,
      maybeCompact: this.compaction
        ? (tid) =>
            this.compaction!.maybeCompact(
              tid,
              this.lastContextTokens.get(tid) ?? 0,
              resolved.contextWindow,
            )
        : undefined,
    };

    const handle = runTurn(env, threadId, input);
    this.activeTurns.set(threadId, { handle, threadId });
    void this.tree.getThread(threadId).then((t) => {
      if (t) void this.tree.updateThread(threadId, { stats: { ...t.stats, turns: t.stats.turns + 1 } });
    });

    void handle.done.finally(() => {
      this.activeTurns.delete(threadId);
      // Cancel pending approvals belonging to this turn.
      for (const [id, p] of this.pendingApprovals) {
        if (p.turnId === handle.turnId) {
          clearTimeout(p.timer);
          this.pendingApprovals.delete(id);
        }
      }
      void this.scheduleTaskModelJobs(threadId);
      void this.drainQueue(threadId);
    });
  }

  private async drainQueue(threadId: string): Promise<void> {
    const queue = this.queues.get(threadId);
    if (!queue || queue.length === 0 || this.activeTurns.has(threadId)) return;
    const next = queue.shift()!;
    this.onBroadcast({ type: 'queue.updated', threadId, pending: queue.length });
    await this.startTurn(threadId, next.input);
  }

  // -------------------------------------------------------------------------
  // External pause (manual operation detected — docs/05 §5)
  // -------------------------------------------------------------------------

  /** Interrupt whatever turn is running on the thread (auto-pause path). */
  async pauseThread(threadId: string, reason: string): Promise<void> {
    const active = this.activeTurns.get(threadId);
    if (!active) return;
    active.handle.interrupt();
    await this.tree.appendNode(threadId, {
      type: 'system_notice',
      payload: { text: reason, noticeKind: 'paused' },
    });
  }

  /** Threads with a running turn (for routing manual-pause by tab). */
  activeThreadIds(): string[] {
    return [...this.activeTurns.keys()];
  }

  // -------------------------------------------------------------------------
  // Task-model jobs: title generation (docs/03 §1.5, docs/10 §5.3)
  // -------------------------------------------------------------------------

  private async scheduleTaskModelJobs(threadId: string): Promise<void> {
    try {
      const thread = await this.tree.getThread(threadId);
      if (!thread || thread.title || !thread.leafId) return; // title only generated once
      const ctx = await buildSessionContext(this.tree, threadId, thread.leafId);
      const firstExchange = ctx.messages
        .slice(0, 4)
        .map((m) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join(' '))
        .join('\n')
        .slice(0, 2000);
      if (!firstExchange.trim()) return;

      const { provider, model, params } = await this.providers.resolve(threadId);
      const stream = provider.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: `${firstExchange}\n\n---\nGenerate a title for this conversation: ≤6 words, user's language, no punctuation, name the task not the tool. Reply with the title only.` }] }],
        tools: [],
        params: { ...params, maxTokens: 30 },
        model,
        signal: AbortSignal.timeout(15_000),
      });
      const final = await stream.final();
      const title = final.message
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim()
        .replace(/^["'「]|["'」]$/g, '')
        .slice(0, 60);
      if (!title) return;
      await this.tree.updateThread(threadId, { title });
      this.onBroadcast({ type: 'thread.updated', threadId, patch: { title } });
    } catch {
      // Title generation is best-effort — never surfaces errors.
    }
  }

  // -------------------------------------------------------------------------
  // Approval RPC (docs/06 §4)
  // -------------------------------------------------------------------------

  private requestApproval(
    threadId: string,
    turnId: string,
    request: ApprovalRequestPayload,
  ): Promise<ApprovalDecision> {
    const approvalId = crypto.randomUUID();
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        // Timeout → decline (docs/06 §4).
        this.pendingApprovals.delete(approvalId);
        resolve({ kind: 'decline', note: 'approval timed out after 5 minutes' });
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(approvalId, {
        threadId,
        turnId,
        request,
        requestedAt: Date.now(),
        resolve,
        timer,
      });
      this.onBroadcast({ type: 'approval.request', threadId, turnId, approvalId, request });
    });
  }

  // -------------------------------------------------------------------------
  // Snapshot (docs/01 §3.4)
  // -------------------------------------------------------------------------

  async getSnapshot(threadId: string): Promise<ThreadSnapshot | null> {
    const thread = await this.tree.getThread(threadId);
    if (!thread) return null;

    const { leafId } = await this.tree.validateLeaf(threadId);
    const items: SnapshotItem[] = [];
    if (leafId) {
      const ctx = await buildSessionContext(this.tree, threadId, leafId);
      for (const node of ctx.path) {
        if (node.type === 'turn_context') continue;
        const siblings = await this.tree.getSiblings(threadId, node.id);
        items.push({
          nodeId: node.id,
          kind: node.type as SnapshotItem['kind'],
          ts: node.ts,
          payload: node.payload,
          branch: siblings.length > 1
            ? { index: siblings.findIndex((s) => s.id === node.id) + 1, count: siblings.length }
            : undefined,
        });
      }
    }

    const active = this.activeTurns.get(threadId);
    const pendingApprovals: PendingApproval[] = [...this.pendingApprovals.entries()]
      .filter(([, p]) => p.threadId === threadId)
      .map(([approvalId, p]) => ({
        approvalId,
        turnId: p.turnId,
        request: p.request,
        requestedAt: p.requestedAt,
      }));

    // Interrupted-mid-turn detection (docs/01 §4, docs/04 §6.2): no live turn
    // but the checkpointed path ends inside a turn → SW was likely killed.
    // The UI offers "continue"; replay from the last checkpoint continues.
    let wasInterrupted = false;
    if (!active && items.length > 0) {
      const last = items[items.length - 1]!;
      wasInterrupted = last.kind === 'tool_call' || last.kind === 'user_message';
    }

    return {
      meta: {
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        leafId,
        preset: thread.preset,
        archived: thread.archived,
        pinned: thread.pinned,
        stats: thread.stats,
      },
      items,
      activeTurn: active
        ? {
            turnId: active.handle.turnId,
            turnKind: active.handle.turnKind,
            steerable: active.handle.steerable,
            startedAt: 0,
          }
        : wasInterrupted
          ? { turnId: '', turnKind: 'user', steerable: false, startedAt: 0, wasInterrupted: true }
          : null,
      pendingApprovals,
      queuedInputs: this.queues.get(threadId)?.length ?? 0,
    };
  }
}
