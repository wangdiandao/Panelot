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

import type { ProviderErrorDetails, ProviderErrorKind } from '../providers/types';
import type { ExecuteResult } from '../tools/content/protocol';

export const PROTOCOL_VERSION = 1;
export const ENGINE_PROTOCOL = 'panelot/engine-v1' as const;
export const ENGINE_SCHEMA_HASH =
  'f90beca3a27549f7b59649cd38792cda76fb041ed12ecd85e23dcd35312c220e' as const;
export const CONTENT_SCRIPT_PROTOCOL = 'panelot/content-v1' as const;
export const CONTENT_SCRIPT_SCHEMA_HASH =
  'a599d8c67987c8e5baee9f65d15b26e11245747b873d6ecaa5d10d508664f841' as const;
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

export interface AskUserOption {
  value: string;
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  id: string;
  question: string;
  options?: AskUserOption[];
}

export type InteractionRequestPayload =
  | { kind: 'ask_user'; questions: AskUserQuestion[] }
  | { kind: 'user_action'; instruction: string; tabId?: number }
  | {
      kind: 'watch_page';
      tabId: number;
      condition:
        | { type: 'text'; value: string }
        | { type: 'text_gone'; value: string }
        | { type: 'url'; value: string }
        | { type: 'download'; downloadId: number };
      deadlineAt: number;
    }
  | { kind: 'schedule'; resumeAt: number; reason: string }
  | {
      kind: 'mcp_elicitation';
      serverId: string;
      message: string;
      requestedSchema: Record<string, unknown>;
    };

export type InteractionResponse =
  | { kind: 'submit'; value: unknown }
  | { kind: 'cancel'; note?: string }
  | { kind: 'timeout'; value?: unknown };

// ---------------------------------------------------------------------------
// Thread / Turn / Item primitives (docs/01 §2)
// ---------------------------------------------------------------------------

export type ItemKind =
  'user_message' | 'assistant_message' | 'reasoning' | 'tool_call' | 'approval' | 'system_notice';

export const ITEM_KIND_CATALOG = {
  user_message: true,
  assistant_message: true,
  reasoning: true,
  tool_call: true,
  approval: true,
  system_notice: true,
} as const satisfies Record<ItemKind, true>;

export type TurnKind = 'user' | 'title';

export const TURN_KIND_CATALOG = {
  user: true,
  title: true,
} as const satisfies Record<TurnKind, true>;

export type ProviderStopReason = 'end' | 'tool_use' | 'max_tokens' | 'content_filter';

export type StopReason =
  | Exclude<ProviderStopReason, 'tool_use'>
  /** Accepted for prior-protocol input; current loops never emit this success label. */
  | 'done'
  | 'interrupted'
  | 'error'
  | 'budget_pause';

export const STOP_REASON_CATALOG = {
  end: true,
  max_tokens: true,
  content_filter: true,
  done: true,
  interrupted: true,
  error: true,
  budget_pause: true,
} as const satisfies Record<StopReason, true>;

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

export interface PendingInteraction {
  interactionId: string;
  turnId: string;
  itemId: string;
  request: InteractionRequestPayload;
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
  pendingInteractions?: PendingInteraction[];
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
  state:
    | 'waiting_approval'
    | 'waiting_interaction'
    | 'paused_budget'
    | 'paused_uncertain'
    | 'interrupted';
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
  | { type: 'thread.delete'; submissionId: string; threadId: string }
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
  | {
      type: 'interaction.response';
      submissionId: string;
      interactionId: string;
      response: InteractionResponse;
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

export const ERROR_CODE_CATALOG = {
  protocol_mismatch: true,
  thread_not_found: true,
  turn_mismatch: true,
  turn_not_steerable: true,
  no_active_turn: true,
  queue_full: true,
  overloaded: true,
  interrupted: true,
  provider_error: true,
  not_configured: true,
  invalid_command: true,
  internal: true,
} as const satisfies Record<ErrorCode, true>;

export const PROVIDER_ERROR_KIND_CATALOG = {
  auth: true,
  rate_limit: true,
  overloaded: true,
  context_too_long: true,
  content_filter: true,
  network: true,
  protocol: true,
} as const satisfies Record<ProviderErrorKind, true>;

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
        errorKind?: ProviderErrorKind;
        providerDetails?: ProviderErrorDetails;
      }
    | { type: 'thread.created'; submissionId: string; threadId: string }
    | { type: 'thread.forked'; submissionId: string; threadId: string; newThreadId: string }
    | { type: 'thread.deleted'; threadId: string }

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
    | {
        type: 'interaction.request';
        threadId: string;
        turnId: string;
        interactionId: string;
        itemId: string;
        request: InteractionRequestPayload;
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
        activity: {
          threadId: string;
          running: boolean;
          pendingApprovals: number;
          pendingInteractions?: number;
        };
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
      result: ExecuteResult | 'pong' | 'cancelled';
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

/**
 * Runtime command catalog. `satisfies Record<Op['type'], true>` makes the
 * compiler reject both missing and invented entries when the Op union changes.
 */
export const OP_TYPE_CATALOG = {
  initialize: true,
  'thread.create': true,
  'thread.subscribe': true,
  'thread.delete': true,
  'thread.fork': true,
  'thread.selectBranch': true,
  'turn.submit': true,
  'turn.fork': true,
  'turn.steer': true,
  'turn.enqueue': true,
  'turn.interrupt': true,
  'queue.update': true,
  'queue.remove': true,
  'run.resume': true,
  'run.resolveUncertain': true,
  'approval.response': true,
  'interaction.response': true,
  ping: true,
} as const satisfies Record<Op['type'], true>;

/**
 * Runtime event catalog. Unknown event names are intentionally outside this
 * catalog so older UIs can ignore them while known event payloads remain
 * strictly validated.
 */
export const AGENT_EVENT_TYPE_CATALOG = {
  initialized: true,
  'fatal.reload_required': true,
  'command.ack': true,
  'command.rejected': true,
  pong: true,
  error: true,
  'thread.created': true,
  'thread.forked': true,
  'thread.deleted': true,
  'turn.start': true,
  'turn.complete': true,
  'token.usage': true,
  'item.start': true,
  'item.delta': true,
  'item.complete': true,
  'approval.request': true,
  'interaction.request': true,
  'thread.updated': true,
  'queue.updated': true,
  'run.recovery_required': true,
  'tabs.updated': true,
  'activity.updated': true,
} as const satisfies Record<AgentEvent['type'], true>;

export function isKnownAgentEventType(value: unknown): value is AgentEvent['type'] {
  return typeof value === 'string' && Object.hasOwn(AGENT_EVENT_TYPE_CATALOG, value);
}

/** Shallow classifier only; cross-context inputs must go through `parseOp`. */
export function isOp(value: unknown): value is Op {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    Object.hasOwn(OP_TYPE_CATALOG, (value as { type: string }).type) &&
    typeof (value as { submissionId?: unknown }).submissionId === 'string'
  );
}

export type ClientCommand = Op;
export type ThreadEvent = AgentEvent;
