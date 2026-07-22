/**
 * AgentTool — the single interface every tool implements (docs/development/agent-engine.md §4).
 *
 * Design borrowed from Pi Agent's AgentTool with the content/details dual
 * channel: `content` goes to the LLM (counted in context), `details` goes to
 * the UI via item.complete (screenshots, highlight boxes, diffs). Neither may
 * leak into the other — that's a hard rule.
 */

import { schema, type RuntimeSchema } from './schema';
import type { RunToolSnapshot, ToolExecutionBinding, ToolRecoveryPolicy } from '../db/types';
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
  /** For the LLM — one sentence of function + when to use + failure recovery (docs/development/prompts.md §3). */
  description: string;
  parameters: RuntimeSchema<P>;
  /** Provider-facing schema is preserved when a remote tool supplies one. */
  inputSchema?: Record<string, unknown>;
  level: ToolLevel;
  /** Basis for the Gatekeeper's default verdict (docs/development/permissions.md). */
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

export type ToolCapabilityDescriptor = Omit<
  RunToolSnapshot,
  'digest' | 'resultTrust' | 'resultProvenance'
> &
  Required<Pick<RunToolSnapshot, 'resultTrust' | 'resultProvenance'>>;

export interface RegisteredAgentTool extends AnyAgentTool {
  inputSchema: Record<string, unknown>;
  recovery: ToolRecoveryPolicy;
  resultTrust: 'trusted' | 'untrusted';
  resultProvenance: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
  executionBinding: ToolExecutionBinding;
}

export interface ToolRegistrySnapshotEntry {
  readonly tool: RegisteredAgentTool;
  readonly capability: ToolCapabilityDescriptor;
}

export interface ToolRegistrySnapshot {
  readonly generation: number;
  readonly entries: readonly ToolRegistrySnapshotEntry[];
}

export function defaultToolResultTrust(level: ToolLevel): RegisteredAgentTool['resultTrust'] {
  return level === 'builtin' ? 'trusted' : 'untrusted';
}

