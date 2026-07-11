/**
 * Gatekeeper — the single interception point (docs/06 §2). Every tool call
 * (L0-L2, MCP, builtin) passes check(); no tool carries its own approval
 * logic.
 *
 * Model: blacklist-only, reads are never intercepted (owner decision
 * 2026-07-04) — EXCEPT under the `always` policy tier (2026-07-05), where
 * every call asks first (reads gated as ASK, never DENY). There is no origin
 * whitelist — no task-scope gating, no cross-scope forced approval.
 * WRITE verdict order (first hit wins):
 *   1. sensitive-origin blacklist → DENY (not overridable by any rule)
 *   2. read-only capability → DENY (hard gate)
 *   3. sensitive payload (credentials/card) → forced ASK (flag)
 *   4. rule table deny/ask: (tool,origin) exact → (tool,*) → (*,origin);
 *      'ask' is a per-tool/site confirmation requirement that no session
 *      grant can silence (agent-browser's confirm verdict)
 *   5. session grants → ALLOW; then rule-table allow → ALLOW
 *   6. no hit → approvalPolicy default (`auto` allows here — steps 1-4 are
 *      the safety floor that `auto` can never bypass)
 * READ tools (any level, any origin) return ALLOW at step 0 unless the
 * policy is `always`.
 *
 * Origin attribution: URL-bearing writes (navigate/tab_open/download) are
 * judged by their DESTINATION origin, not the current tab — navigating away
 * from a blacklisted page is legal; navigating TO one is not.
 *
 * `never` = auto-DENY anything that would need approval; it is NOT
 * auto-approve (protocol-level semantics, docs/06 §1). `auto` is the
 * auto-approve tier — allow at the policy-default step only.
 */

import type {
  ApprovalFlag,
  ApprovalPolicy,
  ApprovalRequestPayload,
  CapabilityScope,
} from '../messaging/protocol';
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
  approvalPolicy: ApprovalPolicy;
  capabilityScope: CapabilityScope;
  /** Origins this task has already touched (docs/02 §2.1). */
  scopeOrigins: string[];
  rules: PermissionRule[];
  sensitivePatterns: readonly string[];
  /** Session-scoped grants from acceptForSession (in-memory, docs/06 §4). */
  sessionGrants: ReadonlySet<string>;
  /** Tools that don't target a page origin (builtin fetch/memory/todo). */
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
const ALWAYS_ALLOW = new Set(['todo_write', 'memory_read', 'load_skill']);

export function checkGate(call: GatekeeperCall, ctx: GatekeeperContext): GatekeeperVerdict {
  // URL-bearing writes are attributed to their destination: blacklist, rules
  // and grants key on where the action goes, not where the tab currently is.
  const destination = destinationOrigin(call.toolName, call.params);
  const origin = destination ?? (ctx.originless ? '' : ctx.targetOrigin);
  const flags: ApprovalFlag[] = [];

  if (ALWAYS_ALLOW.has(call.toolName)) return { verdict: 'allow' };

  // 0. Reads are never intercepted — the agent may read any page, including
  // blacklisted origins and via L2 (screenshot). Only writes are gated.
  // Exception (`always` tier, 2026-07-05): every call asks first, reads
  // included — but session grants still apply so an accepted read isn't
  // re-asked every step, and reads are only ever ASK, never DENY.
  if (call.effects === 'read') {
    if (ctx.approvalPolicy !== 'always') return { verdict: 'allow' };
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
        ? `目标地址 ${origin} 在敏感站点黑名单中（银行/支付/政务等），Panelot 不主动前往这类站点执行操作。`
        : `目标站点 ${origin} 在敏感站点黑名单中（银行/支付/政务等），Panelot 不在这类站点执行写操作。读取不受限制。`,
    };
  }

  // 2. Read-only capability — the only capability hard gate (no origin
  // whitelist: same-origin-write / cross-origin / full all mean "writes
  // allowed", subject to the approval policy below).
  if (ctx.capabilityScope === 'read-only') {
    return {
      verdict: 'deny',
      reason: '当前会话为只读模式（read-only），所有写操作被拒绝。可在会话设置中调整能力域。',
    };
  }

  // 3. Sensitive payload (credentials/card/email leaving the task's sites)
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

  // Forced-ask: a stored allow rule must not silence a sensitive-payload
  // warning. Under `never`, forced-ask degrades to DENY (never ≠ auto-approve).
  if (flags.includes('sensitive_payload')) {
    if (ctx.approvalPolicy === 'never') {
      return {
        verdict: 'deny',
        reason: '参数中检测到敏感内容外发，且审批策略为 never（需要审批的动作直接拒绝）。',
      };
    }
    return buildAsk();
  }

  // 4. Rule table deny/ask — consulted BEFORE session grants so an 'ask' or
  // 'deny' rule cannot be silenced by a broad acceptForSession grant.
  const rule = matchRules(ctx.rules, call.toolName, origin);
  if (rule?.verdict === 'deny') {
    return {
      verdict: 'deny',
      reason: `被权限规则拒绝（${rule.tool} @ ${rule.origin}，来源: ${rule.source}）。`,
    };
  }
  if (rule?.verdict === 'ask') {
    // A confirmation requirement, not a default: under `never` it degrades to
    // DENY (never ≠ auto-approve), same as every other forced ask.
    if (ctx.approvalPolicy === 'never') {
      return {
        verdict: 'deny',
        reason: `该动作被权限规则标记为需确认（${rule.tool} @ ${rule.origin}），而审批策略为 never（需要审批的动作直接拒绝）。`,
      };
    }
    return buildAsk();
  }

  // 5. Session grants (acceptForSession) — in-memory, thread-scoped — then
  // rule-table allows.
  if (ctx.sessionGrants.has(sessionGrantKey(call.toolName, origin))) return { verdict: 'allow' };
  if (rule) return { verdict: 'allow' };

  // 6. Policy default (writes only reach here).
  switch (ctx.approvalPolicy) {
    case 'always':
    case 'untrusted':
    case 'granular': // rules already consulted; unmatched falls back to ask
    case 'on-request':
      return buildAsk(); // first write asks; session grant covers the rest
    case 'auto':
      // Auto-approve tier: the safety floor above (blacklist, read-only
      // gate, sensitive-payload forced ask, rule deny/ask) already had its
      // say — an unmatched write is allowed without asking.
      return { verdict: 'allow' };
    case 'never':
      return {
        verdict: 'deny',
        reason: '该动作需要审批，而审批策略为 never（从不弹窗 = 直接拒绝，绝非自动批准）。',
      };
  }
}
