/**
 * The agent loop (docs/04 §2) — Pi Agent's minimal kernel wrapped in Codex's
 * safety shell. The loop itself stays small: iterate until the model stops
 * calling tools. Optional token budgets and repeated failures are explicit
 * terminal conditions; tool-call count is not. Complexity stays outside it.
 */

import type { ThreadTree } from '../db/tree';
import type { AppendNodeInput } from '../db/tree';
import type {
  PendingToolExecution,
  ResolvedRunEnvironment,
  RunState,
  UserMessagePayload,
} from '../db/types';
import { buildSessionContext } from '../db/sessionContext';
import type {
  UserInput,
  AgentEvent,
  ApprovalRequestPayload,
  ApprovalDecision,
  InteractionRequestPayload,
  InteractionResponse,
  TurnKind,
  StopReason,
  Usage,
} from '../messaging/protocol';
import { interactionResultContent, interactionResultProvenance } from './interaction';
import type { ProviderAdapter, GenParams, ToolSchema } from '../providers/types';
import { isProviderErrorRetryable, ProviderError } from '../providers/types';
import { ActionError } from '../tools/action/errors';
import { validateParams, type AnyAgentTool, type ToolRegistry } from './tool';
import {
  CONSECUTIVE_FAILURE_REMIND,
  CONSECUTIVE_FAILURE_STOP,
  FAILURE_FINALIZATION_NOTICE,
  FAILURE_REMINDER,
  STUCK_REMINDER,
} from '../prompts/kernel';

// ---------------------------------------------------------------------------
// Collaborator interfaces (wired by EngineCore; mockable in tests)
// ---------------------------------------------------------------------------

/** Gatekeeper facade. */
export interface GatekeeperCheck {
  check(
    call: {
      toolName: string;
      params: unknown;
      effects: 'read' | 'write';
      target?: PendingToolExecution['target'];
      phase?: 'initial' | 'dispatch';
      approvedAuthorizationRevision?: string;
    },
    threadId: string,
  ): Promise<
    | { verdict: 'allow' }
    | {
        verdict: 'ask';
        request: ApprovalRequestPayload;
        authorizationRevision?: string;
      }
    | { verdict: 'deny'; reason: string }
  >;
}

/** Engine-initiated approval RPC: resolves when the user (or timeout) decides. */
export type ApprovalRequester = (
  turnId: string,
  request: ApprovalRequestPayload,
  pendingTool: PendingToolExecution,
  toolCallNode: AppendNodeInput,
  signal: AbortSignal,
) => Promise<ApprovalDecision>;

export type InteractionRequester = (
  turnId: string,
  itemId: string,
  request: InteractionRequestPayload,
  pendingTool: PendingToolExecution,
  toolCallNode: AppendNodeInput,
  signal: AbortSignal,
) => Promise<InteractionResponse>;

export interface TurnEnv {
  tree: ThreadTree;
  tools: ToolRegistry;
  gatekeeper: GatekeeperCheck;
  requestApproval: ApprovalRequester;
  requestInteraction?: InteractionRequester;
  emit: (ev: AgentEvent) => void;
  provider: ProviderAdapter;
  model: string;
  systemPrompt: string;
  params: GenParams;
  enabledToolLevels?: readonly ('L0' | 'L1' | 'L2' | 'mcp')[];
  turnId?: string;
  runEnvironment?: ResolvedRunEnvironment;
  setRunState?: (
    state: RunState,
    patch?: {
      pendingTool?: PendingToolExecution;
      stepCursor?: number;
      stopReason?: string;
      error?: { code: string; message: string };
    },
  ) => Promise<void>;
  appendNodesAndSetRunState?: (
    nodes: readonly AppendNodeInput[],
    state: RunState,
    patch?: {
      pendingTool?: PendingToolExecution;
      stepCursor?: number;
      stopReason?: string;
      error?: { code: string; message: string };
    },
    attachmentLink?: { attachmentIds: readonly string[]; nodeId: string },
  ) => Promise<void>;
  appendAssistantAndCommitUsage?: (
    node: AppendNodeInput,
    usage: Usage,
    state: RunState,
    patch?: { stepCursor?: number },
  ) => Promise<void>;
  commitUsage?: (usage: Usage) => Promise<void>;
  activateSkill?: (skillId: string) => Promise<void>;
  persistSteer?: (
    node: AppendNodeInput,
    attachmentLink?: { attachmentIds: readonly string[]; nodeId: string },
    admissionSequence?: number,
  ) => Promise<void>;
  materializeSteers?: (nodeIds: readonly string[]) => Promise<void>;
  initialPendingSteers?: readonly { nodeId: string; admissionSequence: number }[];
  /** Optional hard token budget for the turn (docs/04 §1). */
  tokenBudget?: number;
}

