/**
 * Gatekeeper — the single interception point (docs/06 §2). Every tool call
 * (L0-L2, MCP, builtin) passes check(); no tool carries its own approval
 * logic.
 *
 * Model: blacklist-only, reads are never intercepted (owner decision
 * 2026-07-04). There is no origin whitelist — no task-scope gating, no
 * cross-scope forced approval. WRITE verdict order (first hit wins):
 *   1. sensitive-origin blacklist → DENY (not overridable by any rule)
 *   2. read-only capability → DENY (hard gate)
 *   3. sensitive payload (credentials/card) → forced ASK (flag)
 *   4. session grants → ALLOW
 *   5. rule table: (tool,origin) exact → (tool,*) → (*,origin)
 *   6. no hit → approvalPolicy default
 * READ tools (any level, any origin) return ALLOW at step 0.
 *
 * `never` = auto-DENY anything that would need approval; it is NOT
 * auto-approve (protocol-level semantics, docs/06 §1).
 */

import type {
  ApprovalFlag,
  ApprovalPolicy,
  ApprovalRequestPayload,
  CapabilityScope,
} from '../messaging/protocol';
import {
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
  const origin = ctx.originless ? '' : ctx.targetOrigin;
  const flags: ApprovalFlag[] = [];

  if (ALWAYS_ALLOW.has(call.toolName)) return { verdict: 'allow' };

  // 0. Reads are never intercepted — the agent may read any page, including
  // blacklisted origins and via L2 (screenshot). Only writes are gated.
  if (call.effects === 'read') return { verdict: 'allow' };

  // 1. Sensitive-origin blacklist — hard DENY for writes, nothing overrides it.
  if (origin && isSensitiveOrigin(ctx.sensitivePatterns, origin)) {
    return {
      verdict: 'deny',
      reason: `目标站点 ${origin} 在敏感站点黑名单中（银行/支付/政务等），Panelot 不在这类站点执行写操作。读取不受限制。`,
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
    if (sensitive.length > 0 && (thirdParty || sensitive.includes('card_number') || sensitive.includes('credential_field'))) {
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

  // 4. Session grants (acceptForSession) — in-memory, thread-scoped.
  if (ctx.sessionGrants.has(sessionGrantKey(call.toolName, origin))) return { verdict: 'allow' };

  // 5. Rule table.
  const rule = matchRules(ctx.rules, call.toolName, origin);
  if (rule) {
    if (rule.verdict === 'deny') {
      return { verdict: 'deny', reason: `被权限规则拒绝（${rule.tool} @ ${rule.origin}，来源: ${rule.source}）。` };
    }
    return { verdict: 'allow' };
  }

  // 6. Policy default (writes only reach here).
  switch (ctx.approvalPolicy) {
    case 'untrusted':
    case 'granular': // rules already consulted; unmatched falls back to ask
    case 'on-request':
      return buildAsk(); // first write asks; session grant covers the rest
    case 'never':
      return {
        verdict: 'deny',
        reason: '该动作需要审批，而审批策略为 never（从不弹窗 = 直接拒绝，绝非自动批准）。',
      };
  }
}
