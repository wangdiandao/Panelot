/**
 * Persistent data model (docs/development/data-model.md).
 *
 * The conversation is a tree and only a tree: nodes carry `parentId`,
 * `childrenIds` is never stored (derived by index lookup), and the thread's
 * `leafId` is the cursor into the active branch. Nodes are append-only —
 * deletion is a tombstone flag, physical removal only happens with whole-
 * thread deletion or quota eviction.
 */

import type {
  ApprovalDecision,
  InteractionRequestPayload,
  InteractionResponse,
  PermissionPolicy,
  ApprovalRequestPayload,
  ContentBlock,
  ContextBlock,
  ProviderStopReason,
  SubmissionBrowserContext,
  ToolLevel,
  TurnOverrides,
  UserInput,
  Usage,
} from '../messaging/protocol';

// ---------------------------------------------------------------------------
// threads — light index table (docs/development/data-model.md §2.1)
// ---------------------------------------------------------------------------

export interface ThreadMeta {
  id: string;
  revision: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Cursor: leaf of the active branch. Null only for a freshly created empty thread. */
  leafId: string | null;
  folderId?: string;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  /** Default ModelPreset id. */
  preset?: string;
  /** Fork origin (reserved for subagents). */
  parentThreadId?: string;
  stats: { turns: number; totalTokens: number; costUsd: number };
  /** Origins this task has touched — cross-scope detection input (docs/development/permissions.md §2). */
  scopeOrigins: string[];
  /** Set before physical deletion so a half-deleted thread is never replayed. */
  deleting?: boolean;
}

// ---------------------------------------------------------------------------
// nodes — the conversation tree (docs/development/data-model.md §2.2)
// ---------------------------------------------------------------------------

export type NodeType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'approval_decision'
  | 'interaction_response'
  | 'turn_context'
  | 'system_notice';

export interface UserMessagePayload {
  content: ContentBlock[];
  attachedContext?: ContextBlock[];
  /** True when this input was injected mid-turn via steer. */
  steered?: boolean;
}

export interface AssistantMessagePayload {
  content: ContentBlock[];
  model: string;
  connectionId: string;
  reasoning?: string;
  providerState?: import('../providers/types').ProviderAssistantState;
  usage?: Usage;
  providerStopReason?: ProviderStopReason;
}

export interface ToolCallPayload {
  itemId: string;
  toolName: string;
  params: unknown;
  level: ToolLevel;
}

export interface ToolResultPayload {
  itemId: string;
  ok: boolean;
  contentForLlm: ContentBlock[];
  /** UI-only rich channel; large blobs live in `attachments`, referenced by id. */
  details?: unknown;
  trust?: 'trusted' | 'untrusted';
  provenance?: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
  origin?: string;
}

export interface ApprovalDecisionPayload {
  approvalId: string;
  request: ApprovalRequestPayload;
  decision: ApprovalDecision;
  decidedAt: number;
}

export interface InteractionResponsePayload {
  interactionId: string;
  request: InteractionRequestPayload;
  response: InteractionResponse;
  respondedAt: number;
}

/** One per turn start — restores the environment on replay (docs/development/data-model.md §2.2). */
export interface TurnContextPayload {
  turnId: string;
  model: { connectionId: string; modelId: string };
  permissionPolicy: PermissionPolicy;
  activeSkills: string[];
  /** Kernel prompt version for attribution (docs/development/prompts.md §8). */
  promptVersion?: string;
  browserContext?: SubmissionBrowserContext;
}

/** Visible to the user but never enters LLM history. */
export interface SystemNoticePayload {
  text: string;
  noticeKind?: 'paused' | 'step_reminder' | 'recovered' | 'generic';
}

export type NodePayload =
  | UserMessagePayload
  | AssistantMessagePayload
  | ToolCallPayload
  | ToolResultPayload
  | ApprovalDecisionPayload
  | InteractionResponsePayload
  | TurnContextPayload
  | SystemNoticePayload;

export interface ThreadNode {
  id: string;
  threadId: string;
  /** Null for the root node. */
  parentId: string | null;
  /** Monotonic within a thread — the replay ordering key. */
  seq: number;
  ts: number;
  type: NodeType;
  payload: NodePayload;
  /** Tombstone (docs/development/data-model.md §3.3): skipped in traversal, children relink to grandparent. */
  deleted?: boolean;
  /** Set when the attachment backing this node was quota-evicted. */
  evicted?: boolean;
}

// ---------------------------------------------------------------------------
// attachments (docs/development/data-model.md §2.3)
// ---------------------------------------------------------------------------

export interface Attachment {
  id: string;
  threadId: string;
  createdAt: number;
  kind: 'image' | 'file' | 'page_snapshot' | 'screenshot' | 'page_text';
  mime: string;
  bytes: Blob;
  /** Trust is evaluated by the prompt assembler, never by the rendering layer. */
  trust?: 'trusted' | 'untrusted';
  provenance?: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
  sourceRef?: string;
  refs?: { nodeIds?: string[]; runIds?: string[]; pluginId?: string };
  deleting?: boolean;
  orphanedAt?: number;
  detachedReason?: 'overwrite-import';
  meta?: { url?: string; title?: string; w?: number; h?: number };
}

// ---------------------------------------------------------------------------
// skills / memories (populated in later phases; schema fixed now)
// ---------------------------------------------------------------------------