export interface TurnHandle {
  turnId: string;
  turnKind: TurnKind;
  steerable: boolean;
  /** Aborts approvals and nested interactions together with the turn. */
  readonly signal: AbortSignal;
  /** Durably accept a steer message for the next provider request (docs/04 §3). */
  steer(input: UserInput): Promise<void>;
  interrupt(): void;
  done: Promise<StopReason>;
}

const TARGET_IDENTITY_KEYS = ['tabId', 'frameId', 'origin', 'serverId'] as const;
const TARGET_CHANGED_MESSAGE =
  'The tool target changed after the permission check. Inspect the current browser state and issue a fresh tool call; do not reuse the previous approval.';

async function resolveVerifiedDispatchTarget(
  tool: AnyAgentTool,
  params: unknown,
  preparedTarget: PendingToolExecution['target'],
): Promise<PendingToolExecution['target']> {
  if (!tool.resolveTarget) return preparedTarget;
  const currentTarget = await tool.resolveTarget(params as never);
  if (!preparedTarget || !currentTarget) {
    if (preparedTarget !== currentTarget) {
      throw new Error(TARGET_CHANGED_MESSAGE);
    }
    return currentTarget;
  }
  const changed = TARGET_IDENTITY_KEYS.some((key) => preparedTarget[key] !== currentTarget[key]);
  if (changed) {
    throw new Error(TARGET_CHANGED_MESSAGE);
  }
  return currentTarget;
}

function sameApprovalRequest(left: ApprovalRequestPayload, right: ApprovalRequestPayload): boolean {
  return (
    left.tool === right.tool &&
    left.targetOrigin === right.targetOrigin &&
    JSON.stringify(left.params) === JSON.stringify(right.params) &&
    JSON.stringify([...left.flags].sort()) === JSON.stringify([...right.flags].sort())
  );
}

async function assertFinalAuthorization(
  env: TurnEnv,
  threadId: string,
  tool: AnyAgentTool,
  params: unknown,
  preparedTool: PendingToolExecution,
  initialVerdict: Awaited<ReturnType<GatekeeperCheck['check']>>,
): Promise<void> {
  const currentTarget = await resolveVerifiedDispatchTarget(tool, params, preparedTool.target);
  const finalVerdict = await env.gatekeeper.check(
    {
      toolName: tool.name,
      params,
      effects: tool.effects,
      target: currentTarget,
      phase: 'dispatch',
      ...(initialVerdict.verdict === 'ask' && initialVerdict.authorizationRevision
        ? { approvedAuthorizationRevision: initialVerdict.authorizationRevision }
        : {}),
    },
    threadId,
  );
  if (finalVerdict.verdict === 'deny') {
    throw new Error(`Action denied by policy during final authorization: ${finalVerdict.reason}`);
  }
  if (finalVerdict.verdict === 'ask') {
    const legacyEquivalentApproval =
      initialVerdict.verdict === 'ask' &&
      initialVerdict.authorizationRevision === undefined &&
      finalVerdict.authorizationRevision === undefined &&
      !finalVerdict.request.flags.includes('host_permission') &&
      sameApprovalRequest(initialVerdict.request, finalVerdict.request);
    if (!legacyEquivalentApproval) {
      throw new Error(
        'Tool authorization changed before dispatch. Review the current target and approve a fresh tool call.',
      );
    }
  }
}

interface ForcedFinalization {
  stopReason: 'error';
  prompt: string;
}

// ---------------------------------------------------------------------------

