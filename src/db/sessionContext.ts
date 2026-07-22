/**
 * buildSessionContext (docs/development/data-model.md §5) — THE traversal algorithm.
 *
 * The same function serves three consumers: LLM request assembly (engine),
 * ThreadSnapshot (UI reconnect), and conversation export. No consumer may
 * implement its own tree walk.
 *
 * Output shape:
 *  1. Walk leaf → root (tombstones skipped), reverse to linear order.
 *  2. Metadata and UI-only nodes never enter LLM history.
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
      providerState?: import('../providers/types').ProviderAssistantState;
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
  browserContext?: import('../messaging/protocol').SubmissionBrowserContext,
  boundarySeed?: string,
): Extract<UnifiedMessage, { role: 'user' }> {
  const blocks: ContentBlock[] = [];
  const defaultTab = browserContext?.defaultTab;
  if (defaultTab) {
    blocks.push({
      type: 'text',
      text: `[Panelot environment: submission tabId=${defaultTab.tabId} title=${JSON.stringify(defaultTab.title)} url=${JSON.stringify(defaultTab.url)}]`,
    });
  }
  blocks.push(...payload.content);
  for (const [contextIndex, ctx] of (payload.attachedContext ?? []).entries()) {
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
            boundarySeed,
            contextIndex * 1024,
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
  const state: {
    activeAssistant?: Extract<UnifiedMessage, { role: 'assistant' }>;
    browserContext?: import('../messaging/protocol').SubmissionBrowserContext;
  } = {};
  for (const node of path) {
    appendNodeAsMessage(messages, toolNames, state, node);
  }

  return { messages, turnContext, path };
}

function appendNodeAsMessage(
  messages: UnifiedMessage[],
  toolNames: Map<string, string>,
  state: {
    activeAssistant?: Extract<UnifiedMessage, { role: 'assistant' }>;
    browserContext?: import('../messaging/protocol').SubmissionBrowserContext;
  },
  node: ThreadNode,
): void {
  switch (node.type) {
    case 'user_message': {
      const p = node.payload as UserMessagePayload;
      messages.push(userMessageToUnifiedMessage(p, state.browserContext, node.id));
      state.activeAssistant = undefined;
      state.browserContext = undefined;
      break;
    }
    case 'assistant_message': {
      const p = node.payload as AssistantMessagePayload;
      const message: Extract<UnifiedMessage, { role: 'assistant' }> = {
        role: 'assistant',
        content: p.content,
        ...(p.reasoning ? { reasoning: p.reasoning } : {}),
        ...(p.providerState ? { providerState: p.providerState } : {}),
      };
      messages.push(message);
      state.activeAssistant = message;
      break;
    }
    case 'tool_call': {
      const p = node.payload as ToolCallPayload;
      // Persisted parallel calls are interleaved with their results. Keep all
      // calls attached to the active assistant turn until a new user or
      // assistant message starts another turn.
      const call: UnifiedToolCall = { id: p.itemId, name: p.toolName, params: p.params };
      if (state.activeAssistant) {
        if (!state.activeAssistant.toolCalls?.some((existing) => existing.id === p.itemId)) {
          toolNames.set(p.itemId, p.toolName);
          (state.activeAssistant.toolCalls ??= []).push(call);
        }
      } else {
        toolNames.set(p.itemId, p.toolName);
        const message: Extract<UnifiedMessage, { role: 'assistant' }> = {
          role: 'assistant',
          content: [],
          toolCalls: [call],
        };
        messages.push(message);
        state.activeAssistant = message;
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
              node.id,
            )
          : p.contentForLlm,
        isError: !p.ok,
      });
      break;
    }
    // These nodes record engine or UI state, not provider conversation messages.
    case 'turn_context':
      state.browserContext = (node.payload as TurnContextPayload).browserContext;
      break;
    case 'approval_decision':
    case 'interaction_response':
    case 'system_notice':
      break;
    default:
      throw new Error(node.type satisfies never);
  }
}

function fenceBlocks(
  blocks: ContentBlock[],
  origin: string,
  source: string,
  boundarySeed?: string,
  ordinalOffset = 0,
): ContentBlock[] {
  return blocks.map((block, blockIndex) =>
    block.type === 'text'
      ? {
          type: 'text',
          text: fenceUntrusted(
            block.text,
            origin,
            source,
            boundarySeed === undefined
              ? undefined
              : stableBoundarySuffix(boundarySeed, ordinalOffset + blockIndex),
          ),
        }
      : block,
  );
}

/** The persisted node id is random for live data and stable across context rebuilds. */
function stableBoundarySuffix(seed: string, ordinal: number): string {
  let hash = 0xcbf29ce484222325n;
  const input = `${seed}:${ordinal}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}
