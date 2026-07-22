/**
 * EngineCore — thread management, turn scheduling, approval RPC bookkeeping,
 * snapshot building (docs/development/architecture.md, docs/development/agent-engine.md). This is the real implementation
 * behind EngineHost.
 */

import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequestPayload,
  ContextBlock,
  InteractionRequestPayload,
  InteractionResponse,
  Op,
  PendingApproval,
  PendingInteraction,
  SnapshotItem,
  SnapshotItemKind,
  ThreadSnapshot,
  TurnOverrides,
  Usage,
  UserInput,
  RunRecoveryState,
  SubmissionBrowserContext,
} from '../messaging/protocol';
import type { PanelotDB } from '../db/schema';
import { ThreadTree, type AppendNodeInput } from '../db/tree';
import { buildSessionContext } from '../db/sessionContext';
import { runTurn, type GatekeeperCheck, type TurnEnv, type TurnHandle } from '../agent/loop';
import { ToolRegistry, validateParams } from '../agent/tool';
import {
  assembleSystemPrompt,
  systemPromptCachePrefix,
  type AssembleOptions,
} from '../prompts/assemble';
import type { ProviderAdapter, GenParams } from '../providers/types';
import type {
  ApprovalRecord,
  CommandReceiptResponse,
  PendingToolExecution,
  ProviderEnvironmentBinding,
  ResolvedRunEnvironment,
  RunEnvironmentSnapshot,
  RunRecord,
  ToolCallPayload,
} from '../db/types';
import { RunRepository } from './runRepository';
import { ApprovalRepository } from './approvalRepository';
import { InteractionRepository } from './interactionRepository';
import {
  CommandReceiptRepository,
  createCommandTransactionContext,
  fingerprintCommandPayload,
  type CommandTransactionContext,
} from './commandReceipts';
import { ThreadActorRegistry } from './threadActor';
import {
  bindToolRegistry,
  captureSkillCatalog,
  captureToolCatalog,
  createRunEnvironmentSnapshot,
  RunEnvironmentSnapshotError,
  verifyRunEnvironmentSnapshot,
} from './runEnvironmentSnapshot';
import type { SkillFrontmatter } from '../skills/parse';

const APPROVAL_TIMEOUT_MS = 5 * 60_000; // docs/development/permissions.md §4
const ENQUEUE_CAPACITY = 8; // docs/development/agent-engine.md §3

function calculateUsageCost(
  usage: Usage,
  pricing: { input: number; output: number; cacheRead?: number },
): number {
  const cacheRead = Math.min(usage.cacheRead ?? 0, usage.input);
  const cacheWrite = Math.min(usage.cacheWrite ?? 0, usage.input - cacheRead);
  const uncachedInput = usage.input - cacheRead - cacheWrite;
  return (
    ((uncachedInput + cacheWrite) * pricing.input +
      cacheRead * (pricing.cacheRead ?? pricing.input) +
      usage.output * pricing.output) /
    1_000_000
  );
}

function filterToolsForModel(
  registry: ToolRegistry,
  capabilities: import('../providers/types').ModelCapabilities | undefined,
): ToolRegistry {
  if (capabilities?.toolUse === false) return new ToolRegistry();
  if (capabilities?.vision !== false || !registry.get('screenshot')) return registry;
  const filtered = new ToolRegistry();
  for (const tool of registry.list()) {
    if (tool.name !== 'screenshot') filtered.register(tool);
  }
  return filtered;
}

/** Resolves the provider/model/params for a thread (preset & overrides). */
export interface ProviderResolver {
  resolve(
    threadId: string,
    overrides?: { connectionId: string; modelId: string },
  ): Promise<{
    provider: ProviderAdapter;
    model: string;
    params: GenParams;
    /** $/Mtok, for cost accounting (docs/development/providers.md §1.2). */
    pricing?: { input: number; output: number; cacheRead?: number };
    modelCapabilities?: import('../providers/types').ModelCapabilities;
    connectionId?: string;
    presetId?: string;
    presetPrompt?: string;
    enabledToolLevels?: ('L0' | 'L1' | 'L2' | 'mcp')[];
    permissionPolicy?: NonNullable<TurnOverrides['permissionPolicy']>;
    activeSkills?: string[];
    promptVersion?: string;
  }>;
  /** Task model for titles (docs/development/providers.md §1.5); falls back to the thread's main model. */
  resolveTaskModel?(
    fallbackThreadId: string,
  ): Promise<{ provider: ProviderAdapter; model: string }>;
  /** Captures only non-secret transport facts plus stable credential references. */
  captureEnvironmentBinding?(connectionId: string): Promise<ProviderEnvironmentBinding>;
  /** Rebuilds an adapter from captured transport facts and current referenced secrets. */
  resolveFromEnvironmentBinding?(binding: ProviderEnvironmentBinding): Promise<ProviderAdapter>;
}

interface ActiveTurn {
  handle: TurnHandle;
  threadId: string;
  runId: string;
}

interface RecoveryExecution {
  abort: AbortController;
  interrupted: boolean;
  done: Promise<void>;
  resolveDone: () => void;
}

interface RecoveredApprovalWait {
  approvalId: string;
  targetTabId?: number;
  cancelRequested: boolean;
}

interface QueuedInput {
  input: UserInput;
  overrides?: TurnOverrides;
  clientId: string;
  submissionId: string;
  runId: string;
}

export interface EngineCoreOptions {
  approvalTimeoutMs?: number;
  recoveryToolTimeoutMs?: number;
}

interface PendingApprovalWaiter {
  threadId: string;
  turnId: string;
  targetTabId?: number;
  request: ApprovalRequestPayload;
  requestedAt: number;
  settle: (
    decision: ApprovalDecision,
    command?: CommandTransactionContext,
  ) => Promise<ApprovalDecision>;
  cleanup: () => void;
}

interface PendingInteractionWaiter {
  threadId: string;
  turnId: string;
  request: InteractionRequestPayload;
  settle: (
    response: InteractionResponse,
    command?: CommandTransactionContext,
  ) => Promise<InteractionResponse>;
  cleanup: () => void;
}

function emitCommandResponse(
  submissionId: string,
  response: CommandReceiptResponse,
  emit: (event: AgentEvent) => void,
): void {
  if (response.type === 'command.ack') {
    emit({ ...response, submissionId });
    return;
  }
  emit({
    ...response,
    type: 'command.rejected',
    submissionId,
    code: response.code as Extract<AgentEvent, { type: 'command.rejected' }>['code'],
  });
}