export function runTurn(
  env: TurnEnv,
  threadId: string,
  input: UserInput,
  turnKind: TurnKind = 'user',
  options: { resumeExisting?: boolean; initialStepCursor?: number } = {},
): TurnHandle {
  const turnId = env.turnId ?? crypto.randomUUID();
  let acceptingSteer = turnKind === 'user';
  const abort = new AbortController();
  const initialPendingSteers = env.initialPendingSteers ?? [];
  let nextSteerSequence =
    initialPendingSteers.reduce(
      (maximum, steer) => Math.max(maximum, steer.admissionSequence),
      -1,
    ) + 1;
  const steerOverlay: { nodeId: string; sequence: number }[] = initialPendingSteers.map(
    (steer) => ({ nodeId: steer.nodeId, sequence: steer.admissionSequence }),
  );
  const pendingAdmissions = new Map<string, { sequence: number; persistence: Promise<void> }>();
  const pendingSteerNodes = new Map<string, AppendNodeInput>();

  function snapshotSteerOverlay(): { nodeId: string; sequence: number }[] {
    return [...new Map(steerOverlay.map((steer) => [steer.nodeId, steer] as const)).values()].sort(
      (left, right) => left.sequence - right.sequence || left.nodeId.localeCompare(right.nodeId),
    );
  }

  function commitSteerMaterialization(nodeIds: readonly string[]): void {
    const committed = new Set(nodeIds);
    const remaining = steerOverlay.filter((steer) => !committed.has(steer.nodeId));
    steerOverlay.splice(0, steerOverlay.length, ...remaining);
    for (const nodeId of committed) pendingSteerNodes.delete(nodeId);
  }

  async function takeSteerCutoff(): Promise<string[]> {
    const cutoff = new Map(snapshotSteerOverlay().map((steer) => [steer.nodeId, steer.sequence]));
    const admissions = [...pendingAdmissions.entries()];
    const results = await Promise.allSettled(
      admissions.map(([, admission]) => admission.persistence),
    );
    for (let index = 0; index < admissions.length; index++) {
      if (results[index]?.status === 'fulfilled') {
        const entry = admissions[index];
        if (!entry) continue;
        const [nodeId, admission] = entry;
        cutoff.set(nodeId, admission.sequence);
      }
    }
    return [...cutoff.entries()]
      .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
      .map(([nodeId]) => nodeId);
  }

  function steerPayload(steerInput: UserInput): UserMessagePayload {
    return {
      content: [{ type: 'text', text: steerInput.text }],
      attachedContext: steerInput.attachedContext,
      steered: true,
    };
  }

  const handle: TurnHandle = {
    turnId,
    turnKind,
    signal: abort.signal,
    get steerable() {
      return acceptingSteer;
    },
    steer: (steerInput) => {
      if (!acceptingSteer) throw new Error('turn is not steerable');
      const nodeId = crypto.randomUUID();
      const sequence = nextSteerSequence++;
      const node: AppendNodeInput = {
        id: nodeId,
        type: 'user_message',
        payload: steerPayload(steerInput),
      };
      pendingSteerNodes.set(nodeId, node);
      const persist = (
        env.persistSteer
          ? env.persistSteer(
              node,
              steerInput.attachmentIds?.length
                ? { attachmentIds: steerInput.attachmentIds, nodeId }
                : undefined,
              sequence,
            )
          : Promise.resolve()
      ).then(() => {
        steerOverlay.push({ nodeId, sequence });
      });
      pendingAdmissions.set(nodeId, { sequence, persistence: persist });
      void persist.finally(() => pendingAdmissions.delete(nodeId)).catch(() => undefined);
      void persist.catch(() => pendingSteerNodes.delete(nodeId));
      return persist;
    },
    interrupt: () => {
      acceptingSteer = false;
      abort.abort();
    },
    done: execute(),
  };

  async function execute(): Promise<StopReason> {
    let stopReason: StopReason = 'error';
    let steerMaterializationFailed = false;
    let forcedFinalization: ForcedFinalization | undefined;
    const scheduleForcedFinalization = async (
      finalization: ForcedFinalization,
      noticeText: string,
    ): Promise<void> => {
      if (forcedFinalization) return;
      await env.tree.appendNode(threadId, {
        type: 'system_notice',
        payload: { text: noticeText, noticeKind: 'paused' },
      });
      acceptingSteer = false;
      forcedFinalization = finalization;
    };
    try {
      if (!options.resumeExisting) {
        const userNodeId = crypto.randomUUID();
        const initialNodes: AppendNodeInput[] = [
          {
            type: 'turn_context',
            payload: {
              turnId,
              model: {
                connectionId: env.runEnvironment?.connectionId ?? '',
                modelId: env.model,
              },
              permissionPolicy: env.runEnvironment?.permissionPolicy ?? 'untrusted',
              activeSkills: env.runEnvironment?.activeSkills ?? [],
              promptVersion: env.runEnvironment?.promptVersion,
              browserContext: env.runEnvironment?.browserContext,
            },
          },
          {
            id: userNodeId,
            type: 'user_message',
            payload: {
              content: [{ type: 'text', text: input.text }],
              attachedContext: input.attachedContext,
            },
          },
        ];
        if (env.appendNodesAndSetRunState) {
          await env.appendNodesAndSetRunState(
            initialNodes,
            'streaming_model',
            {},
            input.attachmentIds?.length
              ? { attachmentIds: input.attachmentIds, nodeId: userNodeId }
              : undefined,
          );
        } else {
          for (const node of initialNodes) await env.tree.appendNode(threadId, node);
          await env.setRunState?.('streaming_model');
        }
      } else {
        await env.setRunState?.('streaming_model');
      }
      env.emit({ type: 'turn.start', threadId, turnId, turnKind, steerable: acceptingSteer });

      let failureReminderPending = false;
      let stuckReminderPending = false;
      let consecutiveFailures = 0; // circuit breaker (browser-use max_failures)
      let turnTokens = 0;
      let stepCursor = options.initialStepCursor ?? 0;
      // Stuck-loop detection (page-agent reflection pattern): track a rolling
      // window of the last N tool+params fingerprints. If the same call repeats
      // STUCK_REPEAT_THRESHOLD times consecutively, inject a reminder.
      const recentCalls: string[] = [];
      const STUCK_WINDOW = 6;
      const STUCK_REPEAT_THRESHOLD = 3;

      loop: for (;;) {
        if (abort.signal.aborted) {
          stopReason = 'interrupted';
          break;
        }

        const steerCutoff = await takeSteerCutoff();
        if (steerCutoff.length > 0) {
          try {
            if (env.materializeSteers) await env.materializeSteers(steerCutoff);
            else {
              for (const nodeId of steerCutoff) {
                const node = pendingSteerNodes.get(nodeId);
                if (node) await env.tree.appendNode(threadId, node);
              }
            }
            commitSteerMaterialization(steerCutoff);
          } catch (error) {
            steerMaterializationFailed = true;
            throw error;
          }
        }
        if (abort.signal.aborted) {
          stopReason = 'interrupted';
          break;
        }
        const thread = await env.tree.getThread(threadId);
        if (!thread?.leafId) throw new Error(`Thread ${threadId} has no active leaf`);
        const ctx = await buildSessionContext(env.tree, threadId, thread.leafId);
        const messages = [...ctx.messages];
        if (failureReminderPending) {
          messages.push({ role: 'user', content: [{ type: 'text', text: FAILURE_REMINDER }] });
          failureReminderPending = false;
        }
        if (stuckReminderPending) {
          messages.push({ role: 'user', content: [{ type: 'text', text: STUCK_REMINDER }] });
          stuckReminderPending = false;
        }
        if (forcedFinalization) {
          messages.push({
            role: 'user',
            content: [{ type: 'text', text: forcedFinalization.prompt }],
          });
        }
        if (abort.signal.aborted) {
          stopReason = 'interrupted';
          break;
        }

        // ---- one LLM call ----------------------------------------------------
        const itemId = crypto.randomUUID();
        env.emit({
          type: 'item.start',
          threadId,
          turnId,
          itemId,
          kind: 'assistant_message',
          meta: {},
        });

        const toolSchemas: ToolSchema[] = forcedFinalization
          ? []
          : env.tools.schemas(env.enabledToolLevels);
        const stream = env.provider.stream({
          messages,
          system: env.systemPrompt,
          tools: toolSchemas,
          params: env.params,
          model: env.model,
          signal: abort.signal,
        });

        let final;
        try {
          for await (const ev of stream) {
            if (ev.type === 'text')
              env.emit({ type: 'item.delta', threadId, itemId, delta: { text: ev.delta } });
            else if (ev.type === 'reasoning')
              env.emit({ type: 'item.delta', threadId, itemId, delta: { reasoning: ev.delta } });
          }
          final = await stream.final();
        } catch (e) {
          if (abort.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
            stopReason = 'interrupted';
            env.emit({ type: 'item.complete', threadId, itemId, result: { ok: false } });
            break;
          }
          throw e;
        }

        const providerStopReason = final.stopReason;
        if (
          !forcedFinalization &&
          providerStopReason === 'tool_use' &&
          final.toolCalls.length === 0
        ) {
          env.emit({ type: 'item.complete', threadId, itemId, result: { ok: false } });
          throw new ProviderError(
            'protocol',
            'Provider ended with tool_use but returned no tool calls',
            undefined,
            { reason: 'response_format' },
          );
        }

        const assistantNode: AppendNodeInput = {
          type: 'assistant_message',
          payload: {
            content: final.message,
            model: env.model,
            connectionId: env.runEnvironment?.connectionId ?? '',
            reasoning: final.reasoning,
            usage: final.usage,
            providerStopReason,
          },
        };
        const nextStepCursor = ++stepCursor;
        if (env.appendAssistantAndCommitUsage) {
          await env.appendAssistantAndCommitUsage(assistantNode, final.usage, 'streaming_model', {
            stepCursor: nextStepCursor,
          });
        } else {
          await env.tree.appendNode(threadId, assistantNode);
          await env.commitUsage?.(final.usage);
          await env.setRunState?.('streaming_model', { stepCursor: nextStepCursor });
        }
        env.emit({ type: 'item.complete', threadId, itemId, result: { ok: true } });
        turnTokens += final.usage.input + final.usage.output;
        env.emit({ type: 'token.usage', threadId, turnId, usage: final.usage });

        if (forcedFinalization) {
          stopReason = forcedFinalization.stopReason;
          break;
        }

        if (final.toolCalls.length === 0) {
          if (providerStopReason === 'tool_use') {
            throw new ProviderError(
              'protocol',
              'Provider tool calls disappeared before execution',
              undefined,
              { reason: 'response_format' },
            );
          }
          acceptingSteer = false;
          await Promise.allSettled(
            [...pendingAdmissions.values()].map((admission) => admission.persistence),
          );
          if (steerOverlay.length > 0) {
            acceptingSteer = turnKind === 'user';
            continue;
          }
          stopReason = providerStopReason;
          break;
        }

        // Token budget is the ONLY hard gate (docs/04 §1).
        if (env.tokenBudget !== undefined && turnTokens > env.tokenBudget) {
          stopReason = 'budget_pause';
          break;
        }

        // ---- execute tool calls ----------------------------------------------
        for (const [batchOrdinal, call] of final.toolCalls.entries()) {
          if (abort.signal.aborted) {
            stopReason = 'interrupted';
            break loop;
          }
          // A multi-call response may cross the threshold before its remaining
          // calls run. Stop that batch here; single-call rounds are finalized
          // immediately after the batch below.
          if (consecutiveFailures >= CONSECUTIVE_FAILURE_STOP) {
            await scheduleForcedFinalization(
              { stopReason: 'error', prompt: FAILURE_FINALIZATION_NOTICE },
              `连续 ${CONSECUTIVE_FAILURE_STOP} 次工具调用失败，已停止继续操作并生成结果说明。`,
            );
            continue loop;
          }

          const callItemId = call.id;

          const tool = env.tools.get(call.name);

          const toolCallNode: AppendNodeInput = {
            id: `tool-call:${turnId}:${nextStepCursor}:${batchOrdinal}`,
            type: 'tool_call',
            payload: {
              itemId: callItemId,
              toolName: call.name,
              params: call.params,
              level: tool?.level ?? 'builtin',
            },
          };
          let toolCallPersisted = false;

          env.emit({
            type: 'item.start',
            threadId,
            turnId,
            itemId: callItemId,
            kind: 'tool_call',
            meta: { toolName: call.name, label: tool?.label ?? call.name, level: tool?.level },
          });
          const persistPreparedToolCall = async (
            state: 'waiting_approval' | 'waiting_interaction' | 'executing_tool',
            pendingTool: PendingToolExecution,
          ) => {
            if (toolCallPersisted) return;
            if (env.appendNodesAndSetRunState) {
              await env.appendNodesAndSetRunState([toolCallNode], state, { pendingTool });
            } else {
              await env.tree.appendNode(threadId, toolCallNode);
              await env.setRunState?.(state, { pendingTool });
            }
            toolCallPersisted = true;
          };

          // countsAsFailure=false for user declines / policy denies: those are
          // deliberate "no", not a broken tool. Counting them would let 5
          // declines (or a `never` policy) kill an otherwise-fine turn.
          const fail = async (
            error: string,
            countsAsFailure = true,
            state: RunState = 'streaming_model',
          ) => {
            const resultNode: AppendNodeInput = {
              type: 'tool_result',
              payload: {
                itemId: callItemId,
                ok: false,
                contentForLlm: [{ type: 'text', text: error }],
              },
            };
            if (env.appendNodesAndSetRunState) {
              await env.appendNodesAndSetRunState(
                toolCallPersisted ? [resultNode] : [toolCallNode, resultNode],
                state,
                {
                  pendingTool: undefined,
                },
              );
            } else {
              if (!toolCallPersisted) {
                await env.tree.appendNode(threadId, toolCallNode);
                toolCallPersisted = true;
              }
              await env.tree.appendNode(threadId, resultNode);
              await env.setRunState?.(state, {
                pendingTool: undefined,
              });
            }
            env.emit({
              type: 'item.complete',
              threadId,
              itemId: callItemId,
              result: { ok: false },
            });
            if (!countsAsFailure) return;
            // Circuit breaker: 3 consecutive failures → one-shot reminder to
            // change approach; 5 → stop the turn instead of looping forever.
            consecutiveFailures++;
            if (consecutiveFailures === CONSECUTIVE_FAILURE_REMIND) failureReminderPending = true;
          };

          if (call.parseError) {
            await fail(call.parseError);
            continue;
          }
          if (!tool) {
            await fail(`Unknown tool: ${call.name}`);
            continue;
          }
          const validation = validateParams(tool, call.params);
          if (!validation.ok) {
            await fail(validation.error);
            continue;
          }
          let preparedTool: PendingToolExecution;
          try {
            preparedTool = {
              itemId: callItemId,
              toolName: call.name,
              params: validation.params,
              target: await tool.resolveTarget?.(validation.params as never),
              effect: tool.effects,
              recovery: tool.recovery,
            };
          } catch (error) {
            await fail(error instanceof Error ? error.message : String(error));
            continue;
          }

          // Gatekeeper — the single interception point (docs/06 §2).
          const verdictResult = await env.gatekeeper.check(
            {
              toolName: call.name,
              params: validation.params,
              effects: tool.effects,
              target: preparedTool.target,
              phase: 'initial',
            },
            threadId,
          );
          if (verdictResult.verdict === 'deny') {
            await fail(`Action denied by policy: ${verdictResult.reason}`, false);
            continue;
          }
          const approvalWasRequired = verdictResult.verdict === 'ask';
          if (approvalWasRequired) {
            const decision = await env.requestApproval(
              turnId,
              verdictResult.request,
              preparedTool,
              toolCallNode,
              abort.signal,
            );
            toolCallPersisted = true;
            if (decision.kind === 'decline' || decision.kind === 'cancel') {
              const note =
                decision.kind === 'decline' && decision.note ? ` User said: ${decision.note}` : '';
              await fail(
                `The user declined this action.${note} Do not retry it verbatim — adapt or ask.`,
                false,
                'streaming_model',
              );
              if (decision.kind === 'cancel') {
                stopReason = 'interrupted';
                break loop;
              }
              continue;
            }
          }

          if (tool.interaction) {
            if (final.toolCalls.length !== 1) {
              await fail(
                `${tool.name} must be the only tool call in its model response. Ask or wait first, then plan subsequent actions from the result.`,
              );
              continue;
            }
            if (!tool.prepareInteraction) {
              await fail(`Interactive tool ${tool.name} has no request builder.`);
              continue;
            }
            if (!env.requestInteraction) {
              await fail('The engine interaction runtime is unavailable.');
              continue;
            }
            const request = await tool.prepareInteraction(validation.params as never);
            try {
              await assertFinalAuthorization(
                env,
                threadId,
                tool,
                validation.params,
                preparedTool,
                verdictResult,
              );
            } catch (error) {
              await fail(error instanceof Error ? error.message : String(error));
              continue;
            }
            const response = await env.requestInteraction(
              turnId,
              callItemId,
              request,
              preparedTool,
              toolCallNode,
              abort.signal,
            );
            toolCallPersisted = true;
            if (abort.signal.aborted) {
              stopReason = 'interrupted';
              await fail('interrupted', false, 'streaming_model');
              break loop;
            }
            const resultNode: AppendNodeInput = {
              type: 'tool_result',
              payload: {
                itemId: callItemId,
                ok: true,
                contentForLlm: interactionResultContent(response),
                details: { response },
                trust: 'trusted',
                provenance: interactionResultProvenance(request),
              },
            };
            if (env.appendNodesAndSetRunState) {
              await env.appendNodesAndSetRunState([resultNode], 'streaming_model', {
                pendingTool: undefined,
              });
            } else {
              await env.tree.appendNode(threadId, resultNode);
              await env.setRunState?.('streaming_model', { pendingTool: undefined });
            }
            env.emit({
              type: 'item.complete',
              threadId,
              itemId: callItemId,
              result: { ok: true, details: { response } },
            });
            consecutiveFailures = 0;
            continue;
          }

          if (abort.signal.aborted) {
            stopReason = 'interrupted';
            await fail('interrupted', false, 'streaming_model');
            break loop;
          }

          try {
            await assertFinalAuthorization(
              env,
              threadId,
              tool,
              validation.params,
              preparedTool,
              verdictResult,
            );
            const executingTool = { ...preparedTool, startedAt: Date.now() };
            if (toolCallPersisted) {
              await env.setRunState?.('executing_tool', { pendingTool: executingTool });
            } else {
              await persistPreparedToolCall('executing_tool', executingTool);
            }
            const result = await tool.execute(
              callItemId,
              validation.params as never,
              abort.signal,
              (partial) =>
                env.emit({
                  type: 'item.delta',
                  threadId,
                  itemId: callItemId,
                  delta: { toolProgress: partial },
                }),
            );
            const activeSkill = (result.details as { activeSkillId?: unknown } | undefined)
              ?.activeSkillId;
            if (typeof activeSkill === 'string') await env.activateSkill?.(activeSkill);
            const resultNode: AppendNodeInput = {
              type: 'tool_result',
              payload: {
                itemId: callItemId,
                ok: true,
                contentForLlm: result.content,
                details: result.details,
                trust: tool.resultTrust,
                provenance: tool.resultProvenance,
                origin: preparedTool.target?.origin,
              },
            };
            if (env.appendNodesAndSetRunState) {
              await env.appendNodesAndSetRunState([resultNode], 'streaming_model', {
                pendingTool: undefined,
              });
            } else {
              await env.tree.appendNode(threadId, resultNode);
              await env.setRunState?.('streaming_model', { pendingTool: undefined });
            }
            env.emit({
              type: 'item.complete',
              threadId,
              itemId: callItemId,
              result: { ok: true, details: result.details },
            });
            consecutiveFailures = 0;
            // Stuck-loop detection (page-agent reflection pattern): fingerprint
            // every successful call. If the same tool+params hash appears
            // STUCK_REPEAT_THRESHOLD times in the last STUCK_WINDOW calls,
            // queue a reminder so the model reassesses before the next LLM call.
            const fp = `${call.name}:${JSON.stringify(call.params)}`;
            recentCalls.push(fp);
            if (recentCalls.length > STUCK_WINDOW) recentCalls.shift();
            const repeats = recentCalls.filter((x) => x === fp).length;
            if (repeats >= STUCK_REPEAT_THRESHOLD && !stuckReminderPending) {
              stuckReminderPending = true;
            }
          } catch (e) {
            if (abort.signal.aborted) {
              stopReason = 'interrupted';
              await fail('interrupted', false, 'streaming_model');
              break loop;
            }
            const escalationName =
              e instanceof ActionError && typeof e.failure.details?.escalationTool === 'string'
                ? e.failure.details.escalationTool
                : undefined;
            const escalationTool = escalationName ? env.tools.get(escalationName) : undefined;
            if (escalationTool) {
              const escalationValidation = validateParams(escalationTool, call.params);
              if (!escalationValidation.ok) {
                await fail(escalationValidation.error);
                continue;
              }
              const escalationTarget = await escalationTool.resolveTarget?.(
                escalationValidation.params as never,
              );
              const escalationPreparedTool: PendingToolExecution = {
                itemId: callItemId,
                toolName: escalationTool.name,
                params: escalationValidation.params,
                target: escalationTarget,
                effect: escalationTool.effects,
                recovery: escalationTool.recovery,
              };
              const escalationToolCallNode: AppendNodeInput = {
                id: `${toolCallNode.id}:escalation:${escalationTool.name}`,
                type: 'tool_call',
                payload: {
                  itemId: callItemId,
                  toolName: escalationTool.name,
                  params: escalationValidation.params,
                  level: escalationTool.level,
                },
              };
              let escalationToolCallPersisted = false;
              const escalationVerdict = await env.gatekeeper.check(
                {
                  toolName: escalationTool.name,
                  params: escalationValidation.params,
                  effects: escalationTool.effects,
                  target: escalationTarget,
                  phase: 'initial',
                },
                threadId,
              );
              if (escalationVerdict.verdict === 'deny') {
                await fail(`L2 escalation denied by policy: ${escalationVerdict.reason}`, false);
                continue;
              }
              if (escalationVerdict.verdict === 'ask') {
                const decision = await env.requestApproval(
                  turnId,
                  escalationVerdict.request,
                  escalationPreparedTool,
                  escalationToolCallNode,
                  abort.signal,
                );
                escalationToolCallPersisted = true;
                if (decision.kind === 'decline' || decision.kind === 'cancel') {
                  await fail('The user declined the trusted-input escalation.', false);
                  if (decision.kind === 'cancel') {
                    stopReason = 'interrupted';
                    break loop;
                  }
                  continue;
                }
              }
              if (abort.signal.aborted) {
                stopReason = 'interrupted';
                await fail('interrupted', false, 'streaming_model');
                break loop;
              }
              try {
                await assertFinalAuthorization(
                  env,
                  threadId,
                  escalationTool,
                  escalationValidation.params,
                  escalationPreparedTool,
                  escalationVerdict,
                );
                const executingEscalation = {
                  ...escalationPreparedTool,
                  startedAt: Date.now(),
                };
                if (escalationToolCallPersisted) {
                  await env.setRunState?.('executing_tool', {
                    pendingTool: executingEscalation,
                  });
                } else if (env.appendNodesAndSetRunState) {
                  await env.appendNodesAndSetRunState([escalationToolCallNode], 'executing_tool', {
                    pendingTool: executingEscalation,
                  });
                  escalationToolCallPersisted = true;
                } else {
                  await env.tree.appendNode(threadId, escalationToolCallNode);
                  await env.setRunState?.('executing_tool', {
                    pendingTool: executingEscalation,
                  });
                  escalationToolCallPersisted = true;
                }
                const escalated = await escalationTool.execute(
                  callItemId,
                  escalationValidation.params as never,
                  abort.signal,
                );
                const escalationDetails = {
                  ...(escalated.details && typeof escalated.details === 'object'
                    ? escalated.details
                    : {}),
                  escalatedFrom: call.name,
                  escalatedTo: escalationTool.name,
                };
                const resultNode: AppendNodeInput = {
                  type: 'tool_result',
                  payload: {
                    itemId: callItemId,
                    ok: true,
                    contentForLlm: escalated.content,
                    details: escalationDetails,
                    trust: escalationTool.resultTrust,
                    provenance: escalationTool.resultProvenance,
                    origin: escalationTarget?.origin,
                  },
                };
                if (env.appendNodesAndSetRunState) {
                  await env.appendNodesAndSetRunState([resultNode], 'streaming_model', {
                    pendingTool: undefined,
                  });
                } else {
                  await env.tree.appendNode(threadId, resultNode);
                  await env.setRunState?.('streaming_model', { pendingTool: undefined });
                }
                env.emit({
                  type: 'item.complete',
                  threadId,
                  itemId: callItemId,
                  result: { ok: true, details: escalationDetails },
                });
                consecutiveFailures = 0;
                continue;
              } catch (escalationError) {
                await fail(
                  `Trusted-input escalation failed: ${escalationError instanceof Error ? escalationError.message : String(escalationError)}`,
                );
                continue;
              }
            }
            // Tool errors go back to the model for self-correction (docs/04 §2).
            await fail(`Tool failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_STOP) {
          await scheduleForcedFinalization(
            { stopReason: 'error', prompt: FAILURE_FINALIZATION_NOTICE },
            `连续 ${CONSECUTIVE_FAILURE_STOP} 次工具调用失败，已停止继续操作并生成结果说明。`,
          );
        }
      }
    } catch (e) {
      stopReason = forcedFinalization?.stopReason ?? 'error';
      env.emit({
        type: 'error',
        threadId,
        code: e instanceof ProviderError ? 'provider_error' : 'internal',
        message: e instanceof Error ? e.message : String(e),
        retryable:
          (e instanceof ProviderError && isProviderErrorRetryable(e)) || steerMaterializationFailed,
        ...(e instanceof ProviderError ? { errorKind: e.kind, providerDetails: e.details } : {}),
      });
    }
    // turn.complete fires only after all writes above have resolved — every
    // appendNode is awaited, so reaching this line IS the ack (docs/04 §2).
    if (steerMaterializationFailed) stopReason = 'interrupted';
    let terminalState: RunState =
      stopReason === 'end' || stopReason === 'max_tokens' || stopReason === 'content_filter'
        ? 'completed'
        : stopReason === 'interrupted'
          ? 'interrupted'
          : stopReason === 'budget_pause'
            ? 'paused_budget'
            : 'failed';
    acceptingSteer = false;
    await Promise.allSettled(
      [...pendingAdmissions.values()].map((admission) => admission.persistence),
    );
    const undeliveredSteers = snapshotSteerOverlay().map((steer) => steer.nodeId);
    if (undeliveredSteers.length > 0 && !steerMaterializationFailed) {
      try {
        if (env.materializeSteers) await env.materializeSteers(undeliveredSteers);
        else {
          for (const nodeId of undeliveredSteers) {
            const node = pendingSteerNodes.get(nodeId);
            if (node) await env.tree.appendNode(threadId, node);
          }
        }
        commitSteerMaterialization(undeliveredSteers);
      } catch (error) {
        steerMaterializationFailed = true;
        stopReason = 'interrupted';
        terminalState = 'interrupted';
        env.emit({
          type: 'error',
          threadId,
          code: 'internal',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
    }
    await env.setRunState?.(terminalState, { stopReason });
    env.emit({ type: 'turn.complete', threadId, turnId, stopReason });
    return stopReason;
  }

  return handle;
}
