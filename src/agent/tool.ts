/**
 * AgentTool — the single interface every tool implements (docs/04 §4).
 *
 * Design borrowed from Pi Agent's AgentTool with the content/details dual
 * channel: `content` goes to the LLM (counted in context), `details` goes to
 * the UI via item.complete (screenshots, highlight boxes, diffs). Neither may
 * leak into the other — that's a hard rule.
 */

import { z } from 'zod';
import type { ContentBlock, ToolLevel } from '../messaging/protocol';
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
  parameters: z.ZodType<P>;
  level: ToolLevel;
  /** Basis for the Gatekeeper's default verdict (docs/06). */
  effects: 'read' | 'write';
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal,
    onUpdate?: (partial: ToolUpdate<D>) => void,
  ): Promise<ToolResult<D>>;
}

/**
 * Type-erased tool for registry storage. `P = any` is deliberate: params are
 * validated at runtime via `validateParams` before every execute call.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAgentTool = AgentTool<any, unknown>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools = new Map<string, AnyAgentTool>();

  register(tool: AnyAgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} already registered`);
    this.tools.set(tool.name, tool);
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
      parameters: z.toJSONSchema(t.parameters, { io: 'input' }) as Record<string, unknown>,
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
): { ok: true; params: P } | { ok: false; error: string } {
  const result = tool.parameters.safeParse(raw);
  if (result.success) return { ok: true, params: result.data };
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: `Invalid parameters for ${tool.name}: ${issues}` };
}
