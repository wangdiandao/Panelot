/**
 * Gatekeeper — the single interception point (docs/development/permissions.md §2). Every tool call
 * (L0-L2, MCP, builtin) passes check(); no tool carries its own approval
 * logic.
 *
 * Model: blacklist-only, reads are never intercepted except under the
 * `always` policy tier, where
 * every call asks first (reads gated as ASK, never DENY). There is no origin
 * whitelist — no task-scope gating, no cross-scope forced approval.
 * WRITE verdict order (first hit wins):
 *   1. sensitive-origin blacklist → DENY (not overridable by any rule)
 *   2. sensitive payload (credentials/card) → forced ASK (flag)
 *   3. rule table deny/ask: (tool,origin) exact → (tool,*) → (*,origin);
 *      'ask' is a per-tool/site confirmation requirement that no session
 *      grant can silence (agent-browser's confirm verdict)
 *   4. session grants → ALLOW; then rule-table allow → ALLOW
 *   5. no hit → permissionPolicy default (`auto` allows here — steps 1-3 are
 *      the safety floor that `auto` can never bypass)
 * READ tools (any level, any origin) return ALLOW at step 0 unless the
 * policy is `always`.
 *
 * Origin attribution: URL-bearing writes (navigate/tab_open/download) are
 * judged by their DESTINATION origin, not the current tab — navigating away
 * from a blacklisted page is legal; navigating TO one is not.
 *
 * `auto` is the auto-approve tier — allow at the policy-default step only.
 */

import type { ApprovalFlag, ApprovalRequestPayload, PermissionPolicy } from '../messaging/protocol';
import {
  destinationOrigin,
  detectSensitivePayload,
  isSensitiveOrigin,
  matchRules,
  type PermissionRule,
} from './rules';

export interface GatekeeperCall {
  toolName: string;
  label?: string;
  params: unknown;
  effects: 'read' | 'write';
  /** L2 tools force escalation semantics. */
  level?: string;
}

export interface GatekeeperContext {
  threadId: string;
  targetOrigin: string;
  permissionPolicy: PermissionPolicy;
  /** Origins this task has already touched (docs/development/data-model.md §2.1). */
  scopeOrigins: string[];
  rules: PermissionRule[];
  sensitivePatterns: readonly string[];
  /** Session-scoped grants from acceptForSession (storage.session, docs/development/permissions.md §4). */
  sessionGrants: ReadonlySet<string>;
  /** Tools that don't target a page origin (for example builtin fetch or memory). */
  originless?: boolean;
  /** Snapshot line for the approval preview. */
  previewLine?: string;
}

export type GatekeeperVerdict =
  | { verdict: 'allow' }
  | { verdict: 'ask'; request: ApprovalRequestPayload }
  | { verdict: 'deny'; reason: string };

export function sessionGrantKey(tool: string, origin: string): string {
  return `${tool} ${origin}`;
}

/** Tools that never require approval regardless of policy (pure UI/read). */
const ALWAYS_ALLOW = new Set([
  'memory_read',
  'load_skill',
  'ask_user',
  'request_user_action',
  'schedule_resume',
]);

