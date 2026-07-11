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
  RunRecoveryState,
} from '../messaging/protocol';
import type { PanelotDB } from '../db/schema';
import { ThreadTree } from '../db/tree';
import { buildSessionContext } from '../db/sessionContext';
import { runTurn, type GatekeeperCheck, type TurnEnv, type TurnHandle } from '../agent/loop';
import { ToolRegistry, validateParams } from '../agent/tool';
import { assembleSystemPrompt, type AssembleOptions } from '../prompts/assemble';
import type { ProviderAdapter, GenParams } from '../providers/types';
import type { ApprovalRecord, ResolvedRunEnvironment, RunRecord } from '../db/types';
import { RunRepository } from './runRepository';
import { ApprovalRepository } from './approvalRepository';
import { CommandReceiptRepository } from './commandReceipts';
import { ThreadActorRegistry } from './threadActor';

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // docs/06 §4
const ENQUEUE_CAPACITY = 8; // docs/04 §3

/** Resolves the provider/model/params for a thread (preset & overrides). */
export interface ProviderResolver {
  resolve(
    threadId: string,
    overrides?: { connectionId: string; modelId: string },
  ): Promise<{
    provider: ProviderAdapter;
    model: string;
    params: GenParams;
    /** $/Mtok, for cost accounting (docs/03 §1.2). */
    pricing?: { input: number; output: number; cacheRead?: number };
    modelCapabilities?: import('../providers/types').ModelCapabilities;
    connectionId?: string;
    presetId?: string;
    presetPrompt?: string;
    enabledToolLevels?: ('L0' | 'L1' | 'L2' | 'mcp')[];
    approvalPolicy?: NonNullable<TurnOverrides['approvalPolicy']>;
    capabilityScope?: NonNullable<TurnOverrides['capabilityScope']>;
    activeSkills?: string[];
    promptVersion?: string;
  }>;
  /** Task model for titles (docs/03 §1.5); falls back to the thread's main model. */
  resolveTaskModel?(
    fallbackThreadId: string,
  ): Promise<{ provider: ProviderAdapter; model: string }>;
}

interface ActiveTurn {
  handle: TurnHandle;
  threadId: string;
}

interface QueuedInput {
  input: UserInput;
  overrides?: TurnOverrides;
  clientId: string;
  submissionId: string;
  runId: string;
}

