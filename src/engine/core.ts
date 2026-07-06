/**
 * EngineCore — thread management, turn scheduling, approval RPC bookkeeping,
 * snapshot building (docs/01, docs/04). This is the real implementation
 * behind EngineHost.
 */

import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequestPayload,
  ContextBlock,
  Op,
  PendingApproval,
  SnapshotItem,
  ThreadSnapshot,
  TurnOverrides,
  UserInput,
} from '../messaging/protocol';
import type { PanelotDB } from '../db/schema';
import { ThreadTree } from '../db/tree';
import { buildSessionContext } from '../db/sessionContext';
import { runTurn, type GatekeeperCheck, type TurnEnv, type TurnHandle } from '../agent/loop';
import { ToolRegistry } from '../agent/tool';
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
    /** $/Mtok, for cost accounting (docs/03 §1.2). */
    pricing?: { input: number; output: number; cacheRead?: number };
  }>;
  /** Task model for titles (docs/03 §1.5); falls back to the thread's main model. */
  resolveTaskModel?(fallbackThreadId: string): Promise<{ provider: ProviderAdapter; model: string }>;
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
  /** Called after an approval decision to apply its side effects (docs/06 §4). */
  onApprovalDecision?: (threadId: string, tool: string, targetOrigin: string, decision: ApprovalDecision) => Promise<void>;
  /** Per-turn approval-policy override → gatekeeper thread config (docs/06 §1). */
  onPermissionOverride?: (threadId: string, approvalPolicy: NonNullable<TurnOverrides['approvalPolicy']>) => void;
  /**
   * Slash-command hook (docs/08): "/skill-name …" resolves to a context block
   * carrying the skill body, attached to the user message. Null = plain text.
   */
  resolveSlashCommand?: (text: string) => Promise<ContextBlock | null>;

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

  /**
   * Cross-thread activity broadcast (docs/09 §3.1 sidebar indicators) — the
   * event intentionally carries no top-level threadId so the host's
   * thread-scoped broadcast filter lets it reach every client.
   */
  private broadcastActivity(threadId: string): void {
    let pendingApprovals = 0;
    for (const p of this.pendingApprovals.values()) {
      if (p.threadId === threadId) pendingApprovals++;
    }
    this.onBroadcast({
      type: 'activity.updated',
      activity: { threadId, running: this.activeTurns.has(threadId), pendingApprovals },
    });
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
      case 'turn.fork': {
        // Branch-and-run (docs/02 §3.2): reposition leafId to the anchor's
        // parent so the turn's user message appends as a SIBLING branch.
        // Busy threads reject rather than enqueue — a queued fork would
        // reposition the cursor under a moving tree.
        if (this.activeTurns.has(op.threadId)) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'turn_mismatch', message: 'cannot fork while a turn is active', retryable: true });
          return;
        }
        try {
          await this.tree.repositionLeafForFork(op.threadId, op.siblingOfNodeId);
        } catch (e) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'thread_not_found', message: (e as Error).message, retryable: false });
          return;
        }
        await this.startTurn(op.threadId, op.input, op.overrides);
        return;
      }
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
          this.broadcastActivity(pending.threadId);
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
      case 'thread.selectBranch': {
        try {
          await this.tree.switchToSibling(op.threadId, op.nodeId);
        } catch (e) {
          emit({ type: 'error', submissionId: op.submissionId, code: 'thread_not_found', message: (e as Error).message, retryable: false });
          return;
        }
        this.onBroadcast({ type: 'thread.updated', threadId: op.threadId, patch: {} });
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
    await this.startTurn(op.threadId, op.input, op.overrides);
  }

  private async startTurn(
    threadId: string,
    input: UserInput,
    overrides?: TurnOverrides,
  ): Promise<void> {
    // Sticky per-session permission tier from the composer switch: applied
    // before the turn so every gate check this turn sees it.
    if (overrides?.approvalPolicy) this.onPermissionOverride?.(threadId, overrides.approvalPolicy);
    // Slash-command activation: attach the matched skill body to the message.
    if (this.resolveSlashCommand && /^\s*\//.test(input.text)) {
      try {
        const block = await this.resolveSlashCommand(input.text);
        if (block) input = { ...input, attachedContext: [...(input.attachedContext ?? []), block] };
      } catch { /* unresolved command → send as plain text */ }
    }
    const resolved = await this.providers.resolve(threadId, overrides?.model);
    const promptOpts = await this.promptOptions();
    const systemPrompt = assembleSystemPrompt(promptOpts);

    const env: TurnEnv = {
      tree: this.tree,
      tools: this.toolsFor(threadId),
      gatekeeper: this.gatekeeper,
      requestApproval: (turnId, request) => this.requestApproval(threadId, turnId, request),
      emit: (ev) => {
        if (ev.type === 'token.usage') {
          // Cost from pricing ($/Mtok), if the resolver supplied it (docs/03 §1.2).
          const pricing = resolved.pricing;
          const costUsd = pricing
            ? (ev.usage.input * pricing.input + ev.usage.output * pricing.output +
               (ev.usage.cacheRead ?? 0) * (pricing.cacheRead ?? pricing.input)) / 1_000_000
            : undefined;
          ev = { ...ev, costUsd };
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
      enabledToolLevels: overrides?.enabledToolLevels,
    };

    const handle = runTurn(env, threadId, input);
    this.activeTurns.set(threadId, { handle, threadId });
    this.broadcastActivity(threadId);
    void this.tree.getThread(threadId).then((t) => {
      if (t) void this.tree.updateThread(threadId, { stats: { ...t.stats, turns: t.stats.turns + 1 } });
    });
    // Title generation runs in parallel with the turn (ChatGPT semantics):
    // the list shows a name seconds after the first message, not minutes
    // later when a long agent turn finally completes.
    void this.generateTitle(threadId, input);

    void handle.done.finally(() => {
      this.activeTurns.delete(threadId);
      // Cancel pending approvals belonging to this turn.
      for (const [id, p] of this.pendingApprovals) {
        if (p.turnId === handle.turnId) {
          clearTimeout(p.timer);
          this.pendingApprovals.delete(id);
        }
      }
      this.broadcastActivity(threadId);
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
  // Title generation (docs/03 §1.5, docs/10 §5.3) — fired at turn start from
  // the first user message, in parallel with the turn itself
  // -------------------------------------------------------------------------

  private async setTitle(threadId: string, title: string): Promise<void> {
    await this.tree.updateThread(threadId, { title });
    this.onBroadcast({ type: 'thread.updated', threadId, patch: { title } });
  }

  /**
   * Two-stage titling (OpenWebUI semantics): the list shows a truncated
   * first-message title instantly, then the task model upgrades it. The
   * fallback survives even when the LLM call fails or no provider exists.
   */
  private async generateTitle(threadId: string, input: UserInput): Promise<void> {
    try {
      const thread = await this.tree.getThread(threadId);
      if (!thread || thread.title) return; // title only generated once
      // Empty text with attached context (attach-page-and-send): title from
      // the first attachment's label instead of leaving 未命名会话.
      const excerpt = (input.text.trim() || input.attachedContext?.[0]?.label || '').slice(0, 2000);
      if (!excerpt) return;

      // Stage 1 — instant fallback: first line of the message, truncated.
      const fallback = excerpt.split('\n')[0]!.slice(0, 40);
      await this.setTitle(threadId, fallback);

      // Stage 2 — LLM title via the task model (docs/03 §1.5).
      const { provider, model } = this.providers.resolveTaskModel
        ? await this.providers.resolveTaskModel(threadId)
        : await this.providers.resolve(threadId);
      // maxTokens must leave room for reasoning models (DeepSeek etc.) that
      // spend tokens on reasoning_content BEFORE any text — 30 tokens starved
      // the title to empty. Text output is still ~6 words; cost is negligible.
      const stream = provider.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: `${excerpt}\n\n---\nGenerate a title for this conversation: ≤6 words, user's language, no punctuation, name the task not the tool. Reply with the title only.` }] }],
        tools: [],
        params: { maxTokens: 512 },
        model,
        signal: AbortSignal.timeout(20_000),
      });
      const final = await stream.final();
      const title = final.message
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim()
        .replace(/^["'「]|["'」]$/g, '')
        .slice(0, 60);
      if (!title) return;
      await this.setTitle(threadId, title);
    } catch {
      // Best-effort: the fallback title (if set) remains; errors never surface.
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
        this.broadcastActivity(threadId);
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
      this.broadcastActivity(threadId);
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
        // Branch counters use LOGICAL siblings (turn_context is invisible
        // structure — a fork's branch physically hangs under its own
        // turn_context node); only message nodes can branch.
        const branchable = node.type === 'user_message' || node.type === 'assistant_message';
        const siblings = branchable ? await this.tree.getLogicalSiblings(threadId, node.id) : [];
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