export interface SkillRecord {
  id: string;
  name: string;
  raw: string;
  frontmatter: unknown;
  body: string;
  enabled: boolean;
  source: 'builtin' | 'user' | 'imported' | 'plugin';
  sourceRef?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryRecord {
  id: string;
  key: string;
  value: string;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// durable runtime
// ---------------------------------------------------------------------------

export type RunState =
  | 'queued'
  | 'preparing'
  | 'streaming_model'
  | 'waiting_approval'
  | 'waiting_interaction'
  | 'executing_tool'
  | 'paused_budget'
  | 'paused_uncertain'
  | 'interrupted'
  | 'failed'
  | 'completed';

export type ToolEffect = 'read' | 'write';
export type ToolRecoveryPolicy = 'retry-safe' | 'inspect-first' | 'never-retry';

export interface ResolvedRunEnvironment {
  connectionId: string;
  modelId: string;
  modelParameters: Record<string, unknown>;
  modelCapabilities?: import('../providers/types').ModelCapabilities;
  pricing?: { input: number; output: number; cacheRead?: number };
  presetId?: string;
  presetPrompt?: string;
  enabledToolLevels: Exclude<ToolLevel, 'builtin'>[];
  permissionPolicy: PermissionPolicy;
  activeSkills: string[];
  promptVersion: string;
  browserContext?: SubmissionBrowserContext;
}

export interface ProviderCredentialReference {
  kind: 'api-key' | 'custom-header';
  connectionId: string;
  slot?: number;
  headerName?: string;
}

export interface ProviderEnvironmentBinding {
  kind: 'settings' | 'resolver';
  connectionId: string;
  protocol?: import('../providers/types').Connection['kind'];
  baseUrl?: string;
  quirks?: import('../providers/types').QuirkFlags;
  credentials: ProviderCredentialReference[];
}

export interface ToolExecutionBinding {
  kind: 'local' | 'mcp';
  id: string;
  serverId?: string;
  endpoint?: string;
  auth?: {
    kind: 'none' | 'bearer' | 'oauth';
    credentialRef?: string;
    resource?: string;
    issuer?: string;
    clientId?: string;
    scopes?: string[];
  };
}

export interface RunToolSnapshot {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  level: ToolLevel;
  effects: ToolEffect;
  recovery: ToolRecoveryPolicy;
  resultTrust?: 'trusted' | 'untrusted';
  resultProvenance?: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
  execution: ToolExecutionBinding;
  digest: string;
}

export interface RunSkillSnapshot {
  id: string;
  name: string;
  body: string;
  description: string;
  sites?: string[];
  digest: string;
}

/** Immutable request and execution facts used when an interrupted turn resumes. */
export interface RunEnvironmentSnapshot extends ResolvedRunEnvironment {
  snapshotVersion: 1;
  capturedAt: number;
  inputDigest: string;
  providerBinding: ProviderEnvironmentBinding;
  systemPrompt: string;
  systemPromptDigest: string;
  skillCatalog: RunSkillSnapshot[];
  toolCatalog: RunToolSnapshot[];
  toolCatalogDigest: string;
  digest: string;
}

export interface PendingToolExecution {
  itemId: string;
  toolName: string;
  params: unknown;
  target?: { tabId?: number; frameId?: number; origin?: string; serverId?: string };
  effect: ToolEffect;
  recovery: ToolRecoveryPolicy;
  startedAt?: number;
}

export interface RunRecord {
  id: string;
  threadId: string;
  turnId: string;
  clientId: string;
  submissionId: string;
  input: UserInput;
  overrides?: TurnOverrides;
  state: RunState;
  revision: number;
  /** Missing snapshot metadata identifies a run created by an unsupported legacy build. */
  environment?: ResolvedRunEnvironment | RunEnvironmentSnapshot;
  stepCursor: number;
  pendingTool?: PendingToolExecution;
  pendingSteers?: PendingSteer[];
  usage?: Usage;
  costUsd?: number;
  stopReason?: string;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
}

export interface PendingSteer {
  nodeId: string;
  payload: UserMessagePayload;
  attachmentIds?: string[];
  acceptedAt: number;
  admissionSequence?: number;
}

export type CommandReceiptResponse =
  | { type: 'command.ack'; threadId?: string; runId?: string; revision?: number }
  | {
      type: 'command.rejected';
      code: string;
      message: string;
      threadId?: string;
      revision?: number;
    };

export interface CommandReceipt {
  id: string;
  clientId: string;
  submissionId: string;
  commandType: string;
  /** SHA-256 of the command payload, excluding transport identity fields. */
  requestFingerprint?: string;
  status: 'processing' | 'acknowledged' | 'rejected';
  response?: CommandReceiptResponse;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface ApprovalRecord {
  id: string;
  threadId: string;
  runId: string;
  turnId: string;
  request: ApprovalRequestPayload;
  status: 'pending' | 'decided';
  decision?: ApprovalDecision;
  requestedAt: number;
  /** Persisted timeout boundary so a restarted worker does not restart the wait window. */
  deadlineAt?: number;
  decidedAt?: number;
}

export interface InteractionRecord {
  id: string;
  threadId: string;
  runId: string;
  turnId: string;
  itemId: string;
  request: InteractionRequestPayload;
  status: 'pending' | 'resolved';
  response?: InteractionResponse;
  requestedAt: number;
  respondedAt?: number;
}

/** Durable proof that a destructive data import committed inside IndexedDB. */
export interface MaintenanceMarker {
  id: 'data-import';
  operationId: string;
  digest: string;
  committedAt: number;
}

export interface PluginRecord {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: { kind: 'zip' | 'github' | 'builtin'; ref?: string };
  enabled: boolean;
  manifest: unknown;
  assetIds: string[];
  installedAt: number;
  updatedAt: number;
}

export interface PluginAssetRecord {
  id: string;
  pluginId: string;
  path: string;
  kind: 'skill' | 'preset' | 'site-instruction' | 'other';
  mime: string;
  bytes: Blob;
  readOnly: true;
  createdAt: number;
}