export class RealEngineCore {
  private tree: ThreadTree;
  private runs: RunRepository;
  private approvals: ApprovalRepository;
  private receipts: CommandReceiptRepository;
  private actors = new ThreadActorRegistry();
  private activeTurns = new Map<string, ActiveTurn>(); // threadId → turn
  private queues = new Map<string, QueuedInput[]>(); // threadId → queued inputs
  private pendingApprovals = new Map<
    string,
    {
      threadId: string;
      turnId: string;
      request: ApprovalRequestPayload;
      requestedAt: number;
      resolve: (d: ApprovalDecision) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Broadcast sink, wired by the host. */
  onBroadcast: (ev: AgentEvent) => void = () => {};
  /** Called after an approval decision to apply its side effects (docs/06 §4). */
  onApprovalDecision?: (
    threadId: string,
    tool: string,
    targetOrigin: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  /** Per-turn approval-policy override → gatekeeper thread config (docs/06 §1). */
  onPermissionOverride?: (
    threadId: string,
    config: {
      approvalPolicy: NonNullable<TurnOverrides['approvalPolicy']>;
      capabilityScope: NonNullable<TurnOverrides['capabilityScope']>;
    },
  ) => void;
  /**
   * Slash-command hook (docs/08): "/skill-name …" resolves to a context block
   * carrying the skill body, attached to the user message. Null = plain text.
   */
  resolveSlashCommand?: (text: string) => Promise<ContextBlock | null>;
  onBeforeRun?: () => Promise<void>;

  constructor(
    private db: PanelotDB,
    /** Fixed registry, or a factory producing a thread-bound registry per turn. */
    private tools: ToolRegistry | ((threadId: string) => ToolRegistry),
    private gatekeeper: GatekeeperCheck,
    private providers: ProviderResolver,
    private promptOptions: () => Promise<AssembleOptions> = async () => ({}),
  ) {
    this.tree = new ThreadTree(db);
    this.runs = new RunRepository(db);
    this.approvals = new ApprovalRepository(db);
    this.receipts = new CommandReceiptRepository(db);
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

  private async broadcastQueue(threadId: string): Promise<void> {
    const queued = await this.runs.queuedForThread(threadId);
    this.onBroadcast({
      type: 'queue.updated',
      threadId,
      pending: queued.length,
      runs: queued.map((run) => ({
        runId: run.id,
        input: run.input,
        overrides: run.overrides,
        revision: run.revision,
      })),
    });
  }

  // -------------------------------------------------------------------------
  // Op dispatch
  // -------------------------------------------------------------------------

  async handleOp(op: Op, emit: (ev: AgentEvent) => void): Promise<void> {
    const clientId = (op as { clientId?: string }).clientId ?? 'unidentified-client';
    const receipt = await this.receipts.begin({
      clientId,
      submissionId: op.submissionId,
      commandType: op.type,
    });
    if (receipt.kind === 'duplicate') {
      if (receipt.response?.type === 'command.rejected') {
        emit({
          type: 'command.rejected',
          submissionId: op.submissionId,
          code: receipt.response.code as Extract<AgentEvent, { type: 'command.rejected' }>['code'],
          message: receipt.response.message,
          threadId: receipt.response.threadId,
          revision: receipt.response.revision,
        });
      } else if (receipt.response) {
        emit({
          ...receipt.response,
          type: 'command.ack',
          submissionId: op.submissionId,
        });
      } else {
        emit({
          type: 'command.rejected',
          submissionId: op.submissionId,
          code: 'internal',
          message: 'The original command is still processing; reconnect and apply a snapshot.',
        });
      }
      return;
    }

    let rejection:
      | { code: Extract<AgentEvent, { type: 'error' }>['code']; message: string; threadId?: string }
      | undefined;
    let responseThreadId: string | undefined;
    const capture = (event: AgentEvent) => {
      if ('submissionId' in event && event.submissionId === op.submissionId) {
        if (event.type === 'error') {
          rejection = {
            code: event.code,
            message: event.message,
            threadId: 'threadId' in op ? op.threadId : undefined,
          };
        } else if (event.type === 'thread.created') {
          responseThreadId = event.threadId;
        } else if (event.type === 'thread.forked') {
          responseThreadId = event.newThreadId;
        }
      }
      emit(event);
    };

    try {
      let actorThreadId = this.threadIdOf(op);
      if (!actorThreadId && op.type === 'approval.response') {
        actorThreadId = (await this.approvals.get(op.approvalId))?.threadId ?? null;
      }
      await this.actors.run(actorThreadId ?? `client:${clientId}`, () =>
        this.dispatchOp(op, capture),
      );
    } catch (error) {
      await this.receipts.reject(clientId, op.submissionId, {
        type: 'command.rejected',
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
        threadId: 'threadId' in op ? op.threadId : undefined,
      });
      throw error;
    }

    if (rejection) {
      const response = { type: 'command.rejected' as const, ...rejection };
      await this.receipts.reject(clientId, op.submissionId, response);
      emit({ type: 'command.rejected', submissionId: op.submissionId, ...rejection });
    } else {
      const run = await this.db.runs
        .where('submissionId')
        .equals(op.submissionId)
        .filter((candidate) => candidate.clientId === clientId)
        .first();
      const response = {
        type: 'command.ack' as const,
        threadId: responseThreadId ?? ('threadId' in op ? op.threadId : undefined),
        runId: run?.id,
        revision: run?.revision,
      };
      await this.receipts.ack(clientId, op.submissionId, response);
      emit({ ...response, submissionId: op.submissionId });
    }
    void this.receipts.prune();
  }

  private async dispatchOp(op: Op, emit: (ev: AgentEvent) => void): Promise<void> {
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
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'turn_mismatch',
            message: 'cannot fork while a turn is active',
            retryable: true,
          });
          return;
        }
        const beforeFork = await this.tree.getThread(op.threadId);
        if (!beforeFork) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'thread_not_found',
            message: `thread ${op.threadId} not found`,
            retryable: false,
          });
          return;
        }
        try {
          await this.tree.repositionLeafForFork(op.threadId, op.siblingOfNodeId);
        } catch (e) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'thread_not_found',
            message: (e as Error).message,
            retryable: false,
          });
          return;
        }
        try {
          await this.startTurn(op.threadId, op.input, op.overrides, {
            clientId: (op as { clientId?: string }).clientId ?? 'unidentified-client',
            submissionId: op.submissionId,
          });
        } catch (error) {
          await this.tree.updateThread(op.threadId, { leafId: beforeFork.leafId });
          throw error;
        }
        return;
      }
      case 'turn.steer': {
        const active = this.activeTurns.get(op.threadId);
        if (!active) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'no_active_turn',
            message: 'no active turn to steer',
            retryable: false,
          });
          return;
        }
        if (active.handle.turnId !== op.expectedTurnId) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'turn_mismatch',
            message: 'expectedTurnId does not match the active turn',
            retryable: false,
          });
          return;
        }
        if (!active.handle.steerable) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'turn_not_steerable',
            message: 'this turn cannot be steered — enqueue instead',
            retryable: false,
          });
          return;
        }
        await active.handle.steer(op.input);
        return;
      }
      case 'turn.enqueue': {
        const queue = this.queues.get(op.threadId) ?? [];
        if ((await this.runs.countQueued(op.threadId)) >= ENQUEUE_CAPACITY) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'queue_full',
            message: `queue is full (${ENQUEUE_CAPACITY})`,
            retryable: true,
          });
          return;
        }
        const clientId = (op as { clientId?: string }).clientId ?? 'unidentified-client';
        const run = await this.runs.enqueue({
          threadId: op.threadId,
          clientId,
          submissionId: op.submissionId,
          input: op.input,
          overrides: op.overrides,
        });
        queue.push({
          input: op.input,
          overrides: op.overrides,
          clientId,
          submissionId: op.submissionId,
          runId: run.id,
        });
        this.queues.set(op.threadId, queue);
        await this.broadcastQueue(op.threadId);
        // If idle, start immediately.
        if (!this.activeTurns.has(op.threadId)) void this.drainQueue(op.threadId);
        return;
      }
      case 'turn.interrupt': {
        this.activeTurns.get(op.threadId)?.handle.interrupt();
        return;
      }
      case 'queue.update': {
        const current = await this.runs.get(op.runId);
        if (!current || current.threadId !== op.threadId) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'invalid_command',
            message: `queued run ${op.runId} not found`,
            retryable: false,
          });
          return;
        }
        await this.runs.updateQueued(op.runId, { input: op.input, overrides: op.overrides });
        const memory = this.queues.get(op.threadId)?.find((item) => item.runId === op.runId);
        if (memory) {
          memory.input = op.input;
          memory.overrides = op.overrides;
        }
        await this.broadcastQueue(op.threadId);
        return;
      }
      case 'queue.remove': {
        const current = await this.runs.get(op.runId);
        if (!current || current.threadId !== op.threadId) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'invalid_command',
            message: `queued run ${op.runId} not found`,
            retryable: false,
          });
          return;
        }
        await this.runs.removeQueued(op.runId);
        const memory = this.queues.get(op.threadId);
        if (memory)
          this.queues.set(
            op.threadId,
            memory.filter((item) => item.runId !== op.runId),
          );
        await this.broadcastQueue(op.threadId);
        return;
      }
      case 'run.resume': {
        const run = await this.runs.get(op.runId);
        if (
          !run ||
          run.threadId !== op.threadId ||
          (run.state !== 'interrupted' && run.state !== 'paused_budget')
        ) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'invalid_command',
            message: `run ${op.runId} cannot be resumed`,
            retryable: false,
          });
          return;
        }
        if (this.activeTurns.has(op.threadId)) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'turn_mismatch',
            message: 'another run is active on this thread',
            retryable: true,
          });
          return;
        }
        await this.startTurn(
          run.threadId,
          run.input,
          run.overrides,
          { clientId: run.clientId, submissionId: run.submissionId },
          run.id,
          true,
        );
        return;
      }
      case 'run.resolveUncertain': {
        const run = await this.runs.get(op.runId);
        if (!run || run.threadId !== op.threadId || run.state !== 'paused_uncertain') {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'invalid_command',
            message: `run ${op.runId} is not waiting for an uncertainty decision`,
            retryable: false,
          });
          return;
        }
        if (this.activeTurns.has(op.threadId)) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'turn_mismatch',
            message: 'another run is active on this thread',
            retryable: true,
          });
          return;
        }
        if (op.resolution === 'fail') {
          await this.runs.transition(run.id, 'failed', {
            stopReason: 'uncertain_tool_failed_by_user',
            error: {
              code: 'uncertain_tool',
              message: 'User marked the uncertain tool execution as failed.',
            },
          });
          return;
        }
        await this.runs.transition(run.id, 'preparing');
        if (op.resolution === 'mark_done') {
          await this.recordRecoveredToolResult(
            run,
            {
              ok: true,
              content: [
                {
                  type: 'text',
                  text: 'The user confirmed that the action completed before recovery.',
                },
              ],
              trust: 'trusted',
              provenance: 'user',
            },
            'streaming_model',
            { pendingTool: undefined },
          );
          await this.resumePersistedRun(run.id);
        } else {
          await this.replayPreparedTool({ ...(await this.runs.get(run.id))! });
        }
        return;
      }
      case 'approval.response': {
        const record = await this.approvals.get(op.approvalId);
        if (!record) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'invalid_command',
            message: `approval ${op.approvalId} not found`,
            retryable: false,
          });
          return;
        }
        const decided = await this.approvals.decide(op.approvalId, op.decision);
        const decision = decided.decision ?? op.decision;
        const pending = this.pendingApprovals.get(op.approvalId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingApprovals.delete(op.approvalId);
          // Persist the decision's side effects (scopeOrigins growth,
          // session/site grants) before resolving so the next check sees them.
          await this.onApprovalDecision?.(
            pending.threadId,
            pending.request.tool,
            pending.request.targetOrigin,
            decision,
          );
          pending.resolve(decision);
          this.broadcastActivity(pending.threadId);
        } else {
          await this.onApprovalDecision?.(
            record.threadId,
            record.request.tool,
            record.request.targetOrigin,
            decision,
          );
          const run = await this.runs.get(record.runId);
          if (run?.state === 'waiting_approval') {
            await this.continueDecidedApproval(run, decided);
          }
          this.broadcastActivity(record.threadId);
        }
        return;
      }
      case 'thread.fork': {
        const source = await this.tree.getThread(op.threadId);
        if (!source) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'thread_not_found',
            message: 'source thread not found',
            retryable: false,
          });
          return;
        }
        const forked = await this.tree.createThread({
          title: `${source.title} (fork)`,
          parentThreadId: source.id,
          preset: source.preset,
        });
        emit({
          type: 'thread.forked',
          submissionId: op.submissionId,
          threadId: op.threadId,
          newThreadId: forked.id,
        });
        return;
      }
      case 'thread.selectBranch': {
        let revision = 0;
        try {
          await this.tree.switchToSibling(op.threadId, op.nodeId);
          revision = (await this.tree.getThread(op.threadId))?.revision ?? 0;
        } catch (e) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'thread_not_found',
            message: (e as Error).message,
            retryable: false,
          });
          return;
        }
        this.onBroadcast({ type: 'thread.updated', threadId: op.threadId, revision, patch: {} });
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
      await this.dispatchOp({ ...op, type: 'turn.enqueue' }, emit);
      return;
    }
    const thread = await this.tree.getThread(op.threadId);
    if (!thread) {
      emit({
        type: 'error',
        submissionId: op.submissionId,
        code: 'thread_not_found',
        message: `thread ${op.threadId} not found`,
        retryable: false,
      });
      return;
    }
    await this.startTurn(op.threadId, op.input, op.overrides, {
      clientId: (op as { clientId?: string }).clientId ?? 'unidentified-client',
      submissionId: op.submissionId,
    });
  }

  private async startTurn(
    threadId: string,
    input: UserInput,
    overrides?: TurnOverrides,
    identity: { clientId: string; submissionId: string } = {
      clientId: 'engine',
      submissionId: crypto.randomUUID(),
    },
    queuedRunId?: string,
    resumeExisting = false,
  ): Promise<void> {
    // Sticky per-session permission tier from the composer switch: applied
    // before the turn so every gate check this turn sees it.
    await this.onBeforeRun?.();
    // Slash-command activation: attach the matched skill body to the message.
    if (this.resolveSlashCommand && /^\s*\//.test(input.text)) {
      try {
        const block = await this.resolveSlashCommand(input.text);
        if (block) input = { ...input, attachedContext: [...(input.attachedContext ?? []), block] };
      } catch {
        /* unresolved command → send as plain text */
      }
    }
    const run = queuedRunId
      ? await this.runs.get(queuedRunId)
      : await this.runs.enqueue({ threadId, input, overrides, ...identity });
    if (!run) throw new Error(`Run not found: ${queuedRunId}`);

    let resolved: Awaited<ReturnType<ProviderResolver['resolve']>>;
    try {
      const persisted = resumeExisting ? run.environment : undefined;
      const base = await this.providers.resolve(
        threadId,
        persisted
          ? { connectionId: persisted.connectionId, modelId: persisted.modelId }
          : overrides?.model,
      );
      resolved = persisted
        ? {
            ...base,
            model: persisted.modelId,
            params: persisted.modelParameters as GenParams,
            connectionId: persisted.connectionId,
            presetId: persisted.presetId,
            presetPrompt: persisted.presetPrompt,
            enabledToolLevels: persisted.enabledToolLevels,
            approvalPolicy: persisted.approvalPolicy,
            capabilityScope: persisted.capabilityScope,
            activeSkills: persisted.activeSkills,
            promptVersion: persisted.promptVersion,
            modelCapabilities: persisted.modelCapabilities,
            pricing: persisted.pricing,
          }
        : base;
    } catch (error) {
      await this.runs.transition(run.id, 'failed', {
        error: {
          code: 'provider_resolution',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
    const presetSkillIds = [...(resolved.activeSkills ?? [])];
    const presetSkills = (await this.db.skills.bulkGet(presetSkillIds)).filter(
      (skill): skill is NonNullable<typeof skill> => !!skill?.enabled,
    );
    const attachedSkillIds = (input.attachedContext ?? [])
      .filter((block) => block.kind === 'skill' && !!block.sourceRef)
      .map((block) => block.sourceRef!);
    const activeSkillIds = [
      ...new Set([...presetSkills.map((skill) => skill.id), ...attachedSkillIds]),
    ];
    const promptOpts = await this.promptOptions();
    const systemPrompt = assembleSystemPrompt({
      ...promptOpts,
      presetPrompt: resolved.presetPrompt ?? promptOpts.presetPrompt,
      activeSkills: presetSkills.map((skill) => ({ name: skill.name, body: skill.body })),
    });
    const runEnvironment: ResolvedRunEnvironment = {
      connectionId: resolved.connectionId ?? overrides?.model?.connectionId ?? '',
      modelId: resolved.model,
      modelParameters: { ...resolved.params },
      modelCapabilities: resolved.modelCapabilities,
      pricing: resolved.pricing,
      presetId: resolved.presetId,
      presetPrompt: resolved.presetPrompt,
      enabledToolLevels: [
        ...(overrides?.enabledToolLevels ??
          resolved.enabledToolLevels ?? ['L0', 'L1', 'L2', 'mcp']),
      ],
      approvalPolicy: overrides?.approvalPolicy ?? resolved.approvalPolicy ?? 'untrusted',
      capabilityScope: overrides?.capabilityScope ?? resolved.capabilityScope ?? 'full',
      activeSkills: activeSkillIds,
      promptVersion: resolved.promptVersion ?? 'kernel',
    };
    this.onPermissionOverride?.(threadId, {
      approvalPolicy: runEnvironment.approvalPolicy,
      capabilityScope: runEnvironment.capabilityScope,
    });
    if (!resumeExisting || run.state === 'queued') {
      await this.runs.prepare(run.id, runEnvironment);
    } else if (
      run.state === 'interrupted' ||
      run.state === 'paused_budget' ||
      run.state === 'paused_uncertain'
    ) {
      await this.runs.transition(run.id, 'preparing', { environment: runEnvironment });
    }

    const env: TurnEnv = {
      tree: this.tree,
      tools: this.toolsFor(threadId),
      gatekeeper: this.gatekeeper,
      requestApproval: (turnId, request) => this.requestApproval(threadId, run.id, turnId, request),
      emit: (ev) => {
        if (ev.type === 'token.usage') {
          // Cost from pricing ($/Mtok), if the resolver supplied it (docs/03 §1.2).
          const pricing = resolved.pricing;
          const costUsd = pricing
            ? (ev.usage.input * pricing.input +
                ev.usage.output * pricing.output +
                (ev.usage.cacheRead ?? 0) * (pricing.cacheRead ?? pricing.input)) /
              1_000_000
            : undefined;
          ev = { ...ev, costUsd };
          // Accumulate into thread.stats for the session list (docs/02 §2.1).
        }
        this.onBroadcast(ev);
      },
      provider: resolved.provider,
      model: resolved.model,
      systemPrompt,
      params: resolved.params,
      enabledToolLevels: runEnvironment.enabledToolLevels,
      turnId: run.turnId,
      runEnvironment,
      setRunState: async (state, patch) => {
        await this.runs.transition(run.id, state, patch);
      },
      appendNodesAndSetRunState: async (nodes, state, patch, attachmentLink) => {
        await this.runs.appendNodesAndTransition(run.id, nodes, state, patch, attachmentLink);
      },
      appendAssistantAndCommitUsage: async (node, usage, state, patch) => {
        const pricing = resolved.pricing;
        const costUsd = pricing
          ? (usage.input * pricing.input +
              usage.output * pricing.output +
              (usage.cacheRead ?? 0) * (pricing.cacheRead ?? pricing.input)) /
            1_000_000
          : 0;
        await this.runs.appendAssistantAndCommitUsage(run.id, node, usage, costUsd, state, patch);
      },
      commitUsage: async (usage) => {
        const pricing = resolved.pricing;
        const costUsd = pricing
          ? (usage.input * pricing.input +
              usage.output * pricing.output +
              (usage.cacheRead ?? 0) * (pricing.cacheRead ?? pricing.input)) /
            1_000_000
          : 0;
        await this.runs.commitUsage(run.id, usage, costUsd);
      },
      activateSkill: async (skillId) => {
        await this.runs.activateSkill(run.id, skillId);
      },
      persistSteer: async (node, attachmentLink) => {
        await this.runs.acceptSteer(run.id, node, attachmentLink);
      },
      materializeSteers: async (nodeIds) => {
        await this.runs.materializeSteers(run.id, nodeIds);
      },
      initialPendingSteerIds: run.pendingSteers?.map((steer) => steer.nodeId),
    };

    const handle = runTurn(env, threadId, input, 'user', {
      resumeExisting,
      initialStepCursor: run.stepCursor,
    });
    this.activeTurns.set(threadId, { handle, threadId });
    this.broadcastActivity(threadId);
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
    return this.actors.run(threadId, () => this.drainQueueNow(threadId));
  }

  private async drainQueueNow(threadId: string): Promise<void> {
    if (this.activeTurns.has(threadId)) return;
    const queue = this.queues.get(threadId);
    const memoryQueued = queue?.shift();
    const durableQueued = memoryQueued ? undefined : await this.runs.nextQueued(threadId);
    const next: QueuedInput | undefined =
      memoryQueued ??
      (durableQueued
        ? {
            input: durableQueued.input,
            overrides: durableQueued.overrides,
            clientId: durableQueued.clientId,
            submissionId: durableQueued.submissionId,
            runId: durableQueued.id,
          }
        : undefined);
    if (!next) return;
    await this.startTurn(
      threadId,
      next.input,
      next.overrides,
      { clientId: next.clientId, submissionId: next.submissionId },
      next.runId,
    );
    await this.broadcastQueue(threadId);
  }

  private async resumePersistedRun(runId: string): Promise<void> {
    const run = await this.runs.get(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    await this.startTurn(
      run.threadId,
      run.input,
      run.overrides,
      { clientId: run.clientId, submissionId: run.submissionId },
      run.id,
      true,
    );
  }

  private async recordRecoveredToolResult(
    run: RunRecord,
    result: {
      ok: boolean;
      content: import('../messaging/protocol').ContentBlock[];
      details?: unknown;
      trust: 'trusted' | 'untrusted';
      provenance: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
    },
    state: import('../db/types').RunState,
    patch: import('./runRepository').RunTransitionPatch = {},
  ): Promise<void> {
    const pending = run.pendingTool;
    if (!pending) throw new Error(`Run ${run.id} has no prepared tool call`);
    await this.runs.appendNodeAndTransition(
      run.id,
      {
        type: 'tool_result',
        payload: {
          itemId: pending.itemId,
          ok: result.ok,
          contentForLlm: result.content,
          details: result.details,
          trust: result.trust,
          provenance: result.provenance,
          origin: pending.target?.origin,
        },
      },
      state,
      patch,
    );
    this.onBroadcast({
      type: 'item.complete',
      threadId: run.threadId,
      itemId: pending.itemId,
      result: { ok: result.ok, details: result.details },
    });
  }

  private async continueDecidedApproval(run: RunRecord, approval: ApprovalRecord): Promise<void> {
    const decision = approval.decision;
    if (!decision) throw new Error(`Approval ${approval.id} has no decision`);
    if (
      decision.kind === 'accept' ||
      decision.kind === 'acceptForSession' ||
      decision.kind === 'acceptForSite'
    ) {
      await this.replayPreparedTool(run);
      return;
    }
    if (decision.kind === 'cancel') {
      await this.recordRecoveredToolResult(
        run,
        {
          ok: false,
          content: [{ type: 'text', text: 'The user cancelled the recovered action.' }],
          trust: 'trusted',
          provenance: 'user',
        },
        'interrupted',
        { pendingTool: undefined, stopReason: 'approval_cancelled' },
      );
      return;
    }
    const note = decision.note ? ` Reason: ${decision.note}` : '';
    await this.recordRecoveredToolResult(
      run,
      {
        ok: false,
        content: [{ type: 'text', text: `The user declined the recovered action.${note}` }],
        trust: 'trusted',
        provenance: 'user',
      },
      'streaming_model',
      { pendingTool: undefined },
    );
    await this.resumePersistedRun(run.id);
  }

  private async replayPreparedTool(run: RunRecord): Promise<void> {
    const pending = run.pendingTool;
    if (!pending) {
      await this.runs.transition(run.id, 'failed', {
        error: { code: 'recovery_missing_tool', message: 'Prepared tool call is missing.' },
      });
      return;
    }
    const tool = this.toolsFor(run.threadId).get(pending.toolName);
    const validation = tool ? validateParams(tool, pending.params) : undefined;
    if (!tool || !validation?.ok) {
      const recoveryError = !tool
        ? `Tool ${pending.toolName} is no longer available.`
        : validation && !validation.ok
          ? validation.error
          : 'Recovered tool parameters are invalid.';
      await this.recordRecoveredToolResult(
        run,
        {
          ok: false,
          content: [
            {
              type: 'text',
              text: recoveryError,
            },
          ],
          trust: 'trusted',
          provenance: 'tool',
        },
        'streaming_model',
        { pendingTool: undefined },
      );
      await this.resumePersistedRun(run.id);
      return;
    }

    if (run.state !== 'executing_tool') {
      await this.runs.transition(run.id, 'executing_tool', {
        pendingTool: { ...pending, startedAt: Date.now() },
      });
    }
    const abort = new AbortController();
    try {
      const result = await tool.execute(pending.itemId, validation.params, abort.signal, (update) =>
        this.onBroadcast({
          type: 'item.delta',
          threadId: run.threadId,
          itemId: pending.itemId,
          delta: { toolProgress: update },
        }),
      );
      await this.recordRecoveredToolResult(
        run,
        {
          ok: true,
          content: result.content,
          details: result.details,
          trust: tool.resultTrust ?? (tool.level === 'builtin' ? 'trusted' : 'untrusted'),
          provenance:
            tool.resultProvenance ??
            (tool.level === 'mcp' ? 'mcp' : tool.level === 'builtin' ? 'tool' : 'page'),
        },
        'streaming_model',
        { pendingTool: undefined },
      );
    } catch (error) {
      await this.recordRecoveredToolResult(
        run,
        {
          ok: false,
          content: [
            {
              type: 'text',
              text: `Recovered tool failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          trust: 'trusted',
          provenance: 'tool',
        },
        'streaming_model',
        { pendingTool: undefined },
      );
    }
    await this.resumePersistedRun(run.id);
  }

  private recoveryState(run: RunRecord): RunRecoveryState {
    if (
      run.state !== 'waiting_approval' &&
      run.state !== 'paused_budget' &&
      run.state !== 'paused_uncertain' &&
      run.state !== 'interrupted'
    ) {
      throw new Error(`Run ${run.id} is not recoverable from ${run.state}`);
    }
    return {
      runId: run.id,
      state: run.state,
      revision: run.revision,
      stopReason: run.stopReason,
      pendingTool: run.pendingTool
        ? {
            toolName: run.pendingTool.toolName,
            params: run.pendingTool.params,
            target: run.pendingTool.target,
            effect: run.pendingTool.effect,
            recovery: run.pendingTool.recovery,
          }
        : undefined,
    };
  }

  async recover(): Promise<void> {
    await this.receipts.recoverIncomplete();
    const recovered = await this.runs.recoverOpenRuns();
    const continuedApprovals = new Set<string>();
    for (const run of recovered) {
      if (run.recoveryAction === 'replay_tool') {
        await this.actors.run(run.threadId, () => this.replayPreparedTool(run));
      } else if (run.recoveryAction === 'restore_approval') {
        const approval = await this.approvals.latestForRun(run.id);
        if (approval?.status === 'decided' && approval.decision) {
          await this.onApprovalDecision?.(
            approval.threadId,
            approval.request.tool,
            approval.request.targetOrigin,
            approval.decision,
          );
          await this.actors.run(run.threadId, () => this.continueDecidedApproval(run, approval));
          continuedApprovals.add(run.id);
        }
      }
    }
    const resumableThreads = new Set(
      recovered
        .filter((run) => run.state === 'queued' && run.recoveryAction === 'resume_run')
        .map((run) => run.threadId),
    );
    for (const threadId of resumableThreads) await this.drainQueue(threadId);
    for (const run of recovered) {
      if (run.recoveryAction === 'restore_approval' && !continuedApprovals.has(run.id)) {
        this.broadcastActivity(run.threadId);
      }
      if (run.recoveryAction === 'request_resolution' || run.recoveryAction === 'request_resume') {
        this.onBroadcast({
          type: 'run.recovery_required',
          threadId: run.threadId,
          run: this.recoveryState(run),
        });
      }
    }
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
    const revision = (await this.tree.getThread(threadId))?.revision ?? 0;
    this.onBroadcast({ type: 'thread.updated', threadId, revision, patch: { title } });
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
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${excerpt}\n\n---\nGenerate a title for this conversation: ≤6 words, user's language, no punctuation, name the task not the tool. Reply with the title only.`,
              },
            ],
          },
        ],
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

  private async requestApproval(
    threadId: string,
    runId: string,
    turnId: string,
    request: ApprovalRequestPayload,
  ): Promise<ApprovalDecision> {
    const approvalId = crypto.randomUUID();
    const record = await this.approvals.create({
      id: approvalId,
      threadId,
      runId,
      turnId,
      request,
    });
    return new Promise<ApprovalDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Timeout → decline (docs/06 §4).
        const decision: ApprovalDecision = {
          kind: 'decline',
          note: 'approval timed out after 5 minutes',
        };
        void this.approvals
          .decide(approvalId, decision)
          .then((record) => resolve(record.decision ?? decision))
          .catch(reject)
          .finally(() => {
            this.pendingApprovals.delete(approvalId);
            this.broadcastActivity(threadId);
          });
      }, APPROVAL_TIMEOUT_MS);
      this.pendingApprovals.set(approvalId, {
        threadId,
        turnId,
        request,
        requestedAt: record.requestedAt,
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
          branch:
            siblings.length > 1
              ? { index: siblings.findIndex((s) => s.id === node.id) + 1, count: siblings.length }
              : undefined,
        });
      }
    }

    const active = this.activeTurns.get(threadId);
    const pendingApprovals: PendingApproval[] = await this.approvals.pendingForThread(threadId);
    const queuedRuns = await this.runs.queuedForThread(threadId);
    const recoverableRuns = await this.runs.recoverableForThread(threadId);

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
        revision: thread.revision,
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
      queuedInputs: queuedRuns.length,
      queuedRuns: queuedRuns.map((run) => ({
        runId: run.id,
        input: run.input,
        overrides: run.overrides,
        revision: run.revision,
      })),
      recoverableRuns: recoverableRuns.map((run) => this.recoveryState(run)),
    };
  }
}
