/**
 * The agent loop (docs/04 §2) — Pi Agent's minimal kernel wrapped in Codex's
 * safety shell. The loop itself stays small: iterate until the model stops
 * calling tools. Steps are a soft reminder (25 calls → notice), token budget
 * is the only hard gate. All complexity lives outside (Gatekeeper, UI,
 * compaction).
 */

import type { ThreadTree } from '../db/tree';
import { buildSessionContext } from '../db/sessionContext';
import type { UserInput, AgentEvent, ApprovalRequestPayload, ApprovalDecision, TurnKind, StopReason, Usage } from '../messaging/protocol';
import type { ProviderAdapter, GenParams, ToolSchema } from '../providers/types';
import { ProviderError } from '../providers/types';
import { validateParams, type ToolRegistry } from './tool';
import { STEP_REMINDER } from '../prompts/kernel';

// ---------------------------------------------------------------------------
// Collaborator interfaces (wired by EngineCore; mockable in tests)
// ---------------------------------------------------------------------------

/** Gatekeeper facade (full implementation in Phase 7). */
export interface GatekeeperCheck {
  check(call: { toolName: string; params: unknown; effects: 'read' | 'write' }, threadId: string):
    Promise<
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
  /** Optional hard token budget for the turn (docs/04 §1). */
  tokenBudget?: number;
  /** Called before each LLM call so the engine can auto-compact (docs/04 §5). */
  maybeCompact?: (threadId: string) => Promise<void>;
}

