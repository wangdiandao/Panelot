/**
 * buildSessionContext (docs/development/data-model.md §5) — THE traversal algorithm.
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
import { fenceUntrusted } from '../prompts/assemble';
import type { ThreadTree } from './tree';
import type {
  AssistantMessagePayload,
  ThreadNode,
  ToolCallPayload,
  ToolResultPayload,
  TurnContextPayload,
  UserMessagePayload,
} from './types';

/** Provider-neutral message format consumed by the adapters (docs/development/providers.md §2). */
export type UnifiedMessage =
  | { role: 'user'; content: ContentBlock[] }
  | {
      role: 'assistant';
      content: ContentBlock[];
      reasoning?: string;
      toolCalls?: UnifiedToolCall[];
    }
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

export function userMessageToUnifiedMessage(
  payload: UserMessagePayload,
): Extract<UnifiedMessage, { role: 'user' }> {
  const blocks: ContentBlock[] = [...payload.content];
  for (const ctx of payload.attachedContext ?? []) {
    const mustFence =
      ctx.trust === 'untrusted' ||
      ['page', 'selection', 'screenshot', 'tab', 'mcp_resource', 'file'].includes(ctx.kind);
    blocks.push({ type: 'text', text: contextHeader(ctx) });
    blocks.push(
      ...(mustFence
        ? fenceBlocks(
            ctx.content,
            ctx.origin ?? `panelot://${ctx.provenance ?? ctx.kind}`,
            ctx.provenance ?? ctx.kind,
          )
        : ctx.content),
    );
  }
  return { role: 'user', content: blocks };
}

function contextHeader(ctx: import('../messaging/protocol').ContextBlock): string {
  const fields = [`kind=${ctx.kind}`, `label=${JSON.stringify(ctx.label)}`];
  if (ctx.sourceRef) fields.push(`source=${JSON.stringify(ctx.sourceRef)}`);
  if (ctx.origin) fields.push(`origin=${JSON.stringify(ctx.origin)}`);
  if (ctx.tab) {
    fields.push(`tabId=${ctx.tab.tabId}`);
    fields.push(`tabUrl=${JSON.stringify(ctx.tab.url)}`);
  }
  return `[Panelot context: ${fields.join(' ')}]`;
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
    const node = path[i];
    if (!node) continue;
    if (node.type === 'turn_context') {
      turnContext = node.payload as TurnContextPayload;
      break;
    }
  }

  const messages: UnifiedMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const node of path) {
    appendNodeAsMessage(messages, toolNames, node);
  }

  return { messages, turnContext, path };
}

function appendNodeAsMessage(
  messages: UnifiedMessage[],
  toolNames: Map<string, string>,
  node: ThreadNode,
): void {
  switch (node.type) {
    case 'user_message': {
      const p = node.payload as UserMessagePayload;
      messages.push(userMessageToUnifiedMessage(p));
      break;
    }
    case 'assistant_message': {
      const p = node.payload as AssistantMessagePayload;
      messages.push({
        role: 'assistant',
        content: p.content,
        ...(p.reasoning ? { reasoning: p.reasoning } : {}),
      });
      break;
    }
    case 'tool_call': {
      const p = node.payload as ToolCallPayload;
      // Attach the call to the preceding assistant message (Anthropic/OpenAI
      // both model tool calls as part of the assistant turn).
      const prev = messages[messages.length - 1];
      const call: UnifiedToolCall = { id: p.itemId, name: p.toolName, params: p.params };
      if (prev && prev.role === 'assistant') {
        if (!prev.toolCalls?.some((existing) => existing.id === p.itemId)) {
          toolNames.set(p.itemId, p.toolName);
        }
        (prev.toolCalls ??= []).push(call);
      } else {
        toolNames.set(p.itemId, p.toolName);
        messages.push({ role: 'assistant', content: [], toolCalls: [call] });
      }
      break;
    }
    case 'tool_result': {
      const p = node.payload as ToolResultPayload;
      const toolName = toolNames.get(p.itemId) ?? 'tool';
      const mustFence =
        p.trust === 'untrusted' ||
        p.provenance === 'page' ||
        p.provenance === 'mcp' ||
        p.provenance === 'import';
      messages.push({
        role: 'tool_result',
        toolCallId: p.itemId,
        content: mustFence
          ? fenceBlocks(
              p.contentForLlm,
              p.origin ?? `panelot://${p.provenance ?? 'tool'}`,
              toolName,
            )
          : p.contentForLlm,
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

function fenceBlocks(blocks: ContentBlock[], origin: string, source: string): ContentBlock[] {
  return blocks.map((block) =>
    block.type === 'text'
      ? { type: 'text', text: fenceUntrusted(block.text, origin, source) }
      : block,
  );
}
