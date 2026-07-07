/**
 * Single source of truth for all cross-context message types.
 *
 * The engine (background SW) and every UI entrypoint import this file;
 * copying any of these definitions elsewhere is forbidden (docs/01 §3.1).
 *
 * Forward compatibility: `AgentEvent` is an open union — UIs MUST ignore
 * unknown `type` values without erroring, so the engine can ship new events
 * before the UI knows about them.
 */

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Content primitives
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; /** base64 without data: prefix */ data: string };

/** A context block attached to user input via @-references (page, selection…). */
export interface ContextBlock {
  kind: 'page' | 'selection' | 'screenshot' | 'tab' | 'mcp_resource' | 'file' | 'skill';
  /** Human label shown on the chip, e.g. the page title. */
  label: string;
  /** Origin the content came from — drives untrusted-content fencing (docs/10 §4). */
  origin?: string;
  content: ContentBlock[];
  /** Rough token estimate for UI display. */
  approxTokens?: number;
}

export interface UserInput {
  text: string;
  attachmentIds?: string[];
  attachedContext?: ContextBlock[];
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
}

// ---------------------------------------------------------------------------
// Permissions (docs/06 §1) — semantics are defined HERE and in docs/06 only.
// ---------------------------------------------------------------------------

/**
 * When to stop and ask the user.
 * `never` means "auto-DENY anything that would need approval" — it is NOT
 * auto-approve (docs/06 §1, Codex semantic-ambiguity lesson).
 * Composer-facing tiers (2026-07-05):
 *  - `always`: EVERY tool call asks, reads included (the one policy where
 *    reads are gated — implemented as ask, never deny);
 *  - `untrusted` (default): reads free, writes ask;
 *  - `auto`: writes auto-allowed; the safety floor (sensitive-origin
 *    blacklist, sensitive-payload forced ask, rule-table deny/ask) still
 *    applies — auto is NOT a bypass.
 */
export type ApprovalPolicy = 'always' | 'untrusted' | 'on-request' | 'never' | 'granular' | 'auto';

/**
 * Hard capability boundary — approval cannot cross it. Blacklist-only model
 * (2026-07-04): reads are never gated; only `read-only` still blocks writes.
 * `same-origin-write` / `cross-origin` are legacy values kept for stored
 * threads and behave like `full`.
 */
export type CapabilityScope = 'read-only' | 'same-origin-write' | 'cross-origin' | 'full';

export type ApprovalDecision =
  | { kind: 'accept' }
  | { kind: 'acceptForSession' }
  | { kind: 'acceptForSite' }
  | { kind: 'decline'; note?: string }
  | { kind: 'cancel' };

/** `cross_scope` is legacy (origin-whitelist model) — no longer emitted. */
export type ApprovalFlag = 'cross_scope' | 'sensitive_payload' | 'escalation_l2';

export interface ApprovalRequestPayload {
  tool: string;
  label: string;
  /** Complete tool params — the UI must render them in full (docs/06 §4). */
  params: unknown;
  targetOrigin: string;
  flags: ApprovalFlag[];
  preview?: { snapshotLine?: string; screenshotAttachmentId?: string };
}

// ---------------------------------------------------------------------------
// Thread / Turn / Item primitives (docs/01 §2)
// ---------------------------------------------------------------------------

export type ItemKind =
  | 'user_message'
  | 'assistant_message'
  | 'reasoning'
  | 'tool_call'
  | 'approval'
  | 'system_notice';

export type TurnKind = 'user' | 'title';

export type StopReason = 'done' | 'interrupted' | 'error' | 'budget_pause';

export interface ItemMeta {
  /** For tool_call items: tool identity + display label + params summary. */
  toolName?: string;
  label?: string;
  paramsSummary?: string;
  level?: ToolLevel;
}

export type ToolLevel = 'L0' | 'L1' | 'L2' | 'mcp' | 'builtin';

