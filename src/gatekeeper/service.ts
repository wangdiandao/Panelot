/**
 * GatekeeperService: stateful wrapper around the pure checkGate — loads
 * rules/blacklist from storage, tracks session grants, persists
 * acceptForSite rules and scopeOrigins growth (docs/06 §2-4).
 */

import type { ApprovalDecision, ApprovalPolicy, CapabilityScope } from '../messaging/protocol';
import type { PanelotDB } from '../db/schema';
import { storageGet, storageSet } from '../settings/store';
import { checkGate, sessionGrantKey, type GatekeeperCall, type GatekeeperVerdict } from './gatekeeper';
import { DEFAULT_SENSITIVE_PATTERNS, type PermissionRule } from './rules';
import type { GlobalSettings } from '../settings/store';
import { storageGet as globalStorageGet } from '../settings/store';

const RULES_KEY = 'permission_rules';
const SENSITIVE_KEY = 'sensitive_origins';

export interface ThreadPermissionConfig {
  approvalPolicy: ApprovalPolicy;
  capabilityScope: CapabilityScope;
}

const DEFAULT_CONFIG: ThreadPermissionConfig = {
  approvalPolicy: 'untrusted',
  capabilityScope: 'cross-origin',
};

export class GatekeeperService {
  /** threadId → session grants (acceptForSession; memory only, docs/06 §4). */
  private sessionGrants = new Map<string, Set<string>>();
  /** threadId → per-thread axis overrides. */
  private threadConfig = new Map<string, ThreadPermissionConfig>();

  constructor(
    private db: PanelotDB,
    private getOrigin: (threadId: string) => Promise<string>,
  ) {}

  setThreadConfig(threadId: string, config: Partial<ThreadPermissionConfig>): void {
    const current = this.threadConfig.get(threadId) ?? { ...DEFAULT_CONFIG };
    this.threadConfig.set(threadId, { ...current, ...config });
  }

  getThreadConfig(threadId: string): ThreadPermissionConfig {
    return this.threadConfig.get(threadId) ?? { ...DEFAULT_CONFIG };
  }

  async check(call: GatekeeperCall & { level?: string }, threadId: string): Promise<GatekeeperVerdict> {
    const [rules, sensitiveUser, thread, origin] = await Promise.all([
      storageGet<PermissionRule[]>(RULES_KEY, []),
      storageGet<string[]>(SENSITIVE_KEY, []),
      this.db.threads.get(threadId),
      this.getOrigin(threadId),
    ]);
    // Per-thread override wins; otherwise fall back to the configured defaults.
    let config = this.threadConfig.get(threadId);
    if (!config) {
      const global = await globalStorageGet<GlobalSettings>('global_settings', {});
      config = {
        approvalPolicy: (global.defaultApprovalPolicy as ThreadPermissionConfig['approvalPolicy']) ?? DEFAULT_CONFIG.approvalPolicy,
        capabilityScope: (global.defaultCapabilityScope as ThreadPermissionConfig['capabilityScope']) ?? DEFAULT_CONFIG.capabilityScope,
      };
    }
    const originless = call.level === 'builtin' && call.toolName !== 'download';

    const verdict = checkGate(call, {
      threadId,
      targetOrigin: origin,
      approvalPolicy: config.approvalPolicy,
      capabilityScope: config.capabilityScope,
      scopeOrigins: thread?.scopeOrigins ?? [],
      rules,
      sensitivePatterns: [...DEFAULT_SENSITIVE_PATTERNS, ...sensitiveUser],
      sessionGrants: this.sessionGrants.get(threadId) ?? new Set(),
      originless,
    });
    return verdict;
  }

  /**
   * Apply an approval decision's side effects (docs/06 §4):
   *  - accept: origin joins scopeOrigins (cross-scope approved once = in scope)
   *  - acceptForSession: in-memory (tool, origin) grant for this thread
   *  - acceptForSite: persistent allow rule
   */
  async applyDecision(
    threadId: string,
    tool: string,
    targetOrigin: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    if (decision.kind === 'decline' || decision.kind === 'cancel') return;

    // Any acceptance of a cross-scope action brings the origin into scope.
    if (targetOrigin) {
      const thread = await this.db.threads.get(threadId);
      if (thread && !thread.scopeOrigins.includes(targetOrigin)) {
        await this.db.threads.update(threadId, {
          scopeOrigins: [...thread.scopeOrigins, targetOrigin],
        });
      }
    }

    if (decision.kind === 'acceptForSession') {
      let grants = this.sessionGrants.get(threadId);
      if (!grants) {
        grants = new Set();
        this.sessionGrants.set(threadId, grants);
      }
      grants.add(sessionGrantKey(tool, targetOrigin));
    } else if (decision.kind === 'acceptForSite') {
      const rules = await storageGet<PermissionRule[]>(RULES_KEY, []);
      rules.push({
        id: crypto.randomUUID(),
        tool,
        origin: targetOrigin || '*',
        verdict: 'allow',
        source: 'approval_persist',
        createdAt: Date.now(),
        sourceThreadId: threadId,
      });
      await storageSet(RULES_KEY, rules);
    }
  }

  clearSession(threadId: string): void {
    this.sessionGrants.delete(threadId);
  }

  // ---- rule management (settings page) --------------------------------------

  static async listRules(): Promise<PermissionRule[]> {
    return storageGet<PermissionRule[]>(RULES_KEY, []);
  }

  static async removeRule(id: string): Promise<void> {
    const rules = await storageGet<PermissionRule[]>(RULES_KEY, []);
    await storageSet(RULES_KEY, rules.filter((r) => r.id !== id));
  }

  static async addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): Promise<void> {
    const rules = await storageGet<PermissionRule[]>(RULES_KEY, []);
    rules.push({ ...rule, id: crypto.randomUUID(), createdAt: Date.now() });
    await storageSet(RULES_KEY, rules);
  }
}
