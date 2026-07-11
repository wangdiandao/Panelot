/**
 * The agent loop (docs/04 §2) — Pi Agent's minimal kernel wrapped in Codex's
 * safety shell. The loop itself stays small: iterate until the model stops
 * calling tools. Steps are a soft reminder (25 calls → notice), token budget
 * is the only hard gate. All complexity lives outside (Gatekeeper, UI).
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
  TurnKind,
  StopReason,
  Usage,
} from '../messaging/protocol';
import type { ProviderAdapter, GenParams, ToolSchema } from '../providers/types';
import { ProviderError } from '../providers/types';
import { validateParams, type ToolRegistry } from './tool';
import {
  CONSECUTIVE_FAILURE_REMIND,
  CONSECUTIVE_FAILURE_STOP,
  FAILURE_REMINDER,
  HARD_STEP_LIMIT,
  HARD_STEP_NOTICE,
  STEP_REMINDER,
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
    },
    threadId: string,
  ): Promise<
    | { verdict: 'allow' }
    | { verdict: 'ask'; request: ApprovalRequestPayload }
    | { verdict: 'deny'; reason: string }
  >;
}

/** Engine-initiated approval RPC: resolves when the user (or timeout) decides. */
export type ApprovalRequester = (
  turnId: string,
  request: ApprovalRequestPayload,
) => Promise<ApprovalDecision>;

export interface TurnEnv {
  tree: ThreadTree;
  tools: ToolRegistry;
  gatekeeper: GatekeeperCheck;
  requestApproval: ApprovalRequester;
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
  /** Durably accept a steer message for the next provider request (docs/04 §3). */
  steer(input: UserInput): Promise<void>;
  interrupt(): void;
  done: Promise<StopReason>;
}

