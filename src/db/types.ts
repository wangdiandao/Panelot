/**
 * Persistent data model (docs/02).
 *
 * The conversation is a tree and ONLY a tree: nodes carry `parentId`,
 * `childrenIds` is never stored (derived by index lookup), and the thread's
 * `leafId` is the cursor into the active branch. Nodes are append-only —
 * deletion is a tombstone flag, physical removal only happens with whole-
 * thread deletion or quota eviction.
 */

import type {
  ApprovalDecision,
  ApprovalPolicy,
  ApprovalRequestPayload,
  CapabilityScope,
  ContentBlock,
  ContextBlock,
  ToolLevel,
  Usage,
} from '../messaging/protocol';

// ---------------------------------------------------------------------------
// threads — light index table (docs/02 §2.1)
// ---------------------------------------------------------------------------

export interface ThreadMeta {
  id: string;
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
  /** Origins this task has touched — cross-scope detection input (docs/06 §2). */
  scopeOrigins: string[];
  /** Set before physical deletion so a half-deleted thread is never replayed. */
  deleting?: boolean;
}

// ---------------------------------------------------------------------------
// nodes — the conversation tree (docs/02 §2.2)
// ---------------------------------------------------------------------------

export type NodeType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'approval_decision'
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
  usage?: Usage;
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
}

export interface ApprovalDecisionPayload {
  approvalId: string;
  request: ApprovalRequestPayload;
  decision: ApprovalDecision;
  decidedAt: number;
}

/** One per turn start — restores the environment on replay (docs/02 §2.2). */
export interface TurnContextPayload {
  turnId: string;
  model: { connectionId: string; modelId: string };
  approvalPolicy: ApprovalPolicy;
  capabilityScope: CapabilityScope;
  activeSkills: string[];
  /** Kernel prompt version for attribution (docs/10 §8). */
  promptVersion?: string;
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
  /** Tombstone (docs/02 §3.3): skipped in traversal, children relink to grandparent. */
  deleted?: boolean;
  /** Set when the attachment backing this node was quota-evicted. */
  evicted?: boolean;
}

// ---------------------------------------------------------------------------
// attachments (docs/02 §2.3)
// ---------------------------------------------------------------------------

export interface Attachment {
  id: string;
  threadId: string;
  createdAt: number;
  kind: 'image' | 'file' | 'page_snapshot' | 'screenshot' | 'page_text';
  mime: string;
  bytes: Blob;
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
