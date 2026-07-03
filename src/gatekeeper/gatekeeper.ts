/**
 * Gatekeeper — the single interception point (docs/06 §2). Every tool call
 * (L0-L2, MCP, builtin) passes check(); no tool carries its own approval
 * logic.
 *
 * Verdict order (first hit wins):
 *   1. sensitive-origin blacklist → DENY (not overridable by any rule)
 *   2. capabilityScope violation → DENY (hard gate; approval cannot cross it)
 *   3. cross-scope: origin ∉ thread.scopeOrigins → forced ASK (⚠ flag)
 *   4. sensitive payload to third-party origin → forced ASK (flag)
 *   5. rule table: (tool,origin) exact → (tool,*) → (*,origin)
 *   6. no hit → approvalPolicy default
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

  // 1. Sensitive-origin blacklist — hard DENY, nothing overrides it.
  if (origin && isSensitiveOrigin(ctx.sensitivePatterns, origin)) {
    return {
      verdict: 'deny',
      reason: `目标站点 ${origin} 在敏感站点黑名单中（银行/支付/政务等），Panelot 不在这类站点执行任何操作。`,
    };
  }

  // 2. Capability scope — hard gate (docs/06 §1 axis 2).
  if (call.effects === 'write' || call.level === 'L2') {
    switch (ctx.capabilityScope) {
      case 'read-only':
        return {
          verdict: 'deny',
          reason: '当前会话为只读模式（read-only），所有写操作被拒绝。可在会话设置中调整能力域。',
        };
      case 'same-origin-write': {
        if (origin && ctx.scopeOrigins.length > 0 && !ctx.scopeOrigins.includes(origin)) {
          return {
            verdict: 'deny',
            reason: `能力域为 same-origin-write：目标 ${origin} 不在任务作用域（${ctx.scopeOrigins.join(', ')}）内，写操作被拒绝。`,
          };
        }
        break;
      }
      case 'cross-origin': {
        // 3. Cross-scope detection: new origin → forced ASK regardless of policy.
        if (origin && !ctx.scopeOrigins.includes(origin)) flags.push('cross_scope');
        break;
      }
      case 'full':
        break;
    }
  }

  // 4. Sensitive payload leaving scope → forced ASK with warning flag.
  if (call.effects === 'write' && origin) {
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

  // Forced-ask flags bypass rules and policy — a stored allow must not
  // silence a cross-scope or sensitive-payload warning. Under `never`,
  // forced-ask degrades to DENY (never ≠ auto-approve).
  if (flags.includes('cross_scope') || flags.includes('sensitive_payload')) {
    if (ctx.approvalPolicy === 'never') {
      return {
        verdict: 'deny',
        reason: flags.includes('cross_scope')
          ? `目标 ${origin} 越出任务作用域，且审批策略为 never（需要审批的动作直接拒绝）。`
          : '参数中检测到敏感内容外发，且审批策略为 never（需要审批的动作直接拒绝）。',
      };
    }
    return buildAsk();
  }

  // Session grants (acceptForSession) — in-memory, thread-scoped.
  if (ctx.sessionGrants.has(sessionGrantKey(call.toolName, origin))) return { verdict: 'allow' };

  // 5. Rule table.
  const rule = matchRules(ctx.rules, call.toolName, origin);
  if (rule) {
    if (rule.verdict === 'deny') {
      return { verdict: 'deny', reason: `被权限规则拒绝（${rule.tool} @ ${rule.origin}，来源: ${rule.source}）。` };
    }
    return { verdict: 'allow' };
  }

  // 6. Policy default.
  switch (ctx.approvalPolicy) {
    case 'untrusted':
      // Only read tools that are not L2 auto-pass.
      if (call.effects === 'read' && call.level !== 'L2') return { verdict: 'allow' };
      return buildAsk();
    case 'on-request':
      if (call.effects === 'read') return { verdict: 'allow' };
      return buildAsk(); // first write asks; session grant covers the rest
    case 'never':
      if (call.effects === 'read' && call.level !== 'L2') return { verdict: 'allow' };
      return {
        verdict: 'deny',
        reason: '该动作需要审批，而审批策略为 never（从不弹窗 = 直接拒绝，绝非自动批准）。',
      };
    case 'granular':
      // Rules already consulted; unmatched falls back to untrusted semantics.
      if (call.effects === 'read' && call.level !== 'L2') return { verdict: 'allow' };
      return buildAsk();
  }
}