const SOFT_STEP_LIMIT = 25;

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
  const pendingAdmissions = new Map<
    string,
    { sequence: number; persistence: Promise<void> }
  >();
  const pendingSteerNodes = new Map<string, AppendNodeInput>();

  function snapshotSteerOverlay(): { nodeId: string; sequence: number }[] {
    return [
      ...new Map(
        steerOverlay.map((steer) => [steer.nodeId, steer] as const),
      ).values(),
    ].sort(
      (left, right) =>
        left.sequence - right.sequence || left.nodeId.localeCompare(right.nodeId),
    );
  }

  function commitSteerMaterialization(nodeIds: readonly string[]): void {
    const committed = new Set(nodeIds);
    const remaining = steerOverlay.filter((steer) => !committed.has(steer.nodeId));
    steerOverlay.splice(0, steerOverlay.length, ...remaining);
    for (const nodeId of committed) pendingSteerNodes.delete(nodeId);
  }

  async function takeSteerCutoff(): Promise<string[]> {
    const cutoff = new Map(
      snapshotSteerOverlay().map((steer) => [steer.nodeId, steer.sequence]),
    );
    const admissions = [...pendingAdmissions.entries()];
    const results = await Promise.allSettled(
      admissions.map(([, admission]) => admission.persistence),
    );
    for (let index = 0; index < admissions.length; index++) {
      if (results[index]?.status === 'fulfilled') {
        const [nodeId, admission] = admissions[index]!;
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
      const persist = (env.persistSteer
        ? env.persistSteer(
            node,
            steerInput.attachmentIds?.length
              ? { attachmentIds: steerInput.attachmentIds, nodeId }
              : undefined,
            sequence,
          )
        : Promise.resolve()).then(() => {
        steerOverlay.push({ nodeId, sequence });
      });
      pendingAdmissions.set(nodeId, { sequence, persistence: persist });
      void persist
        .finally(() => pendingAdmissions.delete(nodeId))
        .catch(() => undefined);
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
    let stopReason: StopReason = 'done';
    let steerMaterializationFailed = false;
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
              approvalPolicy: env.runEnvironment?.approvalPolicy ?? 'untrusted',
              capabilityScope: env.runEnvironment?.capabilityScope ?? 'full',
              activeSkills: env.runEnvironment?.activeSkills ?? [],
              promptVersion: env.runEnvironment?.promptVersion,
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

      let toolCallCount = 0;
      let stepReminderPending = false;
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
        const ctx = await buildSessionContext(env.tree, threadId, thread!.leafId!);
        const messages = [...ctx.messages];
        if (stepReminderPending) {
          messages.push({ role: 'user', content: [{ type: 'text', text: STEP_REMINDER }] });
          stepReminderPending = false;
        }
        if (failureReminderPending) {
          messages.push({ role: 'user', content: [{ type: 'text', text: FAILURE_REMINDER }] });
          failureReminderPending = false;
        }
        if (stuckReminderPending) {
          messages.push({ role: 'user', content: [{ type: 'text', text: STUCK_REMINDER }] });
          stuckReminderPending = false;
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

        const toolSchemas: ToolSchema[] = env.tools.schemas(env.enabledToolLevels);
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

        const assistantNode: AppendNodeInput = {
          type: 'assistant_message',
          payload: {
            content: final.message,
            model: env.model,
            connectionId: env.runEnvironment?.connectionId ?? '',
            reasoning: final.reasoning,
            usage: final.usage,
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

        if (final.toolCalls.length === 0) {
          acceptingSteer = false;
          await Promise.allSettled(
            [...pendingAdmissions.values()].map((admission) => admission.persistence),
          );
          if (steerOverlay.length > 0) {
            acceptingSteer = turnKind === 'user';
            continue;
          }
          break;
        }

        // Token budget is the ONLY hard gate (docs/04 §1).
        if (env.tokenBudget !== undefined && turnTokens > env.tokenBudget) {
          stopReason = 'budget_pause';
          break;
        }

        // ---- execute tool calls ----------------------------------------------
        for (const call of final.toolCalls) {
          if (abort.signal.aborted) {
            stopReason = 'interrupted';
            break loop;
          }
          // Evaluated lazily at the next tool call (not the instant the Nth
          // failure lands): the 3-failure reminder is queued and consumed at
          // the next LLM round FIRST, so the model always gets one chance to
          // change course before this hard-stops the turn. Don't add a stop
          // check between queuing the reminder and the next LLM call.
          if (consecutiveFailures >= CONSECUTIVE_FAILURE_STOP) {
            await env.tree.appendNode(threadId, {
              type: 'system_notice',
              payload: {
                text: `连续 ${CONSECUTIVE_FAILURE_STOP} 次工具调用失败，任务已停止。请检查页面状态或换一种方式继续。`,
                noticeKind: 'paused',
              },
            });
            stopReason = 'error';
            break loop;
          }

          const callItemId = call.id;
          toolCallCount++;

          // Hard step ceiling (page-agent max_steps). Emit a notice then break
          // so the model can write a wrap-up message in the NEXT LLM call, which
          // fires without tools and exits cleanly.
          if (toolCallCount > HARD_STEP_LIMIT) {
            await env.tree.appendNode(threadId, {
              type: 'system_notice',
              payload: { text: HARD_STEP_NOTICE, noticeKind: 'paused' },
            });
            stopReason = 'budget_pause';
            break loop;
          }

          if (toolCallCount === SOFT_STEP_LIMIT) {
            stepReminderPending = true;
            await env.tree.appendNode(threadId, {
              type: 'system_notice',
              payload: {
                text: `已执行 ${SOFT_STEP_LIMIT} 步工具调用`,
                noticeKind: 'step_reminder',
              },
            });
          }

          const tool = env.tools.get(call.name);

          env.emit({
            type: 'item.start',
            threadId,
            turnId,
            itemId: callItemId,
            kind: 'tool_call',
            meta: { toolName: call.name, label: tool?.label ?? call.name, level: tool?.level },
          });
          await env.tree.appendNode(threadId, {
            type: 'tool_call',
            payload: {
              itemId: callItemId,
              toolName: call.name,
              params: call.params,
              level: tool?.level ?? 'builtin',
            },
          });

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
              await env.appendNodesAndSetRunState([resultNode], state, {
                pendingTool: undefined,
              });
            } else {
              await env.tree.appendNode(threadId, resultNode);
              await env.setRunState?.(state, { pendingTool: undefined });
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
          const preparedTool: PendingToolExecution = {
            itemId: callItemId,
            toolName: call.name,
            params: validation.params,
            target: await tool.resolveTarget?.(validation.params as never),
            effect: tool.effects,
            recovery: tool.recovery ?? (tool.effects === 'read' ? 'retry-safe' : 'never-retry'),
          };

          // Gatekeeper — the single interception point (docs/06 §2).
          const verdictResult = await env.gatekeeper.check(
            {
              toolName: call.name,
              params: call.params,
              effects: tool.effects,
              target: preparedTool.target,
            },
            threadId,
          );
          if (verdictResult.verdict === 'deny') {
            await fail(`Action denied by policy: ${verdictResult.reason}`, false);
            continue;
          }
          if (verdictResult.verdict === 'ask') {
            await env.setRunState?.('waiting_approval', { pendingTool: preparedTool });
            const decision = await env.requestApproval(turnId, verdictResult.request);
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

          try {
            await env.setRunState?.('executing_tool', {
              pendingTool: { ...preparedTool, startedAt: Date.now() },
            });
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
                trust: tool.resultTrust ?? (tool.level === 'builtin' ? 'trusted' : 'untrusted'),
                provenance:
                  tool.resultProvenance ??
                  (tool.level === 'mcp' ? 'mcp' : tool.level === 'builtin' ? 'tool' : 'page'),
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
            // Tool errors go back to the model for self-correction (docs/04 §2).
            await fail(`Tool failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
    } catch (e) {
      stopReason = 'error';
      env.emit({
        type: 'error',
        code: e instanceof ProviderError ? 'provider_error' : 'internal',
        message: e instanceof Error ? e.message : String(e),
        retryable: e instanceof ProviderError || steerMaterializationFailed,
        ...(e instanceof ProviderError ? { errorKind: e.kind } : {}),
      });
    }
    // turn.complete fires only after all writes above have resolved — every
    // appendNode is awaited, so reaching this line IS the ack (docs/04 §2).
    if (steerMaterializationFailed) stopReason = 'interrupted';
    let terminalState: RunState =
      stopReason === 'done'
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
