/**
 * AgentTool — the single interface every tool implements (docs/04 §4).
 *
 * Design borrowed from Pi Agent's AgentTool with the content/details dual
 * channel: `content` goes to the LLM (counted in context), `details` goes to
 * the UI via item.complete (screenshots, highlight boxes, diffs). Neither may
 * leak into the other — that's a hard rule.
 */

import { schema, type RuntimeSchema } from './schema';
import type { ToolExecutionBinding, ToolRecoveryPolicy } from '../db/types';
import type { AskUserQuestion, ContentBlock, ToolLevel } from '../messaging/protocol';
import type { InteractionRequestPayload } from '../messaging/protocol';
import type { ToolSchema } from '../providers/types';

export interface ToolResult<D = unknown> {
  /** For the LLM: concise text/images, counted against context. */
  content: ContentBlock[];
  /** For the UI only: rich rendering payload, delivered via item.complete. */
  details?: D;
}

export interface ToolUpdate<D = unknown> {
  progressText: string;
  details?: D;
}

export interface AgentTool<P = unknown, D = unknown> {
  /** Wire name, e.g. 'browser_click' or 'mcp__github__create_issue'. */
  name: string;
  /** UI display label, e.g. "点击元素". */
  label: string;
  /** For the LLM — one sentence of function + when to use + failure recovery (docs/10 §3). */
  description: string;
  parameters: RuntimeSchema<P>;
  /** Provider-facing schema is preserved when a remote tool supplies one. */
  inputSchema?: Record<string, unknown>;
  level: ToolLevel;
  /** Basis for the Gatekeeper's default verdict (docs/06). */
  effects: 'read' | 'write';
  recovery?: ToolRecoveryPolicy;
  resultTrust?: 'trusted' | 'untrusted';
  resultProvenance?: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
  /** Stable identity for recovery-time execution binding validation. */
  executionBinding?: ToolExecutionBinding;
  /** Engine-mediated suspension. Interactive tools never execute directly. */
  interaction?: InteractionRequestPayload['kind'];
  prepareInteraction?: (params: P) => Promise<InteractionRequestPayload>;
  resolveTarget?: (params: P) => Promise<{
    tabId?: number;
    frameId?: number;
    origin?: string;
    serverId?: string;
  }>;
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal,
    onUpdate?: (partial: ToolUpdate<D>) => void,
  ): Promise<ToolResult<D>>;
}

interface ErasedCallbackParams extends Readonly<Record<string, unknown>> {
  question: string;
  questions: AskUserQuestion[];
  instruction: string;
  tabId: number;
  condition: 'text' | 'text_gone' | 'url';
  value: string;
  timeoutSeconds: number;
  delaySeconds: number;
  reason: string;
  url: string;
  sessionId: string;
  text: string;
}

/** Type-erased tool for registry storage; callers validate unknown input first. */
export interface AnyAgentTool {
  name: string;
  label: string;
  description: string;
  parameters: RuntimeSchema<unknown>;
  inputSchema?: Record<string, unknown>;
  level: ToolLevel;
  effects: 'read' | 'write';
  recovery?: ToolRecoveryPolicy;
  resultTrust?: 'trusted' | 'untrusted';
  resultProvenance?: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
  executionBinding?: ToolExecutionBinding;
  interaction?: InteractionRequestPayload['kind'];
  prepareInteraction?: (params: ErasedCallbackParams) => Promise<InteractionRequestPayload>;
  resolveTarget?: (params: ErasedCallbackParams) => Promise<{
    tabId?: number;
    frameId?: number;
    origin?: string;
    serverId?: string;
  }>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal,
    onUpdate?: (partial: ToolUpdate<unknown>) => void,
  ): Promise<ToolResult<unknown>>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools = new Map<string, AnyAgentTool>();

  register<P, D>(tool: AgentTool<P, D>): void;
  register(tool: AnyAgentTool): void;
  register(tool: AnyAgentTool | AgentTool<unknown, unknown>): void {
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} already registered`);
    this.tools.set(tool.name, tool as unknown as AnyAgentTool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): AnyAgentTool | undefined {
    return this.tools.get(name);
  }

  /** Tools visible to the LLM, filtered by enabled levels (ModelPreset). */
  list(enabledLevels?: readonly ToolLevel[]): AnyAgentTool[] {
    const all = [...this.tools.values()];
    if (!enabledLevels) return all;
    // builtin tools are always available.
    return all.filter((t) => t.level === 'builtin' || enabledLevels.includes(t.level));
  }

  /** JSON Schemas for the provider request. */
  schemas(enabledLevels?: readonly ToolLevel[]): ToolSchema[] {
    return this.list(enabledLevels).map((t) => ({
      name: t.name,
      description: t.description,
      parameters:
        t.inputSchema ??
        (schema.toJSONSchema(t.parameters, { io: 'input' }) as Record<string, unknown>),
    }));
  }
}

// ---------------------------------------------------------------------------
// Param validation helper
// ---------------------------------------------------------------------------

/**
 * Validate raw LLM-provided params. On failure returns an error string that
 * goes back to the model as a failed tool_result (self-correction, docs/04 §4)
 * — never thrown at the user.
 */
export function validateParams<P>(
  tool: AgentTool<P, unknown>,
  raw: unknown,
): { ok: true; params: P } | { ok: false; error: string };
export function validateParams(
  tool: AnyAgentTool,
  raw: unknown,
): { ok: true; params: unknown } | { ok: false; error: string };
export function validateParams(
  tool: { name: string; parameters: RuntimeSchema<unknown> },
  raw: unknown,
): { ok: true; params: unknown } | { ok: false; error: string } {
  const result = schema.safeParse(tool.parameters, raw);
  if (result.success) return { ok: true, params: result.data };
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: `Invalid parameters for ${tool.name}: ${issues}` };
}
