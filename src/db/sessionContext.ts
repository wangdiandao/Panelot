/**
 * buildSessionContext (docs/02 §5) — THE traversal algorithm.
 *
 * The same function serves three consumers: LLM request assembly (engine),
 * ThreadSnapshot (UI reconnect), and conversation export. No consumer may
 * implement its own tree walk.
 *
 * Output shape:
 *  1. Walk leaf → root (tombstones skipped), reverse to linear order.
 *  2. system_notice nodes never enter LLM history (UI-only).
 */

import type { ContentBlock } from '../messaging/protocol';
import type { ThreadTree } from './tree';
import type {
  AssistantMessagePayload,
  ThreadNode,
  ToolCallPayload,
  ToolResultPayload,
  TurnContextPayload,
  UserMessagePayload,
} from './types';

/** Provider-neutral message format consumed by the adapters (docs/03 §2). */
export type UnifiedMessage =
  | { role: 'user'; content: ContentBlock[] }
  | { role: 'assistant'; content: ContentBlock[]; toolCalls?: UnifiedToolCall[] }
  | { role: 'tool_result'; toolCallId: string; content: ContentBlock[]; isError: boolean };

export interface UnifiedToolCall {
  id: string;
  name: string;
  params: unknown;
}

export interface SessionContext {
  /** Linear message sequence for the LLM. */
  messages: UnifiedMessage[];
  /** Latest turn_context on the path — restores model/permissions on replay. */
  turnContext: TurnContextPayload | null;
  /** Full node path (root-first, tombstones removed) for UI/snapshot use. */
  path: ThreadNode[];
}

export async function buildSessionContext(
  tree: ThreadTree,
  threadId: string,
  leafId: string,
): Promise<SessionContext> {
  const path = await tree.getPath(threadId, leafId);

  // Find the last turn_context.
  let turnContext: TurnContextPayload | null = null;
  for (let i = path.length - 1; i >= 0; i--) {
    const node = path[i]!;
    if (node.type === 'turn_context') {
      turnContext = node.payload as TurnContextPayload;
      break;
    }
  }

  const messages: UnifiedMessage[] = [];
  for (const node of path) {
    appendNodeAsMessage(messages, node);
  }

  return { messages, turnContext, path };
}

function appendNodeAsMessage(messages: UnifiedMessage[], node: ThreadNode): void {
  switch (node.type) {
    case 'user_message': {
      const p = node.payload as UserMessagePayload;
      const blocks: ContentBlock[] = [...p.content];
      // Attached context (page excerpts etc.) rides along inside the user
      // message; untrusted-content fencing is applied by the prompt assembler
      // (docs/10 §4), not here.
      for (const ctx of p.attachedContext ?? []) blocks.push(...ctx.content);
      messages.push({ role: 'user', content: blocks });
      break;
    }
    case 'assistant_message': {
      const p = node.payload as AssistantMessagePayload;
      messages.push({ role: 'assistant', content: p.content });
      break;
    }
    case 'tool_call': {
      const p = node.payload as ToolCallPayload;
      // Attach the call to the preceding assistant message (Anthropic/OpenAI
      // both model tool calls as part of the assistant turn).
      const prev = messages[messages.length - 1];
      const call: UnifiedToolCall = { id: p.itemId, name: p.toolName, params: p.params };
      if (prev && prev.role === 'assistant') {
        (prev.toolCalls ??= []).push(call);
      } else {
        messages.push({ role: 'assistant', content: [], toolCalls: [call] });
      }
      break;
    }
    case 'tool_result': {
      const p = node.payload as ToolResultPayload;
      messages.push({
        role: 'tool_result',
        toolCallId: p.itemId,
        content: p.contentForLlm,
        isError: !p.ok,
      });
      break;
    }
    // turn_context / approval_decision / system_notice: metadata, not LLM messages.
    case 'turn_context':
    case 'approval_decision':
    case 'system_notice':
      break;
  }
}
