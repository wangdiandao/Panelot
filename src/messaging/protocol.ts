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

import type { ProviderErrorDetails } from '../providers/types';

export const PROTOCOL_VERSION = 1;
export const ENGINE_PROTOCOL = 'panelot/engine-v1' as const;
export const ENGINE_SCHEMA_HASH =
  'f0847bb919874375b6707b328fb7e61b367635f6bb16a45fafe4d5891d067337' as const;
export const CONTENT_SCRIPT_PROTOCOL = 'panelot/content-v1' as const;
export const CONTENT_SCRIPT_SCHEMA_HASH =
  '5183fbae23c854482874412b8703bf669cc2a0b00f0fca5413559b51da9067cd' as const;
export { DATA_IMPORT_RPC_TYPE } from '../data/maintenanceRpcProtocol';

// ---------------------------------------------------------------------------
// Content primitives
// ---------------------------------------------------------------------------

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; /** base64 without data: prefix */ data: string };

export interface BrowserTabIdentity {
  tabId: number;
  url: string;
  title: string;
}

/** Browser identity captured by the UI before any asynchronous submission work. */
export interface SubmissionBrowserContext {
  capturedAt: number;
  defaultTab?: BrowserTabIdentity;
  referencedTabs: BrowserTabIdentity[];
}

/** A context block attached to user input via @-references (page, selection…). */
export interface ContextBlock {
  kind: 'page' | 'selection' | 'screenshot' | 'tab' | 'mcp_resource' | 'file' | 'skill';
  /** Human label shown on the chip, e.g. the page title. */
  label: string;
  /** Origin the content came from — drives untrusted-content fencing (docs/10 §4). */
  origin?: string;
  trust?: 'trusted' | 'untrusted';
  provenance?: 'user' | 'page' | 'mcp' | 'tool' | 'import' | 'plugin';
  sourceRef?: string;
  /** Exact source tab for page/tab/selection context; never re-resolved from active tab. */
  tab?: BrowserTabIdentity;
  content: ContentBlock[];
  /** Rough token estimate for UI display. */
  approxTokens?: number;
}

export interface UserInput {
  text: string;
  attachmentIds?: string[];
  attachedContext?: ContextBlock[];
  browserContext?: SubmissionBrowserContext;
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
 * Permission tiers:
 *  - `always`: EVERY tool call asks, reads included (the one policy where
 *    reads are gated — implemented as ask, never deny);
 *  - `untrusted` (default): reads free, writes ask;
 *  - `auto`: writes auto-allowed; the safety floor (sensitive-origin
 *    blacklist, sensitive-payload forced ask, rule-table deny/ask) still
 *    applies — auto is NOT a bypass.
 */
export type PermissionPolicy = 'always' | 'untrusted' | 'auto';

export type ApprovalDecision =
  | { kind: 'accept' }
  | { kind: 'acceptForSession' }
  | { kind: 'acceptForSite' }
  | { kind: 'decline'; note?: string }
  | { kind: 'cancel' };

/** `cross_scope` is legacy (origin-whitelist model) — no longer emitted. */
export type ApprovalFlag =
  'cross_scope' | 'sensitive_payload' | 'escalation_l2' | 'host_permission';

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
  'user_message' | 'assistant_message' | 'reasoning' | 'tool_call' | 'approval' | 'system_notice';

export type TurnKind = 'user' | 'title';

export type ProviderStopReason = 'end' | 'tool_use' | 'max_tokens' | 'content_filter';

export type StopReason =
  | Exclude<ProviderStopReason, 'tool_use'>
  /** Accepted for prior-protocol input; current loops never emit this success label. */
  | 'done'
  | 'interrupted'
  | 'error'
  | 'budget_pause';

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
  permissionPolicy?: PermissionPolicy;
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
  revision: number;
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
  /** Added by EngineHost at the same admission point as the initialized event. */
  stream?: ThreadStreamCursor;
  meta: ThreadSnapshotMeta;
  items: SnapshotItem[];
  activeTurn: ActiveTurnState | null;
  pendingApprovals: PendingApproval[];
  queuedInputs: number;
  queuedRuns: {
    runId: string;
    input: UserInput;
    overrides?: TurnOverrides;
    revision: number;
  }[];
  recoverableRuns: RunRecoveryState[];
}

export interface ThreadStreamCursor {
  threadId: string;
  /** Persisted monotonic Service Worker generation. */
  epoch: number;
  /** Monotonic within one thread and epoch. */
  sequence: number;
}

export interface RunRecoveryState {
  runId: string;
  state: 'waiting_approval' | 'paused_budget' | 'paused_uncertain' | 'interrupted';
  revision: number;
  stopReason?: string;
  pendingTool?: {
    toolName: string;
    params: unknown;
    target?: { tabId?: number; frameId?: number; origin?: string; serverId?: string };
    effect: 'read' | 'write';
    recovery: 'retry-safe' | 'inspect-first' | 'never-retry';
  };
}