export interface TurnHandle {
  turnId: string;
  turnKind: TurnKind;
  steerable: boolean;
  /** Inject a steer message; applied after the current LLM call (docs/04 §3). */
  steer(input: UserInput): void;
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
): TurnHandle {
  const turnId = crypto.randomUUID();
  const steerable = turnKind === 'user';
  const abort = new AbortController();
  const steerQueue: UserInput[] = [];

  const handle: TurnHandle = {
    turnId,
    turnKind,
    steerable,
    steer: (steerInput) => {
      if (!steerable) throw new Error('turn is not steerable');
      steerQueue.push(steerInput);
    },
    interrupt: () => abort.abort(),
    done: execute(),
  };

  async function execute(): Promise<StopReason> {
    let stopReason: StopReason = 'done';
    try {
      // Environment anchor for replay (docs/02 §2.2 turn_context).
      await env.tree.appendNode(threadId, {
        type: 'turn_context',
        payload: {
          turnId,
          model: { connectionId: '', modelId: env.model },
          approvalPolicy: 'untrusted',
          capabilityScope: 'cross-origin',
          activeSkills: [],
        },
      });
      await env.tree.appendNode(threadId, {
        type: 'user_message',
        payload: { content: [{ type: 'text', text: input.text }], attachedContext: input.attachedContext },
      });
      env.emit({ type: 'turn.start', threadId, turnId, turnKind, steerable });

      let toolCallCount = 0;
      let stepReminderPending = false;
      let turnTokens = 0;

      loop: for (;;) {
        if (abort.signal.aborted) {
          stopReason = 'interrupted';
          break;
        }
        await env.maybeCompact?.(threadId);

        const thread = await env.tree.getThread(threadId);
        const ctx = await buildSessionContext(env.tree, threadId, thread!.leafId!);
        const messages = [...ctx.messages];
        if (stepReminderPending) {
          messages.push({ role: 'user', content: [{ type: 'text', text: STEP_REMINDER }] });
          stepReminderPending = false;
        }

        // ---- one LLM call ----------------------------------------------------
        const itemId = crypto.randomUUID();
        env.emit({ type: 'item.start', threadId, turnId, itemId, kind: 'assistant_message', meta: {} });

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
            if (ev.type === 'text') env.emit({ type: 'item.delta', itemId, delta: { text: ev.delta } });
            else if (ev.type === 'reasoning') env.emit({ type: 'item.delta', itemId, delta: { reasoning: ev.delta } });
          }
          final = await stream.final();
        } catch (e) {
          if (abort.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
            stopReason = 'interrupted';
            env.emit({ type: 'item.complete', itemId, result: { ok: false } });
            break;
          }
          if (e instanceof ProviderError && e.kind === 'context_too_long' && env.maybeCompact) {
            // Force compaction and retry once (docs/03 §7).
            await env.maybeCompact(threadId);
            env.emit({ type: 'item.complete', itemId, result: { ok: false } });
            continue;
          }
          throw e;
        }

        await env.tree.appendNode(threadId, {
          type: 'assistant_message',
          payload: {
            content: final.message,
            model: env.model,
            connectionId: '',
            reasoning: final.reasoning,
            usage: final.usage,
          },
        });
        env.emit({ type: 'item.complete', itemId, result: { ok: true } });
        turnTokens += final.usage.input + final.usage.output;
        env.emit({
          type: 'token.usage',
          threadId,
          turnId,
          usage: final.usage,
          contextPct: 0, // engine layer fills this in with model context data
        });

        // Steering: consume queued interjections after the LLM call (docs/04 §3).
        for (const steerInput of steerQueue.splice(0)) {
          await env.tree.appendNode(threadId, {
            type: 'user_message',
            payload: { content: [{ type: 'text', text: steerInput.text }], attachedContext: steerInput.attachedContext },
          });
        }

        if (final.toolCalls.length === 0) break; // the only exit condition

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

          const callItemId = call.id;
          toolCallCount++;
          if (toolCallCount === SOFT_STEP_LIMIT) {
            stepReminderPending = true;
            await env.tree.appendNode(threadId, {
              type: 'system_notice',
              payload: { text: `已执行 ${SOFT_STEP_LIMIT} 步工具调用`, noticeKind: 'step_reminder' },
            });
          }

          const tool = env.tools.get(call.name);

          env.emit({
            type: 'item.start', threadId, turnId, itemId: callItemId, kind: 'tool_call',
            meta: { toolName: call.name, label: tool?.label ?? call.name, level: tool?.level },
          });
          await env.tree.appendNode(threadId, {
            type: 'tool_call',
            payload: { itemId: callItemId, toolName: call.name, params: call.params, level: tool?.level ?? 'builtin' },
          });

          const fail = async (error: string) => {
            await env.tree.appendNode(threadId, {
              type: 'tool_result',
              payload: { itemId: callItemId, ok: false, contentForLlm: [{ type: 'text', text: error }] },
            });
            env.emit({ type: 'item.complete', itemId: callItemId, result: { ok: false } });
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

          // Gatekeeper — the single interception point (docs/06 §2).
          const verdictResult = await env.gatekeeper.check(
            { toolName: call.name, params: call.params, effects: tool.effects },
            threadId,
          );
          if (verdictResult.verdict === 'deny') {
            await fail(`Action denied by policy: ${verdictResult.reason}`);
            continue;
          }
          if (verdictResult.verdict === 'ask') {
            const decision = await env.requestApproval(turnId, verdictResult.request);
            await env.tree.appendNode(threadId, {
              type: 'approval_decision',
              payload: { approvalId: callItemId, request: verdictResult.request, decision, decidedAt: Date.now() },
            });
            if (decision.kind === 'decline' || decision.kind === 'cancel') {
              const note = decision.kind === 'decline' && decision.note ? ` User said: ${decision.note}` : '';
              await fail(`The user declined this action.${note} Do not retry it verbatim — adapt or ask.`);
              if (decision.kind === 'cancel') {
                stopReason = 'interrupted';
                break loop;
              }
              continue;
            }
          }

          try {
            const result = await tool.execute(
              callItemId,
              validation.params as never,
              abort.signal,
              (partial) => env.emit({ type: 'item.delta', itemId: callItemId, delta: { toolProgress: partial } }),
            );
            await env.tree.appendNode(threadId, {
              type: 'tool_result',
              payload: { itemId: callItemId, ok: true, contentForLlm: result.content, details: result.details },
            });
            env.emit({ type: 'item.complete', itemId: callItemId, result: { ok: true, details: result.details } });
          } catch (e) {
            if (abort.signal.aborted) {
              stopReason = 'interrupted';
              await fail('interrupted');
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
        retryable: e instanceof ProviderError,
      });
    }
    // turn.complete fires only after all writes above have resolved — every
    // appendNode is awaited, so reaching this line IS the ack (docs/04 §2).
    env.emit({ type: 'turn.complete', threadId, turnId, stopReason });
    return stopReason;
  }

  return handle;
}