// ---------------------------------------------------------------------------
// Turn overrides (per-turn model/permission override, docs/01 §3.2)
// ---------------------------------------------------------------------------

export interface TurnOverrides {
  model?: { connectionId: string; modelId: string };
  approvalPolicy?: ApprovalPolicy;
  capabilityScope?: CapabilityScope;
  /** Restrict the tool registry for this turn (pure-chat / L0+L1 / full). */
  enabledToolLevels?: ('L0' | 'L1' | 'L2' | 'mcp')[];
}

// ---------------------------------------------------------------------------
// Thread snapshot (reconnect recovery, docs/01 §3.4)
// ---------------------------------------------------------------------------

/** Rendered form of a node for UI consumption (derived via buildSessionContext). */
export interface SnapshotItem {
  nodeId: string;
  kind:
    | 'user_message'
    | 'assistant_message'
    | 'tool_call'
    | 'tool_result'
    | 'approval_decision'
    | 'system_notice';
  ts: number;
  payload: unknown;
  /** Sibling info for the branch switcher: [index, count] when count > 1. */
  branch?: { index: number; count: number };
}

export interface ActiveTurnState {
  turnId: string;
  turnKind: TurnKind;
  steerable: boolean;
  startedAt: number;
  /** True when the previous SW instance died mid-turn — UI offers "continue". */
  wasInterrupted?: boolean;
}

export interface PendingApproval {
  approvalId: string;
  turnId: string;
  request: ApprovalRequestPayload;
  requestedAt: number;
}

export interface ThreadSnapshotMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  leafId: string | null;
  preset?: string;
  archived: boolean;
  pinned: boolean;
  stats: { turns: number; totalTokens: number; costUsd: number };
}

export interface ThreadSnapshot {
  meta: ThreadSnapshotMeta;
  items: SnapshotItem[];
  activeTurn: ActiveTurnState | null;
  pendingApprovals: PendingApproval[];
  queuedInputs: number;
}

// ---------------------------------------------------------------------------
// Op — client → engine (docs/01 §3.2)
// ---------------------------------------------------------------------------

export type Op =
  | {
      type: 'initialize';
      submissionId: string;
      protocolVersion: number;
      subscribe?: { threadId: string };
    }
  | { type: 'thread.create'; submissionId: string; preset?: string; folderId?: string }
  | { type: 'thread.subscribe'; submissionId: string; threadId: string }
  | { type: 'thread.fork'; submissionId: string; threadId: string; atNodeId: string }
  | {
      /** Branch switch: move leafId to the sibling's deepest default descendant. */
      type: 'thread.selectBranch';
      submissionId: string;
      threadId: string;
      nodeId: string;
    }
  | {
      type: 'turn.submit';
      submissionId: string;
      threadId: string;
      input: UserInput;
      overrides?: TurnOverrides;
    }
  | {
      /**
       * Branch-and-run (docs/02 §3.2 forkAt): append `input` as a SIBLING of
       * `siblingOfNodeId` and start a turn from there. Regenerate = fork at
       * the assistant message with its parent user text; edit-and-resend =
       * fork at the user message with the edited text.
       */
      type: 'turn.fork';
      submissionId: string;
      threadId: string;
      siblingOfNodeId: string;
      input: UserInput;
      overrides?: TurnOverrides;
    }
  | {
      type: 'turn.steer';
      submissionId: string;
      threadId: string;
      /** Must equal the currently active turn, else the engine errors. */
      expectedTurnId: string;
      input: UserInput;
    }
  | { type: 'turn.enqueue'; submissionId: string; threadId: string; input: UserInput }
  | { type: 'turn.interrupt'; submissionId: string; threadId: string }
  | {
      type: 'approval.response';
      submissionId: string;
      approvalId: string;
      decision: ApprovalDecision;
    }
  | { type: 'ping'; submissionId: string };