export function checkGate(call: GatekeeperCall, ctx: GatekeeperContext): GatekeeperVerdict {
  // URL-bearing writes are attributed to their destination: blacklist, rules
  // and grants key on where the action goes, not where the tab currently is.
  const destination = destinationOrigin(call.toolName, call.params);
  const origin = destination ?? (ctx.originless ? '' : ctx.targetOrigin);
  const flags: ApprovalFlag[] = [];

  if (ALWAYS_ALLOW.has(call.toolName)) return { verdict: 'allow' };

  // 0. Reads are never intercepted — the agent may read any page, including
  // blacklisted origins and via L2 (screenshot). Only writes are gated.
  // Exception: under `always`, every call asks first, reads
  // included — but session grants still apply so an accepted read isn't
  // re-asked every step, and reads are only ever ASK, never DENY.
  if (call.effects === 'read') {
    if (ctx.permissionPolicy !== 'always') return { verdict: 'allow' };
    if (ctx.sessionGrants.has(sessionGrantKey(call.toolName, origin))) return { verdict: 'allow' };
    if (call.level === 'L2') flags.push('escalation_l2');
    return {
      verdict: 'ask',
      request: {
        tool: call.toolName,
        label: call.label ?? call.toolName,
        params: call.params,
        targetOrigin: origin,
        flags,
        preview: ctx.previewLine ? { snapshotLine: ctx.previewLine } : undefined,
      },
    };
  }

  // 1a. Script-execution schemes via navigation are run_javascript in
  // disguise (javascript:/data: URLs execute in the page) — hard DENY,
  // matching run_javascript's denied-by-default posture.
  if (destination && /^(javascript|data|vbscript):/i.test(destination)) {
    return {
      verdict: 'deny',
      reason: `导航目标使用脚本执行协议（${destination.split(':')[0]}:），等同于在页面执行脚本，已拒绝。如需操作页面请使用结构化工具。`,
    };
  }

  // 1. Sensitive-origin blacklist — hard DENY for writes, nothing overrides it.
  if (origin && isSensitiveOrigin(ctx.sensitivePatterns, origin)) {
    return {
      verdict: 'deny',
      reason: destination
        ? `目标地址 ${origin} 在敏感站点黑名单中（银行、支付、政务等）。Panelot 不会导航到这类站点并执行操作。`
        : `目标站点 ${origin} 在敏感站点黑名单中（银行、支付、政务等）。Panelot 不会在这类站点执行写操作；读取不受限制。`,
    };
  }

  // 2. Sensitive payload (credentials/card/email leaving the task's sites)
  // → forced ASK with warning flag. Data protection, not an origin whitelist.
  if (origin) {
    const sensitive = detectSensitivePayload(call.params);
    const thirdParty = !ctx.scopeOrigins.includes(origin);
    if (
      sensitive.length > 0 &&
      (thirdParty || sensitive.includes('card_number') || sensitive.includes('credential_field'))
    ) {
      flags.push('sensitive_payload');
    }
  }

  if (call.level === 'L2') flags.push('escalation_l2');

  const buildAsk = (): GatekeeperVerdict => ({
    verdict: 'ask',
    request: {
      tool: call.toolName,
      label: call.label ?? call.toolName,
      params: call.params,
      targetOrigin: origin,
      flags,
      preview: ctx.previewLine ? { snapshotLine: ctx.previewLine } : undefined,
    },
  });

  // 3. Rule table deny/ask — consulted before safety prompts and session
  // grants so an explicit deny always wins and an ask cannot be silenced.
  // 'deny' rule cannot be silenced by a broad acceptForSession grant.
  const rule = matchRules(ctx.rules, call.toolName, origin);
  if (rule?.verdict === 'deny') {
    return {
      verdict: 'deny',
      reason: `权限规则拒绝了此操作（${rule.tool} @ ${rule.origin}，来源：${rule.source}）。`,
    };
  }
  if (rule?.verdict === 'ask') {
    return buildAsk();
  }

  // A stored allow rule must not silence a sensitive-payload warning.
  if (flags.includes('sensitive_payload')) {
    return buildAsk();
  }

  // 4. Session grants (acceptForSession) — browser-session, thread-scoped — then
  // rule-table allows.
  if (ctx.sessionGrants.has(sessionGrantKey(call.toolName, origin))) return { verdict: 'allow' };
  if (rule) return { verdict: 'allow' };

  // 5. Policy default (writes only reach here).
  switch (ctx.permissionPolicy) {
    case 'always':
    case 'untrusted':
      return buildAsk(); // first write asks; session grant covers the rest
    case 'auto':
      // Auto-approve tier: the safety floor above (blacklist,
      // sensitive-payload forced ask, rule deny/ask) already had its
      // say — an unmatched write is allowed without asking.
      return { verdict: 'allow' };
  }
}
