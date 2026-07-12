/**
 * Provider configuration model (docs/03 §1).
 *
 * Connection abstraction follows OpenWebUI's protocol-first design ("openai"
 * vs "anthropic" wire protocol is the ONLY fork point), while fixing its known
 * gaps: customHeaders, multiple keys with failover, concurrent model fetch.
 */

import type { ContentBlock, Usage } from '../messaging/protocol';
import type { UnifiedMessage } from '../db/sessionContext';

// ---------------------------------------------------------------------------
// Connection — one API endpoint
// ---------------------------------------------------------------------------

/** Per-connection compatibility switches (docs/03 §5). */
export interface QuirkFlags {
  /** Endpoint rejects stream_options.include_usage. */
  noStreamOptions?: boolean;
  /** Reasoning arrives as inline <think> tags instead of delta.reasoning_content. */
  thinkTagReasoning?: boolean;
  /** Force single tool call per response. */
  noParallelToolCalls?: boolean;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Endpoint rejects system role — convert to leading user message. */
  noSystemRole?: boolean;
}

export interface Connection {
  id: string;
  name: string;
  /** Wire protocol — the only fork point. */
  kind: 'openai' | 'anthropic';
  /** Normalized before storage (docs/03 §4). */
  baseUrl: string;
  /** Multiple keys: sticky primary + failover on 401/429 (docs/03 §8). */
  apiKeys: string[];
  customHeaders?: Record<string, string>;
  /** Display prefix to disambiguate same-named models across connections. */
  prefixId?: string;
  /** Manual model whitelist for endpoints without /models. */
  modelIds?: string[];
  /** Optional per-model capability and price overrides supplied by the user. */
  models?: Omit<ModelEntry, 'connectionId'>[];
  enabled: boolean;
  quirks?: QuirkFlags;
}

// ---------------------------------------------------------------------------
// ModelEntry & capabilities
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  toolUse: boolean;
  vision: boolean;
  reasoning?: boolean;
  maxContext?: number;
}

export interface ModelEntry {
  connectionId: string;
  id: string;
  displayName?: string;
  capabilities: ModelCapabilities;
  /** $/Mtok */
  pricing?: { input: number; output: number; cacheRead?: number };
}

// ---------------------------------------------------------------------------
// ModelPreset — a named agent (docs/03 §1.3)
// ---------------------------------------------------------------------------

export interface GenParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export interface ModelPreset {
  id: string;
  name: string;
  icon?: string;
  base: { connectionId: string; modelId: string };
  systemPrompt?: string;
  /** Overrides only — unset fields are never sent (docs/03 §1.4). */
  params?: GenParams;
  enabledToolLevels?: ('L0' | 'L1' | 'L2' | 'mcp')[];
  defaultApprovalPolicy?: import('../messaging/protocol').ApprovalPolicy;
  defaultCapabilityScope?: import('../messaging/protocol').CapabilityScope;
  skills?: string[];
  promptVersion?: string;
}

/**
 * Two-layer merge; undefined fields never reach the request payload
 * (docs/03 §1.4 rule 1).
 */
export function mergeParams(preset?: GenParams, overrides?: GenParams): GenParams {
  const merged: GenParams = {};
  for (const source of [preset, overrides]) {
    if (!source) continue;
    for (const [k, v] of Object.entries(source)) {
      if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Adapter interface (docs/03 §2)
// ---------------------------------------------------------------------------

/** JSON Schema for a tool, generated from AgentTool.parameters. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call_partial'; index: number; id?: string; name?: string; argsDelta: string }
  | { type: 'usage'; usage: Usage };

export interface FinalToolCall {
  id: string;
  name: string;
  /** Parsed params; a parse failure surfaces as `parseError` for model self-correction. */
  params: unknown;
  parseError?: string;
}

export interface FinalResult {
  message: ContentBlock[];
  reasoning?: string;
  toolCalls: FinalToolCall[];
  usage: Usage;
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'content_filter';
}

export interface StreamRequest {
  messages: UnifiedMessage[];
  system?: string;
  tools: ToolSchema[];
  params: GenParams;
  model: string;
  signal: AbortSignal;
}

export interface ProviderStream extends AsyncIterable<StreamEvent> {
  final(): Promise<FinalResult>;
}

export interface ProviderAdapter {
  stream(req: StreamRequest): ProviderStream;
  listModels?(): Promise<string[]>;
  verify(): Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Errors & verify (docs/03 §6-7)
// ---------------------------------------------------------------------------

export type ProviderErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'context_too_long'
  | 'content_filter'
  | 'network'
  | 'protocol';

export type ProviderErrorReason =
  | 'invalid_key'
  | 'permission_denied'
  | 'quota_exceeded'
  | 'endpoint_not_found'
  | 'model_not_found'
  | 'invalid_request'
  | 'upstream_error'
  | 'response_format';

export interface ProviderErrorDetails {
  status?: number;
  /** Provider-issued request identifier for support and diagnostics. */
  requestId?: string;
  reason?: ProviderErrorReason;
  upstreamCode?: string;
  upstreamMessage?: string;
  raw?: string;
}

export class ProviderError extends Error {
  constructor(
    public kind: ProviderErrorKind,
    message: string,
    public retryAfterMs?: number,
    public details: ProviderErrorDetails = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export interface VerifyResult {
  reachable: boolean;
  keyValid: boolean;
  streaming: boolean;
  toolUse: boolean;
  models?: string[];
  /** Human-oriented failure attribution (docs/03 §6). */
  failure?: 'invalid_key' | 'unreachable' | 'needs_host_permission' | 'protocol_mismatch';
  detail?: string;
  details?: ProviderErrorDetails;
}