// ---------------------------------------------------------------------------
// Op — client → engine (docs/01 §3.2)
// ---------------------------------------------------------------------------

export type Op =
  | {
      type: 'initialize';
      submissionId: string;
      protocol?: string;
      schemaHash?: string;
      clientId?: string;
      protocolVersion?: number;
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
  | {
      type: 'turn.enqueue';
      submissionId: string;
      threadId: string;
      input: UserInput;
      overrides?: TurnOverrides;
    }
  | { type: 'turn.interrupt'; submissionId: string; threadId: string }
  | {
      type: 'queue.update';
      submissionId: string;
      threadId: string;
      runId: string;
      input: UserInput;
      overrides?: TurnOverrides;
    }
  | { type: 'queue.remove'; submissionId: string; threadId: string; runId: string }
  | { type: 'run.resume'; submissionId: string; threadId: string; runId: string }
  | {
      type: 'run.resolveUncertain';
      submissionId: string;
      threadId: string;
      runId: string;
      resolution: 'retry' | 'mark_done' | 'fail';
    }
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
  | 'overloaded'
  | 'interrupted'
  | 'provider_error'
  | 'not_configured'
  | 'invalid_command'
  | 'internal';

export interface CommandAck {
  type: 'command.ack';
  submissionId: string;
  threadId?: string;
  runId?: string;
  revision?: number;
}

export interface CommandRejected {
  type: 'command.rejected';
  submissionId: string;
  code: ErrorCode;
  message: string;
  threadId?: string;
  revision?: number;
}

export type AgentEvent =
  // —— responses (echo submissionId) ——
  (
    | {
        type: 'initialized';
        submissionId: string;
        protocol: typeof ENGINE_PROTOCOL;
        schemaHash: typeof ENGINE_SCHEMA_HASH;
        snapshot?: ThreadSnapshot;
      }
    | {
        type: 'fatal.reload_required';
        submissionId: string;
        protocol: string;
        schemaHash: string;
        message: string;
      }
    | CommandAck
    | CommandRejected
    | { type: 'pong'; submissionId: string }
    | {
        type: 'error';
        submissionId?: string;
        threadId?: string;
        code: ErrorCode;
        message: string;
        retryable: boolean;
        /** Provider error taxonomy for human-readable attribution (docs/03 §7). */
        errorKind?:
          | 'auth'
          | 'rate_limit'
          | 'overloaded'
          | 'context_too_long'
          | 'content_filter'
          | 'network'
          | 'protocol';
        providerDetails?: ProviderErrorDetails;
      }
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
    | {
        type: 'thread.updated';
        threadId: string;
        revision: number;
        patch: Partial<ThreadSnapshotMeta>;
      }
    | {
        type: 'queue.updated';
        threadId: string;
        pending: number;
        runs: ThreadSnapshot['queuedRuns'];
      }
    | { type: 'run.recovery_required'; threadId: string; run: RunRecoveryState }
    | {
        /** Agent touched-tab audit trail changed (docs/05 §6). */
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
      }
  ) & { stream?: ThreadStreamCursor };

// ---------------------------------------------------------------------------
// Content-script protocol (engine ⇄ content script, docs/01 §5)
// ---------------------------------------------------------------------------

export interface ContentScriptExecuteOp {
  protocol: typeof CONTENT_SCRIPT_PROTOCOL;
  schemaHash: typeof CONTENT_SCRIPT_SCHEMA_HASH;
  kind: 'execute';
  requestId: string;
  tool: string;
  params: unknown;
  /** Absolute wall-clock deadline shared by the whole tool attempt. */
  deadlineAt: number;
}

export interface ContentScriptCancelOp {
  protocol: typeof CONTENT_SCRIPT_PROTOCOL;
  schemaHash: typeof CONTENT_SCRIPT_SCHEMA_HASH;
  kind: 'cancel';
  requestId: string;
  cancelRequestId: string;
}

export interface ContentScriptPingOp {
  protocol: typeof CONTENT_SCRIPT_PROTOCOL;
  schemaHash: typeof CONTENT_SCRIPT_SCHEMA_HASH;
  kind: 'ping';
  requestId: string;
}

export type ContentScriptOp = ContentScriptExecuteOp | ContentScriptCancelOp | ContentScriptPingOp;

export type ContentScriptResult =
  | {
      protocol: typeof CONTENT_SCRIPT_PROTOCOL;
      schemaHash: typeof CONTENT_SCRIPT_SCHEMA_HASH;
      requestId: string;
      ok: true;
      result: unknown;
    }
  | {
      protocol: typeof CONTENT_SCRIPT_PROTOCOL;
      schemaHash: typeof CONTENT_SCRIPT_SCHEMA_HASH;
      requestId: string;
      ok: false;
      /** Kept for one compatibility cycle while callers adopt structured failures. */
      error: string;
      failure?: import('../tools/action/types').ActionFailure;
    };

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
  'queue.update',
  'queue.remove',
  'run.resume',
  'run.resolveUncertain',
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

export type ClientCommand = Op;
export type ThreadEvent = AgentEvent;