// ---------------------------------------------------------------------------
// AgentEvent — engine → client (docs/01 §3.3)
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'protocol_mismatch'
  | 'thread_not_found'
  | 'turn_mismatch'
  | 'turn_not_steerable'
  | 'no_active_turn'
  | 'queue_full'
  | 'provider_error'
  | 'not_configured'
  | 'internal';

export type AgentEvent =
  // —— responses (echo submissionId) ——
  | {
      type: 'initialized';
      submissionId: string;
      protocolVersion: number;
      snapshot?: ThreadSnapshot;
    }
  | { type: 'pong'; submissionId: string }
  | {
      type: 'error';
      submissionId?: string;
      code: ErrorCode;
      message: string;
      retryable: boolean;
      /** Provider error taxonomy for human-readable attribution (docs/03 §7). */
      errorKind?: 'auth' | 'rate_limit' | 'overloaded' | 'context_too_long' | 'content_filter' | 'network' | 'protocol';
    }
  | { type: 'overloaded'; submissionId: string }
  | { type: 'thread.created'; submissionId: string; threadId: string }
  | { type: 'thread.forked'; submissionId: string; threadId: string; newThreadId: string }

  // —— turn lifecycle ——
  | {
      type: 'turn.start';
      threadId: string;
      turnId: string;
      turnKind: TurnKind;
      steerable: boolean;
    }
  | { type: 'turn.complete'; threadId: string; turnId: string; stopReason: StopReason }
  | {
      type: 'token.usage';
      threadId: string;
      turnId: string;
      usage: Usage;
      costUsd?: number;
    }

  // —— item three-phase ——
  | {
      type: 'item.start';
      threadId: string;
      turnId: string;
      itemId: string;
      kind: ItemKind;
      meta: ItemMeta;
    }
  | {
      type: 'item.delta';
      threadId: string;
      itemId: string;
      delta: { text?: string; reasoning?: string; toolProgress?: unknown };
    }
  | {
      type: 'item.complete';
      threadId: string;
      itemId: string;
      result?: { ok: boolean; details?: unknown };
    }

  // —— engine-initiated RPC ——
  | {
      type: 'approval.request';
      threadId: string;
      turnId: string;
      approvalId: string;
      request: ApprovalRequestPayload;
    }
  // —— broadcasts ——
  | { type: 'thread.updated'; threadId: string; patch: Partial<ThreadSnapshotMeta> }
  | { type: 'queue.updated'; threadId: string; pending: number }
  | {
      /** Agent touched-tab audit trail changed (docs/05 §6 → task panel, docs/09 §3.1). */
      type: 'tabs.updated';
      threadId: string;
      tabs: { tabId: number; title: string; url: string }[];
    }
  | {
      /**
       * Cross-thread activity signal for the sidebar (docs/09 §3.1 row
       * indicators). Deliberately has NO top-level threadId — the host's
       * broadcast filter is thread-scoped, and this event must reach clients
       * subscribed to OTHER threads (the whole point).
       */
      type: 'activity.updated';
      activity: { threadId: string; running: boolean; pendingApprovals: number };
    };

// ---------------------------------------------------------------------------
// Content-script protocol (engine ⇄ content script, docs/01 §5)
// ---------------------------------------------------------------------------

export interface ContentScriptOp {
  requestId: string;
  tool: string;
  params: unknown;
}

export type ContentScriptResult =
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; error: string };

// ---------------------------------------------------------------------------
// Type guards / helpers
// ---------------------------------------------------------------------------

const OP_TYPES = new Set<Op['type']>([
  'initialize',
  'thread.create',
  'thread.subscribe',
  'thread.fork',
  'thread.selectBranch',
  'turn.submit',
  'turn.fork',
  'turn.steer',
  'turn.enqueue',
  'turn.interrupt',
  'approval.response',
  'ping',
]);

export function isOp(value: unknown): value is Op {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    OP_TYPES.has((value as { type: Op['type'] }).type) &&
    typeof (value as { submissionId?: unknown }).submissionId === 'string'
  );
}