export class RealEngineCore {
  private tree: ThreadTree;
  private runs: RunRepository;
  private approvals: ApprovalRepository;
  private interactions: InteractionRepository;
  private receipts: CommandReceiptRepository;
  private actors = new ThreadActorRegistry();
  private activeTurns = new Map<string, ActiveTurn>(); // threadId → turn
  private queues = new Map<string, QueuedInput[]>(); // threadId → queued inputs
  private pendingApprovals = new Map<string, PendingApprovalWaiter>();
  private pendingInteractions = new Map<string, PendingInteractionWaiter>();
  private recoveredInteractionsByThread = new Map<string, string>();
  private recoveredApprovalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private recoveredApprovalsByThread = new Map<string, RecoveredApprovalWait>();
  private recoveryExecutions = new Map<string, RecoveryExecution>();
  private deletingThreads = new Set<string>();
  private recoveryIdleWaiters = new Set<() => void>();
  private activityEpoch = new Map<string, number>();
  private readonly approvalTimeoutMs: number;
  private readonly recoveryToolTimeoutMs: number;
  /** Broadcast sink, wired by the host. */
  onBroadcast: (ev: AgentEvent) => void = () => {};
  /** Called after an approval decision to apply its side effects (docs/development/permissions.md §4). */
  onApprovalDecision?: (
    approvalId: string,
    threadId: string,
    tool: string,
    targetOrigin: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  /** Per-turn permission-policy override → gatekeeper thread config (docs/development/permissions.md §1). */
  onPermissionOverride?: (
    threadId: string,
    config: {
      permissionPolicy: NonNullable<TurnOverrides['permissionPolicy']>;
    },
  ) => void;
  /**
   * Slash-command hook (docs/development/skills-plugins.md): "/skill-name …" resolves to a context block
   * carrying the skill body, attached to the user message. Null = plain text.
   */
  resolveSlashCommand?: (text: string) => Promise<ContextBlock | null>;
  onBeforeRun?: () => Promise<void>;
  onInteractionResolved?: (interactionId: string) => void;
  /** Bind browser tools to the submission identity before constructing the turn registry. */
  onTurnBrowserContext?: (
    threadId: string,
    browserContext: SubmissionBrowserContext | undefined,
  ) => Promise<void> | void;
  /** Revalidate the durable target and current safety floor before replaying a prepared tool. */
  onValidateRecoveredTool?: (
    threadId: string,
    pendingTool: PendingToolExecution,
    environment: RunEnvironmentSnapshot,
  ) => Promise<void>;

  constructor(
    private db: PanelotDB,
    /** Fixed registry, or a factory producing a thread-bound registry per turn. */
    private tools:
      ToolRegistry | ((threadId: string, snapshot?: RunEnvironmentSnapshot) => ToolRegistry),
    private gatekeeper: GatekeeperCheck,
    private providers: ProviderResolver,
    private promptOptions: (
      browserContext?: SubmissionBrowserContext,
    ) => Promise<AssembleOptions> = async () => ({}),
    options: EngineCoreOptions = {},
  ) {
    this.tree = new ThreadTree(db);
    this.runs = new RunRepository(db);
    this.approvals = new ApprovalRepository(db);
    this.interactions = new InteractionRepository(db);
    this.receipts = new CommandReceiptRepository(db);
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS;
    this.recoveryToolTimeoutMs = options.recoveryToolTimeoutMs ?? 20_000;
  }

  private toolsFor(threadId: string, snapshot?: RunEnvironmentSnapshot): ToolRegistry {
    return typeof this.tools === 'function' ? this.tools(threadId, snapshot) : this.tools;
  }

  private hasRunningExecution(threadId: string): boolean {
    return this.activeTurns.has(threadId) || this.recoveryExecutions.has(threadId);
  }

  /**
   * A recovered approval/interaction still owns the thread even though there is
   * no in-memory TurnHandle. Starting another run or moving the branch cursor
   * would let two durable runs append to the same conversation path.
   */
  private isThreadBusy(threadId: string): boolean {
    return (
      this.deletingThreads.has(threadId) ||
      this.hasRunningExecution(threadId) ||
      this.recoveredApprovalsByThread.has(threadId) ||
      this.recoveredInteractionsByThread.has(threadId)
    );
  }

  threadIdOf(op: Op): string | null {
    return 'threadId' in op ? (op as { threadId: string }).threadId : null;
  }

  /**
   * Cross-thread activity broadcast (docs/development/ui.md §3.1 sidebar indicators) — the
   * event intentionally carries no top-level threadId so the host's
   * thread-scoped broadcast filter lets it reach every client.
   */
  private broadcastActivity(threadId: string): void {
    const epoch = (this.activityEpoch.get(threadId) ?? 0) + 1;
    this.activityEpoch.set(threadId, epoch);
    void Promise.all([
      this.approvals.pendingCountForThread(threadId),
      this.interactions.pendingCountForThread(threadId),
    ])
      .then(([pendingApprovals, pendingInteractions]) => {
        if (this.activityEpoch.get(threadId) !== epoch) return;
        this.onBroadcast({
          type: 'activity.updated',
          activity: {
            threadId,
            running:
              this.activeTurns.has(threadId) || this.recoveredInteractionsByThread.has(threadId),
            pendingApprovals,
            pendingInteractions,
          },
        });
      })
      .catch(() => undefined);
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
    const requestPayload = Object.fromEntries(
      Object.entries(op).filter(
        ([key]) => key !== 'type' && key !== 'submissionId' && key !== 'clientId',
      ),
    );
    const command = createCommandTransactionContext({
      clientId,
      submissionId: op.submissionId,
      commandType: op.type,
      requestFingerprint: await fingerprintCommandPayload(requestPayload),
    });
    const receipt = await this.receipts.begin(command);
    if (receipt.kind === 'duplicate') {
      if (receipt.response) {
        if (op.type === 'thread.create' && receipt.response.threadId) {
          emit({
            type: 'thread.created',
            submissionId: op.submissionId,
            threadId: receipt.response.threadId,
          });
        }
        if (op.type === 'thread.fork' && receipt.response.threadId) {
          emit({
            type: 'thread.forked',
            submissionId: op.submissionId,
            threadId: op.threadId,
            newThreadId: receipt.response.threadId,
          });
        }
        emitCommandResponse(op.submissionId, receipt.response, emit);
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

    if (op.type === 'thread.delete') this.beginThreadDeletion(op.threadId);

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
      if (!actorThreadId && op.type === 'interaction.response') {
        actorThreadId = (await this.interactions.get(op.interactionId))?.threadId ?? null;
      }
      await this.actors.run(actorThreadId ?? `client:${clientId}`, () =>
        this.dispatchOp(op, capture, clientId, command),
      );
    } catch (error) {
      const committed = await this.receipts.reject(clientId, op.submissionId, {
        type: 'command.rejected',
        code: 'internal',
        message: error instanceof Error ? error.message : String(error),
        threadId: 'threadId' in op ? op.threadId : undefined,
      });
      void this.receipts.prune();
      emitCommandResponse(op.submissionId, committed, emit);
      return;
    }

    let committed: CommandReceiptResponse;
    if (rejection) {
      const response = { type: 'command.rejected' as const, ...rejection };
      committed = await this.receipts.reject(clientId, op.submissionId, response);
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
      committed = await this.receipts.ack(clientId, op.submissionId, response);
    }
    emitCommandResponse(op.submissionId, committed, emit);
    void this.receipts.prune();
  }

  private async dispatchOp(
    op: Op,
    emit: (ev: AgentEvent) => void,
    clientId: string,
    command: CommandTransactionContext,
  ): Promise<void> {
    switch (op.type) {
      case 'thread.create': {
        const thread = await this.receipts.createThreadAndAck(
          clientId,
          op.submissionId,
          {
            preset: op.preset,
            folderId: op.folderId,
          },
          command,
        );
        emit({ type: 'thread.created', submissionId: op.submissionId, threadId: thread.id });
        return;
      }
      case 'thread.delete': {
        await this.deleteThread(op.threadId, command);
        return;
      }
      case 'turn.submit':
        return this.handleSubmit(op, emit, clientId, command);
      case 'turn.fork': {
        // Branch-and-run (docs/development/data-model.md §3.2): reposition leafId to the anchor's
        // parent so the turn's user message appends as a SIBLING branch.
        // Busy threads reject rather than enqueue — a queued fork would
        // reposition the cursor under a moving tree.
        if (this.isThreadBusy(op.threadId)) {
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
            message: 'This turn cannot be steered. Queue the message instead.',
            retryable: false,
          });
          return;
        }
        await active.handle.steer(op.input);
        return;
      }
      case 'turn.enqueue': {
        const thread = await this.tree.getThread(op.threadId);
        if (!thread || this.deletingThreads.has(op.threadId)) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'thread_not_found',
            message: `thread ${op.threadId} not found`,
            retryable: false,
          });
          return;
        }
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
        const run = await this.runs.enqueue(
          {
            threadId: op.threadId,
            clientId,
            submissionId: op.submissionId,
            input: op.input,
            overrides: op.overrides,
          },
          command,
        );
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
        if (!this.isThreadBusy(op.threadId)) void this.drainQueue(op.threadId);
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
        await this.runs.updateQueued(
          op.runId,
          { input: op.input, overrides: op.overrides },
          command,
        );
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
        await this.runs.removeQueued(op.runId, command);
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
        if (this.isThreadBusy(op.threadId)) {
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
        if (this.isThreadBusy(op.threadId)) {
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
          const refreshedRun = await this.runs.get(run.id);
          if (!refreshedRun) throw new Error(`Run ${run.id} disappeared before replay`);
          await this.replayPreparedTool({ ...refreshedRun });
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
        const pending = this.pendingApprovals.get(op.approvalId);
        if (pending) {
          await pending.settle(op.decision, command);
        } else {
          await this.approvals.decide(op.approvalId, op.decision, command);
          this.clearRecoveredApprovalTimer(op.approvalId);
          const recovered = this.recoveredApprovalsByThread.get(record.threadId);
          if (recovered?.approvalId === op.approvalId) {
            await this.continueRecoveredWait(record.threadId);
          } else {
            const continued = await this.continueDecidedApproval(op.approvalId);
            if (!continued) {
              const run = await this.runs.get(record.runId);
              if (run?.state === 'waiting_approval') {
                this.recoveredApprovalsByThread.set(record.threadId, {
                  approvalId: op.approvalId,
                  targetTabId: run.pendingTool?.target?.tabId,
                  cancelRequested: false,
                });
              }
            }
          }
          if (!this.isThreadBusy(record.threadId)) await this.drainQueueNow(record.threadId);
          this.broadcastActivity(record.threadId);
        }
        return;
      }
      case 'interaction.response': {
        await this.resolveInteraction(op.interactionId, op.response, command);
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
        const forked = await this.receipts.forkThreadAndAck(command, source.id, {
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
        if (this.isThreadBusy(op.threadId)) {
          emit({
            type: 'error',
            submissionId: op.submissionId,
            code: 'turn_mismatch',
            message: 'cannot switch branches while a run owns this thread',
            retryable: true,
          });
          return;
        }
        let revision = 0;
        try {
          ({ revision } = await this.receipts.selectBranchAndAck(command, op.threadId, op.nodeId));
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
    clientId: string,
    command: CommandTransactionContext,
  ): Promise<void> {
    if (this.isThreadBusy(op.threadId)) {
      // Busy → auto-enqueue (UI may also enqueue explicitly).
      await this.dispatchOp({ ...op, type: 'turn.enqueue' }, emit, clientId, command);
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

  private beginThreadDeletion(threadId: string): void {
    this.deletingThreads.add(threadId);
    this.activeTurns.get(threadId)?.handle.interrupt();
    const recovery = this.recoveryExecutions.get(threadId);
    if (recovery) {
      recovery.interrupted = true;
      recovery.abort.abort(new DOMException('Thread deletion interrupted recovery.', 'AbortError'));
    }
  }

  private async deleteThread(threadId: string, command: CommandTransactionContext): Promise<void> {
    try {
      const active = this.activeTurns.get(threadId);
      if (active) await active.handle.done;
      const recovery = this.recoveryExecutions.get(threadId);
      if (recovery) await recovery.done;

      const interactionIds = await this.db.interactions
        .where('threadId')
        .equals(threadId)
        .primaryKeys();
      if (command.commandType !== 'thread.delete') {
        throw new Error(`Invalid command transaction for thread deletion: ${command.commandType}`);
      }
      await this.tree.deleteThread(threadId, {
        clientId: command.clientId,
        submissionId: command.submissionId,
        commandType: command.commandType,
        requestFingerprint: command.requestFingerprint,
      });

      this.queues.delete(threadId);
      for (const interactionId of interactionIds) {
        try {
          this.onInteractionResolved?.(interactionId as string);
        } catch {
          // The durable interaction is already deleted; local cleanup remains best-effort.
        }
        try {
          this.pendingInteractions.get(interactionId as string)?.cleanup();
        } catch {
          // The durable interaction is already deleted; local cleanup remains best-effort.
        }
        this.pendingInteractions.delete(interactionId as string);
      }

      for (const [approvalId, pending] of this.pendingApprovals) {
        if (pending.threadId !== threadId) continue;
        try {
          pending.cleanup();
        } catch {
          // The durable approval is already deleted; local cleanup remains best-effort.
        }
        this.pendingApprovals.delete(approvalId);
      }

      const recoveredApproval = this.recoveredApprovalsByThread.get(threadId);
      if (recoveredApproval) this.clearRecoveredApprovalTimer(recoveredApproval.approvalId);
      this.recoveredApprovalsByThread.delete(threadId);
      this.recoveredInteractionsByThread.delete(threadId);
      this.notifyRecoveryIdle();

      this.activityEpoch.delete(threadId);
      this.onBroadcast({ type: 'thread.deleted', threadId });
    } finally {
      this.deletingThreads.delete(threadId);
    }
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
    const existingRun = queuedRunId ? await this.runs.get(queuedRunId) : undefined;
    const recoveringStartedRun = resumeExisting || !!existingRun?.environment;
    if (!recoveringStartedRun) {
      // Sticky per-session permission tier from the composer switch: applied
      // before the turn so every gate check this turn sees it.
      await this.onBeforeRun?.();
      // Slash-command activation is input normalization and must not repeat on resume.
      if (this.resolveSlashCommand && /^\s*\//.test(input.text)) {
        try {
          const block = await this.resolveSlashCommand(input.text);
          if (block)
            input = { ...input, attachedContext: [...(input.attachedContext ?? []), block] };
        } catch {
          /* unresolved command → send as plain text */
        }
      }
    }
    const run =
      existingRun ?? (await this.runs.enqueue({ threadId, input, overrides, ...identity }));
    if (!run) throw new Error(`Run not found: ${queuedRunId}`);

    const persistedEnvironment = run.environment;
    let resolved: Awaited<ReturnType<ProviderResolver['resolve']>>;
    let runEnvironment: RunEnvironmentSnapshot;
    let systemPrompt: string;
    let turnTools: ToolRegistry;
    try {
      if (recoveringStartedRun) {
        runEnvironment = await verifyRunEnvironmentSnapshot(persistedEnvironment, run.input);
        await this.onBeforeRun?.();
        const provider = this.providers.resolveFromEnvironmentBinding
          ? await this.providers.resolveFromEnvironmentBinding(runEnvironment.providerBinding)
          : (
              await this.providers.resolve(threadId, {
                connectionId: runEnvironment.connectionId,
                modelId: runEnvironment.modelId,
              })
            ).provider;
        resolved = {
          provider,
          model: runEnvironment.modelId,
          params: runEnvironment.modelParameters as GenParams,
          connectionId: runEnvironment.connectionId,
          presetId: runEnvironment.presetId,
          presetPrompt: runEnvironment.presetPrompt,
          enabledToolLevels: runEnvironment.enabledToolLevels,
          permissionPolicy: runEnvironment.permissionPolicy,
          activeSkills: runEnvironment.activeSkills,
          promptVersion: runEnvironment.promptVersion,
          modelCapabilities: runEnvironment.modelCapabilities,
          pricing: runEnvironment.pricing,
        };
        systemPrompt = runEnvironment.systemPrompt;
        turnTools =
          runEnvironment.modelCapabilities?.toolUse === false
            ? new ToolRegistry()
            : await bindToolRegistry(this.toolsFor(threadId, runEnvironment), runEnvironment);
      } else {
        resolved = await this.providers.resolve(threadId, overrides?.model);
        const presetSkillIds = [...(resolved.activeSkills ?? [])];
        const presetSkills = (await this.db.skills.bulkGet(presetSkillIds)).filter(
          (skill): skill is NonNullable<typeof skill> => !!skill?.enabled,
        );
        const attachedSkillIds = (input.attachedContext ?? []).flatMap((block) =>
          block.kind === 'skill' && block.sourceRef ? [block.sourceRef] : [],
        );
        const activeSkillIds = [
          ...new Set([...presetSkills.map((skill) => skill.id), ...attachedSkillIds]),
        ];
        const browserContext = input.browserContext;
        const promptOpts = await this.promptOptions(browserContext);
        systemPrompt = assembleSystemPrompt({
          ...promptOpts,
          presetPrompt: resolved.presetPrompt ?? promptOpts.presetPrompt,
          activeSkills: presetSkills.map((skill) => ({ name: skill.name, body: skill.body })),
        });
        const environment: ResolvedRunEnvironment = {
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
          permissionPolicy: overrides?.permissionPolicy ?? resolved.permissionPolicy ?? 'untrusted',
          activeSkills: activeSkillIds,
          promptVersion: resolved.promptVersion ?? 'kernel',
          browserContext,
        };
        turnTools = filterToolsForModel(this.toolsFor(threadId), resolved.modelCapabilities);
        const availableSkillNames = new Set(
          (promptOpts.skillsIndex ?? []).map((entry) => entry.name),
        );
        const skillIndexByName = new Map(
          (promptOpts.skillsIndex ?? []).map((entry) => [entry.name, entry]),
        );
        const indexedSkillRecords = await this.db.skills
          .filter((skill) => skill.enabled && availableSkillNames.has(skill.name))
          .toArray();
        const skillRecords = [
          ...new Map(
            [...indexedSkillRecords, ...presetSkills].map((skill) => [skill.id, skill] as const),
          ).values(),
        ];
        const skillCatalog = await captureSkillCatalog(
          skillRecords.map((skill) => {
            const indexEntry = skillIndexByName.get(skill.name);
            const frontmatter = skill.frontmatter as SkillFrontmatter;
            return {
              id: skill.id,
              name: skill.name,
              body: skill.body,
              description: indexEntry?.description ?? frontmatter.description ?? '',
              sites: indexEntry?.sites,
            };
          }),
        );
        const providerBinding = this.providers.captureEnvironmentBinding
          ? await this.providers.captureEnvironmentBinding(environment.connectionId)
          : {
              kind: 'resolver' as const,
              connectionId: environment.connectionId,
              credentials: [],
            };
        const toolCatalog = await captureToolCatalog(turnTools, environment.enabledToolLevels);
        runEnvironment = await createRunEnvironmentSnapshot({
          environment,
          normalizedInput: input,
          providerBinding,
          systemPrompt,
          skillCatalog,
          toolCatalog,
        });
      }
    } catch (error) {
      await this.runs.transition(run.id, 'failed', {
        error: {
          code: error instanceof RunEnvironmentSnapshotError ? error.code : 'provider_resolution',
          message:
            error instanceof RunEnvironmentSnapshotError
              ? error.message
              : 'The run environment could not be resolved.',
        },
      });
      throw error;
    }
    const browserContext = runEnvironment.browserContext;
    this.onPermissionOverride?.(threadId, {
      permissionPolicy: runEnvironment.permissionPolicy,
    });
    if (!recoveringStartedRun) {
      await this.runs.prepare(run.id, runEnvironment, input, overrides);
    } else if (
      run.state === 'queued' ||
      run.state === 'interrupted' ||
      run.state === 'paused_budget' ||
      run.state === 'paused_uncertain'
    ) {
      await this.runs.transition(run.id, 'preparing', { environment: runEnvironment });
    }
    await this.onTurnBrowserContext?.(threadId, browserContext);

    const env: TurnEnv = {
      tree: this.tree,
      tools: turnTools,
      gatekeeper: this.gatekeeper,
      requestApproval: (turnId, request, pendingTool, toolCallNode, signal) =>
        this.requestApproval(threadId, run.id, turnId, request, pendingTool, toolCallNode, signal),
      requestInteraction: (turnId, itemId, request, pendingTool, toolCallNode, signal) =>
        this.requestInteraction(
          threadId,
          run.id,
          turnId,
          itemId,
          request,
          pendingTool,
          toolCallNode,
          signal,
        ),
      emit: (ev) => {
        if (ev.type === 'token.usage') {
          // Cost from pricing ($/Mtok), if the resolver supplied it (docs/development/providers.md §1.2).
          const pricing = resolved.pricing;
          const costUsd = pricing ? calculateUsageCost(ev.usage, pricing) : undefined;
          ev = { ...ev, costUsd };
          // Accumulate into thread.stats for the session list (docs/development/data-model.md §2.1).
        }
        this.onBroadcast(ev);
      },
      provider: resolved.provider,
      model: resolved.model,
      systemPrompt,
      systemPromptCachePrefix: systemPromptCachePrefix(systemPrompt),
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
        const costUsd = pricing ? calculateUsageCost(usage, pricing) : 0;
        await this.runs.appendAssistantAndCommitUsage(run.id, node, usage, costUsd, state, patch);
      },
      commitUsage: async (usage) => {
        const pricing = resolved.pricing;
        const costUsd = pricing ? calculateUsageCost(usage, pricing) : 0;
        await this.runs.commitUsage(run.id, usage, costUsd);
      },
      activateSkill: async (skillId) => {
        await this.runs.activateSkill(run.id, skillId);
      },
      persistSteer: async (node, attachmentLink, admissionSequence) => {
        await this.runs.acceptSteer(run.id, node, attachmentLink, admissionSequence);
      },
      materializeSteers: async (nodeIds) => {
        await this.runs.materializeSteers(run.id, nodeIds);
      },
      initialPendingSteers: run.pendingSteers?.map((steer, index) => ({
        nodeId: steer.nodeId,
        admissionSequence: steer.admissionSequence ?? index,
      })),
    };

    const handle = runTurn(env, threadId, input, 'user', {
      resumeExisting,
      initialStepCursor: run.stepCursor,
    });
    this.activeTurns.set(threadId, { handle, threadId, runId: run.id });
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
          p.cleanup();
          this.pendingApprovals.delete(id);
        }
      }
      for (const [id, pending] of this.pendingInteractions) {
        if (pending.turnId === handle.turnId) {
          pending.cleanup();
          this.pendingInteractions.delete(id);
        }
      }
      this.broadcastActivity(threadId);
      void this.actors
        .run(threadId, async () => {
          await this.continueRecoveredWait(threadId);
          if (!this.isThreadBusy(threadId)) await this.drainQueueNow(threadId);
        })
        .catch((error: unknown) => {
          this.onBroadcast({
            type: 'error',
            threadId,
            code: 'internal',
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          });
        });
    });
  }

  private async drainQueue(threadId: string): Promise<void> {
    return this.actors.run(threadId, () => this.drainQueueNow(threadId));
  }

  private async drainQueueNow(threadId: string): Promise<void> {
    if (this.isThreadBusy(threadId)) return;
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

  private async assertRecoveryEnvironment(
    run: RunRecord,
  ): Promise<{ snapshot: RunEnvironmentSnapshot; tools: ToolRegistry }> {
    const snapshot = await verifyRunEnvironmentSnapshot(run.environment, run.input);
    if (this.providers.resolveFromEnvironmentBinding) {
      await this.providers.resolveFromEnvironmentBinding(snapshot.providerBinding);
    } else {
      await this.providers.resolve(run.threadId, {
        connectionId: snapshot.connectionId,
        modelId: snapshot.modelId,
      });
    }
    const tools =
      snapshot.modelCapabilities?.toolUse === false
        ? new ToolRegistry()
        : await bindToolRegistry(this.toolsFor(run.threadId, snapshot), snapshot);
    return { snapshot, tools };
  }

  private async rejectUnsupportedRecovery(
    run: RunRecord,
    error: RunEnvironmentSnapshotError,
  ): Promise<void> {
    await this.runs.transition(run.id, 'failed', {
      pendingTool: undefined,
      stopReason: error.code,
      error: { code: error.code, message: error.message },
    });
    this.onBroadcast({
      type: 'error',
      threadId: run.threadId,
      code: 'internal',
      message: error.message,
      retryable: false,
    });
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

  private async continueDecidedApproval(approvalId: string): Promise<boolean> {
    const currentApproval = await this.approvals.get(approvalId);
    if (!currentApproval || this.hasRunningExecution(currentApproval.threadId)) return false;
    const claimed = await this.approvals.claimDecidedContinuation(approvalId);
    if (!claimed) return false;
    const { run, approval } = claimed;
    const decision = approval.decision;
    if (!decision) throw new Error(`Approval ${approval.id} has no decision`);
    await this.onApprovalDecision?.(
      approval.id,
      approval.threadId,
      approval.request.tool,
      approval.request.targetOrigin,
      decision,
    );
    if (
      decision.kind === 'accept' ||
      decision.kind === 'acceptForSession' ||
      decision.kind === 'acceptForSite'
    ) {
      await this.replayPreparedTool(run);
      return true;
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
      return true;
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
    return true;
  }

  private async replayPreparedTool(run: RunRecord): Promise<void> {
    const pending = run.pendingTool;
    if (!pending) {
      await this.runs.transition(run.id, 'failed', {
        error: { code: 'recovery_missing_tool', message: 'Prepared tool call is missing.' },
      });
      return;
    }
    let recoveryTools: ToolRegistry;
    let recoveryEnvironment: RunEnvironmentSnapshot;
    try {
      ({ tools: recoveryTools, snapshot: recoveryEnvironment } =
        await this.assertRecoveryEnvironment(run));
    } catch (error) {
      const snapshotError =
        error instanceof RunEnvironmentSnapshotError
          ? error
          : new RunEnvironmentSnapshotError(
              'environment_snapshot_invalid',
              'The captured run environment can no longer be restored safely.',
            );
      await this.rejectUnsupportedRecovery(run, snapshotError);
      return;
    }
    const tool = recoveryTools.get(pending.toolName);
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

    const abort = new AbortController();
    let resolveRecoveryDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveRecoveryDone = resolve));
    const recoveryExecution: RecoveryExecution = {
      abort,
      interrupted: false,
      done,
      resolveDone: resolveRecoveryDone,
    };
    this.recoveryExecutions.set(run.threadId, recoveryExecution);
    const finishRecoveryExecution = () => {
      if (this.recoveryExecutions.get(run.threadId) === recoveryExecution) {
        this.recoveryExecutions.delete(run.threadId);
      }
      recoveryExecution.resolveDone();
      this.notifyRecoveryIdle();
    };
    const interruptBeforeDispatch = async () => {
      try {
        await this.recordRecoveredToolResult(
          run,
          {
            ok: false,
            content: [
              {
                type: 'text',
                text: 'The recovered browser action was cancelled after manual input before dispatch.',
              },
            ],
            trust: 'trusted',
            provenance: 'user',
          },
          'interrupted',
          { pendingTool: undefined, stopReason: 'manual_operation' },
        );
      } finally {
        finishRecoveryExecution();
      }
    };
    const recoveredApproval = this.recoveredApprovalsByThread.get(run.threadId);
    if (recoveredApproval?.cancelRequested) {
      recoveryExecution.interrupted = true;
      abort.abort(new DOMException('Manual operation cancelled recovery.', 'AbortError'));
    }

    try {
      await this.onValidateRecoveredTool?.(run.threadId, pending, recoveryEnvironment);
    } catch {
      if (recoveryExecution.interrupted) {
        await interruptBeforeDispatch();
        return;
      }
      try {
        await this.recordRecoveredToolResult(
          run,
          {
            ok: false,
            content: [
              {
                type: 'text',
                text: 'The recovered tool target or authorization is no longer valid.',
              },
            ],
            trust: 'trusted',
            provenance: 'tool',
          },
          'streaming_model',
          { pendingTool: undefined },
        );
        await this.resumePersistedRun(run.id);
      } finally {
        finishRecoveryExecution();
      }
      return;
    }

    if (recoveryExecution.interrupted) {
      await interruptBeforeDispatch();
      return;
    }

    try {
      if (run.state !== 'executing_tool') {
        await this.runs.transition(run.id, 'executing_tool', {
          pendingTool: { ...pending, startedAt: Date.now() },
        });
      }
    } catch (error) {
      finishRecoveryExecution();
      throw error;
    }
    let timedOut = false;
    let dispatched = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const execution = Promise.resolve()
      .then(() => {
        if (abort.signal.aborted) throw abort.signal.reason;
        dispatched = true;
        return tool.execute(pending.itemId, validation.params, abort.signal, (update) => {
          if (timedOut) return;
          this.onBroadcast({
            type: 'item.delta',
            threadId: run.threadId,
            itemId: pending.itemId,
            delta: { toolProgress: update },
          });
        });
      })
      .then(
        (result) => ({ kind: 'result' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      );
    const deadline = new Promise<{ kind: 'timeout' }>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        abort.abort(new DOMException('Recovered tool execution timed out.', 'TimeoutError'));
        resolve({ kind: 'timeout' });
      }, this.recoveryToolTimeoutMs);
    });
    const outcome = await Promise.race([execution, deadline]);
    if (timeout !== undefined) clearTimeout(timeout);

    if (recoveryExecution.interrupted) {
      if (outcome.kind === 'timeout') await execution;
      try {
        if (pending.effect === 'write' && dispatched) {
          const updated = await this.runs.transition(run.id, 'paused_uncertain', {
            pendingTool: pending,
            stopReason: 'manual_operation',
            error: {
              code: 'manual_operation',
              message: 'The recovered browser action was interrupted by manual input.',
            },
          });
          this.onBroadcast({
            type: 'run.recovery_required',
            threadId: run.threadId,
            run: this.recoveryState(updated),
          });
        } else {
          await this.recordRecoveredToolResult(
            run,
            {
              ok: false,
              content: [
                {
                  type: 'text',
                  text:
                    pending.effect === 'write'
                      ? 'The recovered browser action was cancelled after manual input before dispatch.'
                      : 'The recovered read was interrupted by manual input.',
                },
              ],
              trust: 'trusted',
              provenance: 'user',
            },
            'interrupted',
            { pendingTool: undefined, stopReason: 'manual_operation' },
          );
        }
      } finally {
        finishRecoveryExecution();
      }
      return;
    }

    if (timedOut || outcome.kind === 'timeout') {
      try {
        const state = pending.effect === 'write' ? 'paused_uncertain' : 'failed';
        const updated = await this.runs.transition(run.id, state, {
          pendingTool: state === 'paused_uncertain' ? pending : undefined,
          stopReason: 'recovery_tool_timeout',
          error: {
            code: 'recovery_tool_timeout',
            message: 'Recovered tool execution exceeded its deadline.',
          },
        });
        if (state === 'paused_uncertain') {
          this.onBroadcast({
            type: 'run.recovery_required',
            threadId: run.threadId,
            run: this.recoveryState(updated),
          });
        } else {
          this.onBroadcast({
            type: 'error',
            threadId: run.threadId,
            code: 'internal',
            message: 'A recovered read tool exceeded its deadline and was failed.',
            retryable: false,
          });
        }
        // Keep the replay caller blocked until an abort-ignoring tool settles;
        // its eventual result is quarantined from persistence.
        await execution;
      } finally {
        finishRecoveryExecution();
      }
      return;
    }

    try {
      if (outcome.kind === 'result') {
        const result = outcome.result;
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
      } else {
        const error = outcome.error;
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
    } finally {
      finishRecoveryExecution();
    }
  }

  private scheduleRecoveredApprovalTimeout(run: RunRecord, approval: ApprovalRecord): void {
    const existing = this.recoveredApprovalTimers.get(approval.id);
    if (existing !== undefined) clearTimeout(existing);
    const previousApproval = this.recoveredApprovalsByThread.get(run.threadId);
    if (previousApproval && previousApproval.approvalId !== approval.id) {
      const previousTimer = this.recoveredApprovalTimers.get(previousApproval.approvalId);
      if (previousTimer !== undefined) clearTimeout(previousTimer);
      this.recoveredApprovalTimers.delete(previousApproval.approvalId);
    }
    this.recoveredApprovalsByThread.set(run.threadId, {
      approvalId: approval.id,
      targetTabId: run.pendingTool?.target?.tabId,
      cancelRequested: false,
    });
    const deadlineAt = approval.deadlineAt ?? approval.requestedAt + this.approvalTimeoutMs;
    const timer = setTimeout(
      () => {
        this.recoveredApprovalTimers.delete(approval.id);
        void this.actors
          .run(run.threadId, async () => {
            const [currentApproval, currentRun] = await Promise.all([
              this.approvals.get(approval.id),
              this.runs.get(run.id),
            ]);
            if (currentApproval?.status !== 'pending' || currentRun?.state !== 'waiting_approval') {
              return;
            }
            await this.approvals.decide(approval.id, {
              kind: 'decline',
              note: 'approval timed out after recovery',
            });
            await this.continueRecoveredWait(run.threadId);
            if (!this.isThreadBusy(run.threadId)) await this.drainQueueNow(run.threadId);
            this.broadcastActivity(run.threadId);
          })
          .catch((error) => {
            this.onBroadcast({
              type: 'error',
              threadId: run.threadId,
              code: 'internal',
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            });
          })
          .finally(() => undefined);
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    this.recoveredApprovalTimers.set(approval.id, timer);
  }

  private finishRecoveredApproval(threadId: string, approvalId: string): void {
    this.clearRecoveredApprovalTimer(approvalId);
    if (this.recoveredApprovalsByThread.get(threadId)?.approvalId === approvalId) {
      this.recoveredApprovalsByThread.delete(threadId);
    }
    this.notifyRecoveryIdle();
  }

  private clearRecoveredApprovalTimer(approvalId: string): void {
    const timer = this.recoveredApprovalTimers.get(approvalId);
    if (timer !== undefined) clearTimeout(timer);
    this.recoveredApprovalTimers.delete(approvalId);
  }

  /**
   * Continue a recovered wait only when no live execution owns the thread. A
   * decided response remains represented by the recovered marker until the
   * continuation is claimed, so an overlapping turn cannot orphan it.
   */
  private async continueRecoveredWait(threadId: string): Promise<boolean> {
    if (this.hasRunningExecution(threadId)) return false;

    const recoveredApproval = this.recoveredApprovalsByThread.get(threadId);
    if (recoveredApproval) {
      const approval = await this.approvals.get(recoveredApproval.approvalId);
      if (approval?.status !== 'decided' || !approval.decision) return false;
      const continued = await this.continueDecidedApproval(approval.id);
      if (continued) this.finishRecoveredApproval(threadId, approval.id);
      return continued;
    }

    const interactionId = this.recoveredInteractionsByThread.get(threadId);
    if (!interactionId) return false;
    const interaction = await this.interactions.get(interactionId);
    if (interaction?.status !== 'resolved' || !interaction.response) return false;
    return this.continueResolvedInteraction(interactionId);
  }

  private recoveryState(run: RunRecord): RunRecoveryState {
    if (
      run.state !== 'waiting_approval' &&
      run.state !== 'waiting_interaction' &&
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
    const restoredApprovals = new Set<string>();
    const restoredInteractions = new Set<string>();
    const rejectedRecoveries = new Set<string>();
    for (const run of recovered) {
      if (run.environment || run.recoveryAction !== 'resume_run') {
        try {
          await this.assertRecoveryEnvironment(run);
        } catch (error) {
          const snapshotError =
            error instanceof RunEnvironmentSnapshotError
              ? error
              : new RunEnvironmentSnapshotError(
                  'environment_snapshot_invalid',
                  'The captured run environment can no longer be restored safely.',
                );
          await this.rejectUnsupportedRecovery(run, snapshotError);
          rejectedRecoveries.add(run.id);
          continue;
        }
      }
      if (run.recoveryAction === 'replay_tool') {
        await this.actors.run(run.threadId, () => this.replayPreparedTool(run));
      } else if (run.recoveryAction === 'restore_approval') {
        const approval = await this.approvals.latestForRun(run.id);
        if (!approval) {
          await this.runs.transition(run.id, 'failed', {
            pendingTool: undefined,
            stopReason: 'recovery_missing_approval',
            error: {
              code: 'recovery_missing_approval',
              message: 'The waiting run has no durable approval record.',
            },
          });
          restoredApprovals.add(run.id);
          this.onBroadcast({
            type: 'error',
            threadId: run.threadId,
            code: 'internal',
            message: 'A waiting approval could not be restored because its record is missing.',
            retryable: false,
          });
          continue;
        }
        if (approval?.status === 'decided' && approval.decision) {
          await this.actors.run(run.threadId, () => this.continueDecidedApproval(approval.id));
          restoredApprovals.add(run.id);
        } else if (
          (approval.deadlineAt ?? approval.requestedAt + this.approvalTimeoutMs) <= Date.now()
        ) {
          await this.actors.run(run.threadId, async () => {
            const current = await this.approvals.get(approval.id);
            if (current?.status === 'pending') {
              await this.approvals.decide(approval.id, {
                kind: 'decline',
                note: 'approval timed out while the background worker was unavailable',
              });
            }
            await this.continueDecidedApproval(approval.id);
          });
          restoredApprovals.add(run.id);
        } else {
          this.scheduleRecoveredApprovalTimeout(run, approval);
          this.onBroadcast({
            type: 'approval.request',
            threadId: approval.threadId,
            turnId: approval.turnId,
            approvalId: approval.id,
            request: approval.request,
          });
          this.broadcastActivity(run.threadId);
          restoredApprovals.add(run.id);
        }
      } else if (run.recoveryAction === 'restore_interaction') {
        const interaction = await this.interactions.latestForRun(run.id);
        if (!interaction) {
          await this.runs.transition(run.id, 'failed', {
            pendingTool: undefined,
            stopReason: 'recovery_missing_interaction',
            error: {
              code: 'recovery_missing_interaction',
              message: 'The waiting run has no durable interaction record.',
            },
          });
          restoredInteractions.add(run.id);
          this.onBroadcast({
            type: 'error',
            threadId: run.threadId,
            code: 'internal',
            message: 'A waiting interaction could not be restored because its record is missing.',
            retryable: false,
          });
          continue;
        }
        if (interaction.status === 'resolved' && interaction.response) {
          await this.actors.run(run.threadId, () =>
            this.continueResolvedInteraction(interaction.id),
          );
        } else {
          this.recoveredInteractionsByThread.set(run.threadId, interaction.id);
          this.onBroadcast({
            type: 'interaction.request',
            threadId: interaction.threadId,
            turnId: interaction.turnId,
            interactionId: interaction.id,
            itemId: interaction.itemId,
            request: interaction.request,
          });
          this.broadcastActivity(run.threadId);
        }
        restoredInteractions.add(run.id);
      }
    }
    const resumableThreads = new Set(
      recovered
        .filter(
          (run) =>
            run.state === 'queued' &&
            run.recoveryAction === 'resume_run' &&
            !rejectedRecoveries.has(run.id),
        )
        .map((run) => run.threadId),
    );
    for (const threadId of resumableThreads) await this.drainQueue(threadId);
    for (const run of recovered) {
      if (run.recoveryAction === 'restore_approval' && !restoredApprovals.has(run.id)) {
        this.broadcastActivity(run.threadId);
      }
      if (run.recoveryAction === 'restore_interaction' && !restoredInteractions.has(run.id)) {
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
  // External pause (manual operation detected — docs/development/browser-tools.md §5)
  // -------------------------------------------------------------------------

  /** Interrupt whatever turn is running on the thread (auto-pause path). */
  async pauseThread(threadId: string, reason: string): Promise<void> {
    const active = this.activeTurns.get(threadId);
    const recovery = this.recoveryExecutions.get(threadId);
    const recoveredApproval = this.recoveredApprovalsByThread.get(threadId);
    if (!active && !recovery && !recoveredApproval) return;
    active?.handle.interrupt();
    if (recoveredApproval) recoveredApproval.cancelRequested = true;
    if (recovery) {
      recovery.interrupted = true;
      recovery.abort.abort(
        new DOMException('Manual operation interrupted recovery.', 'AbortError'),
      );
    }
    if (recoveredApproval) {
      await this.actors.run(threadId, async () => {
        if (this.recoveredApprovalsByThread.get(threadId) !== recoveredApproval) return;
        const approval = await this.approvals.get(recoveredApproval.approvalId);
        const run = approval ? await this.runs.get(approval.runId) : undefined;
        if (approval?.status === 'pending' && run?.state === 'waiting_approval') {
          await this.approvals.decide(recoveredApproval.approvalId, { kind: 'cancel' });
          this.clearRecoveredApprovalTimer(recoveredApproval.approvalId);
          await this.continueRecoveredWait(threadId);
          if (!this.isThreadBusy(threadId)) await this.drainQueueNow(threadId);
          this.broadcastActivity(threadId);
        }
      });
    }
    await this.tree.appendNode(threadId, {
      type: 'system_notice',
      payload: { text: reason, noticeKind: 'paused' },
    });
  }

  /** Threads with a running turn (for routing manual-pause by tab). */
  activeThreadIds(): string[] {
    return [
      ...new Set([
        ...this.activeTurns.keys(),
        ...this.recoveryExecutions.keys(),
        ...this.recoveredApprovalsByThread.keys(),
        ...this.recoveredInteractionsByThread.keys(),
      ]),
    ];
  }

  recoveredApprovalTargetsTab(threadId: string, tabId: number): boolean {
    return this.recoveredApprovalsByThread.get(threadId)?.targetTabId === tabId;
  }

  pendingApprovalTargetsTab(threadId: string, tabId: number): boolean {
    for (const waiter of this.pendingApprovals.values()) {
      if (waiter.threadId === threadId && waiter.targetTabId === tabId) return true;
    }
    return false;
  }

  async waitForAdmissionIdle(): Promise<void> {
    while (
      this.activeTurns.size > 0 ||
      this.recoveryExecutions.size > 0 ||
      this.recoveredApprovalsByThread.size > 0 ||
      this.recoveredInteractionsByThread.size > 0
    ) {
      await Promise.allSettled([...this.activeTurns.values()].map((active) => active.handle.done));
      if (
        this.recoveryExecutions.size > 0 ||
        this.recoveredApprovalsByThread.size > 0 ||
        this.recoveredInteractionsByThread.size > 0
      ) {
        await new Promise<void>((resolve) => this.recoveryIdleWaiters.add(resolve));
      }
    }
  }

  private notifyRecoveryIdle(): void {
    if (
      this.recoveryExecutions.size > 0 ||
      this.recoveredApprovalsByThread.size > 0 ||
      this.recoveredInteractionsByThread.size > 0
    )
      return;
    for (const resolve of this.recoveryIdleWaiters) resolve();
    this.recoveryIdleWaiters.clear();
  }

  // -------------------------------------------------------------------------
  // Title generation (docs/development/providers.md §1.5, docs/development/prompts.md §5.3) — fired at turn start from
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
      const [firstLine = ''] = excerpt.split('\n');
      const fallback = firstLine.slice(0, 40);
      await this.setTitle(threadId, fallback);

      // Stage 2 — LLM title via the task model (docs/development/providers.md §1.5).
      const { provider, model } = this.providers.resolveTaskModel
        ? await this.providers.resolveTaskModel(threadId)
        : await this.providers.resolve(threadId);
      // maxTokens must leave room for reasoning models (DeepSeek etc.) that
      // spend tokens on reasoning_content before any text — 30 tokens starved
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
  // Approval RPC (docs/development/permissions.md §4)
  // -------------------------------------------------------------------------

  private async requestApproval(
    threadId: string,
    runId: string,
    turnId: string,
    request: ApprovalRequestPayload,
    pendingTool: PendingToolExecution,
    toolCallNode: AppendNodeInput,
    signal: AbortSignal,
  ): Promise<ApprovalDecision> {
    const approvalId = crypto.randomUUID();
    const deadlineAt = Date.now() + this.approvalTimeoutMs;
    const { approval: record } = await this.approvals.createPendingWork({
      id: approvalId,
      threadId,
      runId,
      turnId,
      request,
      pendingTool,
      toolCallNode,
      deadlineAt,
    });
    return new Promise<ApprovalDecision>((resolve, reject) => {
      let settlement: Promise<ApprovalDecision> | undefined;
      const onAbort = () => {
        void waiter.settle({ kind: 'cancel' }).catch(() => undefined);
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      };
      const waiter: PendingApprovalWaiter = {
        threadId,
        turnId,
        targetTabId: pendingTool.target?.tabId,
        request,
        requestedAt: record.requestedAt,
        cleanup,
        settle: (proposedDecision, command) => {
          if (settlement) {
            const existingSettlement = settlement;
            if (!command) return existingSettlement;
            return (async () => {
              try {
                return await existingSettlement;
              } finally {
                await this.approvals.decide(approvalId, proposedDecision, command);
              }
            })();
          }
          cleanup();
          settlement = (async () => {
            const decided = await this.approvals.decide(approvalId, proposedDecision, command);
            const decision = decided.decision ?? proposedDecision;
            await this.onApprovalDecision?.(
              approvalId,
              threadId,
              request.tool,
              request.targetOrigin,
              decision,
            );
            resolve(decision);
            return decision;
          })()
            .catch((error) => {
              reject(error);
              throw error;
            })
            .finally(() => {
              if (this.pendingApprovals.get(approvalId) === waiter) {
                this.pendingApprovals.delete(approvalId);
              }
              this.broadcastActivity(threadId);
            });
          return settlement;
        },
      };
      const timer = setTimeout(
        () => {
          // Timeout → decline (docs/development/permissions.md §4).
          const decision: ApprovalDecision = {
            kind: 'decline',
            note: 'approval timed out after 5 minutes',
          };
          void waiter.settle(decision).catch(() => undefined);
        },
        Math.max(0, deadlineAt - Date.now()),
      );
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingApprovals.set(approvalId, waiter);
      this.onBroadcast({ type: 'approval.request', threadId, turnId, approvalId, request });
      this.broadcastActivity(threadId);
      if (signal.aborted) onAbort();
    });
  }

  private async requestInteraction(
    threadId: string,
    runId: string,
    turnId: string,
    itemId: string,
    request: InteractionRequestPayload,
    pendingTool: PendingToolExecution,
    toolCallNode: AppendNodeInput,
    signal: AbortSignal,
  ): Promise<InteractionResponse> {
    const interactionId = crypto.randomUUID();
    const { interaction } = await this.interactions.createPendingWork({
      id: interactionId,
      threadId,
      runId,
      turnId,
      itemId,
      request,
      pendingTool,
      toolCallNode,
    });
    return new Promise<InteractionResponse>((resolve, reject) => {
      let settlement: Promise<InteractionResponse> | undefined;
      const onAbort = () => {
        void waiter.settle({ kind: 'cancel', note: 'turn interrupted' }).catch(() => undefined);
      };
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const waiter: PendingInteractionWaiter = {
        threadId,
        turnId,
        request,
        cleanup,
        settle: (proposedResponse, command) => {
          if (settlement) {
            const existingSettlement = settlement;
            if (!command) return existingSettlement;
            return (async () => {
              try {
                return await existingSettlement;
              } finally {
                await this.interactions.resolve(interactionId, proposedResponse, command);
              }
            })();
          }
          cleanup();
          settlement = this.interactions
            .resolve(interactionId, proposedResponse, command)
            .then((resolved) => {
              const response = resolved.response ?? proposedResponse;
              resolve(response);
              return response;
            })
            .catch((error) => {
              reject(error);
              throw error;
            })
            .finally(() => {
              if (this.pendingInteractions.get(interactionId) === waiter) {
                this.pendingInteractions.delete(interactionId);
              }
              this.onInteractionResolved?.(interactionId);
              this.broadcastActivity(threadId);
            });
          return settlement;
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingInteractions.set(interactionId, waiter);
      this.onBroadcast({
        type: 'interaction.request',
        threadId,
        turnId,
        interactionId,
        itemId,
        request,
      });
      this.broadcastActivity(threadId);
      if (signal.aborted) onAbort();
      void interaction;
    });
  }

  async resolveInteraction(
    interactionId: string,
    response: InteractionResponse,
    command?: CommandTransactionContext,
  ): Promise<void> {
    const record = await this.interactions.get(interactionId);
    if (!record) throw new Error(`interaction ${interactionId} not found`);
    const pending = this.pendingInteractions.get(interactionId);
    if (pending) {
      await pending.settle(response, command);
      return;
    }
    await this.interactions.resolve(interactionId, response, command);
    this.onInteractionResolved?.(interactionId);
    if (this.recoveredInteractionsByThread.get(record.threadId) === interactionId) {
      await this.continueRecoveredWait(record.threadId);
    } else {
      const continued = await this.continueResolvedInteraction(interactionId);
      if (!continued) {
        const run = await this.runs.get(record.runId);
        if (run?.state === 'waiting_interaction') {
          this.recoveredInteractionsByThread.set(record.threadId, interactionId);
        }
      }
    }
    this.broadcastActivity(record.threadId);
  }

  async requestMcpElicitation(
    threadId: string,
    itemId: string,
    request: Extract<InteractionRequestPayload, { kind: 'mcp_elicitation' }>,
  ): Promise<InteractionResponse> {
    const active = this.activeTurns.get(threadId);
    if (!active) throw new Error(`No active turn for MCP elicitation in thread ${threadId}`);
    const run = await this.runs.get(active.runId);
    if (!run?.pendingTool || run.pendingTool.itemId !== itemId) {
      throw new Error('MCP elicitation does not match the active tool call.');
    }
    const nodes = await this.db.nodes.where('threadId').equals(threadId).sortBy('seq');
    let toolCallNode: (typeof nodes)[number] | undefined;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      const payload = node?.payload as ToolCallPayload | undefined;
      if (
        node?.type === 'tool_call' &&
        payload?.itemId === itemId &&
        payload.toolName === run.pendingTool.toolName
      ) {
        toolCallNode = node;
        break;
      }
    }
    if (!toolCallNode) throw new Error('Persisted MCP tool call not found for elicitation.');
    return this.requestInteraction(
      threadId,
      run.id,
      run.turnId,
      itemId,
      request,
      run.pendingTool,
      toolCallNode,
      active.handle.signal,
    );
  }

  private async continueResolvedInteraction(interactionId: string): Promise<boolean> {
    const current = await this.interactions.get(interactionId);
    if (!current || this.hasRunningExecution(current.threadId)) return false;
    const claimed = await this.interactions.claimResolvedContinuation(interactionId);
    if (!claimed) return false;
    this.recoveredInteractionsByThread.delete(claimed.run.threadId);
    this.notifyRecoveryIdle();
    this.onBroadcast({
      type: 'item.complete',
      threadId: claimed.run.threadId,
      itemId: claimed.interaction.itemId,
      result: { ok: true, details: { response: claimed.interaction.response } },
    });
    await this.resumePersistedRun(claimed.run.id);
    return true;
  }

  // -------------------------------------------------------------------------
  // Snapshot (docs/development/architecture.md §3.4)
  // -------------------------------------------------------------------------

  async getSnapshot(threadId: string): Promise<ThreadSnapshot | null> {
    const thread = await this.tree.getThread(threadId);
    if (!thread) return null;

    const { leafId } = await this.tree.validateLeaf(threadId);
    const items: SnapshotItem[] = [];
    if (leafId) {
      const ctx = await buildSessionContext(this.tree, threadId, leafId);
      for (const node of ctx.path) {
        if (node.type === 'interaction_response' || node.type === 'turn_context') continue;
        // This assignment is exhaustive: adding another NodeType fails compilation
        // until its snapshot visibility is decided explicitly.
        const kind: SnapshotItemKind = node.type;
        // Branch counters use LOGICAL siblings (turn_context is invisible
        // structure — a fork's branch physically hangs under its own
        // turn_context node); only message nodes can branch.
        const branchable = node.type === 'user_message' || node.type === 'assistant_message';
        const siblings = branchable ? await this.tree.getLogicalSiblings(threadId, node.id) : [];
        items.push({
          nodeId: node.id,
          kind,
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
    const pendingInteractions: PendingInteraction[] =
      await this.interactions.pendingForThread(threadId);
    const queuedRuns = await this.runs.queuedForThread(threadId);
    const recoverableRuns = await this.runs.recoverableForThread(threadId);

    // Interrupted-mid-turn detection (docs/development/architecture.md §4, docs/development/agent-engine.md §6.2): no live turn
    // but the checkpointed path ends inside a turn → SW was likely killed.
    // The UI offers "continue"; replay from the last checkpoint continues.
    let wasInterrupted = false;
    if (!active && items.length > 0) {
      const last = items.at(-1);
      wasInterrupted = last?.kind === 'tool_call' || last?.kind === 'user_message';
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
      pendingInteractions,
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