export function defaultToolResultProvenance(
  level: ToolLevel,
): RegisteredAgentTool['resultProvenance'] {
  if (level === 'mcp') return 'mcp';
  return level === 'builtin' ? 'tool' : 'page';
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function assertRegistrationText(value: string, field: 'name' | 'label' | 'description'): void {
  if (!value.trim()) throw new Error(`Tool ${field} must not be empty`);
  if (
    field === 'name' &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return /\s/u.test(character) || codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new Error(`Tool name must not contain whitespace or control characters: ${value}`);
  }
}

export function normalizeToolCapability(tool: AnyAgentTool): ToolCapabilityDescriptor {
  assertRegistrationText(tool.name, 'name');
  assertRegistrationText(tool.label, 'label');
  assertRegistrationText(tool.description, 'description');
  if (Boolean(tool.interaction) !== Boolean(tool.prepareInteraction)) {
    throw new Error(
      `Interactive tool ${tool.name} must declare both interaction and prepareInteraction`,
    );
  }
  const execution = tool.executionBinding ?? { kind: 'local' as const, id: tool.name };
  if (!execution.id.trim()) throw new Error(`Tool execution binding id must not be empty`);
  if (tool.level === 'mcp') {
    if (execution.kind !== 'mcp') {
      throw new Error(`MCP tool ${tool.name} must use an MCP execution binding`);
    }
    if (!execution.serverId?.trim()) {
      throw new Error(`MCP tool ${tool.name} must declare a server id`);
    }
    if (!execution.endpoint?.trim()) {
      throw new Error(`MCP tool ${tool.name} must declare an endpoint`);
    }
    if (!execution.auth) {
      throw new Error(`MCP tool ${tool.name} must declare its authentication binding`);
    }
  } else if (execution.kind !== 'local') {
    throw new Error(`Local tool ${tool.name} must use a local execution binding`);
  } else if (execution.serverId || execution.endpoint || execution.auth) {
    throw new Error(`Local tool ${tool.name} must not declare MCP execution metadata`);
  }

  return immutableClone({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters:
      tool.inputSchema ??
      (schema.toJSONSchema(tool.parameters, { io: 'input' }) as Record<string, unknown>),
    level: tool.level,
    effects: tool.effects,
    recovery: tool.recovery ?? (tool.effects === 'read' ? 'retry-safe' : 'never-retry'),
    resultTrust: tool.resultTrust ?? defaultToolResultTrust(tool.level),
    resultProvenance: tool.resultProvenance ?? defaultToolResultProvenance(tool.level),
    execution,
  });
}

function capabilitySummary(capability: ToolCapabilityDescriptor): string {
  const binding =
    capability.execution.kind === 'mcp'
      ? `mcp:${capability.execution.serverId ?? 'unknown'}/${capability.execution.id}`
      : `local:${capability.execution.id}`;
  return `${capability.level}/${capability.effects}/${capability.recovery}/${binding}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools = new Map<string, RegisteredAgentTool>();
  private capabilitiesByName = new Map<string, ToolCapabilityDescriptor>();
  private generation = 0;

  register<P, D>(tool: AgentTool<P, D>): void;
  register(tool: AnyAgentTool): void;
  register(tool: AnyAgentTool | AgentTool<unknown, unknown>): void {
    const erased = tool as unknown as AnyAgentTool;
    const capability = normalizeToolCapability(erased);
    const existing = this.capabilitiesByName.get(capability.name);
    if (existing) {
      throw new Error(
        `Tool registration conflict for ${capability.name}: existing ${capabilitySummary(existing)}; incoming ${capabilitySummary(capability)}`,
      );
    }
    const registered = Object.freeze({
      ...erased,
      execute: erased.execute.bind(erased),
      ...(erased.resolveTarget ? { resolveTarget: erased.resolveTarget.bind(erased) } : undefined),
      ...(erased.prepareInteraction
        ? { prepareInteraction: erased.prepareInteraction.bind(erased) }
        : undefined),
      inputSchema: capability.parameters,
      recovery: capability.recovery,
      resultTrust: capability.resultTrust,
      resultProvenance: capability.resultProvenance,
      executionBinding: capability.execution,
    }) as RegisteredAgentTool;
    this.tools.set(capability.name, registered);
    this.capabilitiesByName.set(capability.name, capability);
    this.generation += 1;
  }

  unregister(name: string): void {
    const removedTool = this.tools.delete(name);
    const removedCapability = this.capabilitiesByName.delete(name);
    if (removedTool !== removedCapability) {
      throw new Error(`Tool registry invariant violated while unregistering ${name}`);
    }
    if (removedTool) this.generation += 1;
  }

  get(name: string): RegisteredAgentTool | undefined {
    return this.tools.get(name);
  }

  /** Tools visible to the LLM, filtered by enabled levels (ModelPreset). */
  list(enabledLevels?: readonly ToolLevel[]): RegisteredAgentTool[] {
    const all = [...this.tools.values()];
    if (!enabledLevels) return all;
    // builtin tools are always available.
    return all.filter((t) => t.level === 'builtin' || enabledLevels.includes(t.level));
  }

  /** Canonical provider and recovery facts captured for resumable runs. */
  capabilities(enabledLevels?: readonly ToolLevel[]): ToolCapabilityDescriptor[] {
    return this.snapshot(enabledLevels).entries.map((entry) => entry.capability);
  }

  /** Atomically pair each immutable implementation with its capability facts. */
  snapshot(enabledLevels?: readonly ToolLevel[]): ToolRegistrySnapshot {
    const entries = this.list(enabledLevels).map((tool) => {
      const capability = this.capabilitiesByName.get(tool.name);
      if (!capability) throw new Error(`Tool capability is missing for ${tool.name}`);
      return Object.freeze({ tool, capability });
    });
    return Object.freeze({
      generation: this.generation,
      entries: Object.freeze(entries),
    });
  }

  /** JSON Schemas for the provider request. */
  schemas(enabledLevels?: readonly ToolLevel[]): ToolSchema[] {
    return this.capabilities(enabledLevels).map((capability) => ({
      name: capability.name,
      description: capability.description,
      parameters: capability.parameters,
    }));
  }
}

// ---------------------------------------------------------------------------
// Param validation helper
// ---------------------------------------------------------------------------

/**
 * Validate raw LLM-provided params. On failure returns an error string that
 * goes back to the model as a failed tool_result (self-correction, docs/development/agent-engine.md §4)
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
