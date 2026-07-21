/**
 * GatekeeperService: stateful wrapper around the pure checkGate — loads
 * rules/blacklist from storage, tracks session grants, persists
 * acceptForSite rules and scopeOrigins growth (docs/06 §2-4).
 */

import type { ApprovalDecision, PermissionPolicy } from '../messaging/protocol';
import type { PanelotDB } from '../db/schema';
import { storageGet, storageUpdate, type LegacyGlobalSettings } from '../settings/store';
import { normalizePermissionPolicy } from '../settings/permissionPolicy';
import {
  checkGate,
  sessionGrantKey,
  type GatekeeperCall,
  type GatekeeperVerdict,
} from './gatekeeper';
import { DEFAULT_SENSITIVE_PATTERNS, destinationOrigin, type PermissionRule } from './rules';
import { HostPermissionBroker } from '../permissions/hostPermissionBroker';

const RULES_KEY = 'permission_rules';
const DEFAULT_RULES_SEEDED_KEY = 'permission_rule_defaults_seeded_v1';
const SENSITIVE_KEY = 'sensitive_origins';
export const GATEKEEPER_SESSION_STATE_KEY = 'panelot_gatekeeper_session_v1';
export const GATEKEEPER_SESSION_MAX_THREADS = 256;

const GATEKEEPER_SESSION_MAX_GRANTS_PER_THREAD = 512;
const GATEKEEPER_SESSION_MAX_THREAD_ID_LENGTH = 512;
const GATEKEEPER_SESSION_MAX_GRANT_KEY_LENGTH = 4096;

interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface StoredGatekeeperSessionState {
  version: 1;
  grants: Array<[threadId: string, keys: string[]]>;
}

type StatefulGatekeeperVerdict =
  | Exclude<GatekeeperVerdict, { verdict: 'ask' }>
  | (Extract<GatekeeperVerdict, { verdict: 'ask' }> & { authorizationRevision: string });

interface GatekeeperCheckPhase {
  phase?: 'initial' | 'dispatch';
  approvedAuthorizationRevision?: string;
}

function authorizationRevision(
  permissionPolicy: PermissionPolicy,
  rules: readonly PermissionRule[],
  sensitivePatterns: readonly string[],
): string {
  return JSON.stringify([permissionPolicy, rules, sensitivePatterns]);
}

function finalizeGatekeeperVerdict(
  verdict: GatekeeperVerdict,
  revision: string,
  phase: GatekeeperCheckPhase,
): StatefulGatekeeperVerdict | { verdict: 'allow' } {
  if (verdict.verdict !== 'ask') return verdict;
  if (
    phase.phase === 'dispatch' &&
    phase.approvedAuthorizationRevision !== undefined &&
    phase.approvedAuthorizationRevision === revision
  ) {
    return { verdict: 'allow' };
  }
  return { ...verdict, authorizationRevision: revision };
}

function currentSessionStorage(): SessionStorageArea | undefined {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return undefined;
  return chrome.storage.session as SessionStorageArea;
}

function parseSessionGrants(value: unknown): Map<string, Set<string>> | undefined {
  const empty = new Map<string, Set<string>>();
  if (value === undefined) return empty;
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Partial<StoredGatekeeperSessionState>;
  if (
    state.version !== 1 ||
    !Array.isArray(state.grants) ||
    state.grants.length > GATEKEEPER_SESSION_MAX_THREADS
  ) {
    return undefined;
  }
  for (const entry of state.grants) {
    if (!Array.isArray(entry) || entry.length !== 2) return undefined;
    const [threadId, keys] = entry;
    if (
      typeof threadId !== 'string' ||
      threadId.length === 0 ||
      threadId.length > GATEKEEPER_SESSION_MAX_THREAD_ID_LENGTH ||
      !Array.isArray(keys) ||
      keys.length > GATEKEEPER_SESSION_MAX_GRANTS_PER_THREAD ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          key.length === 0 ||
          key.length > GATEKEEPER_SESSION_MAX_GRANT_KEY_LENGTH,
      )
    ) {
      return undefined;
    }
    if (keys.length > 0) empty.set(threadId, new Set(keys));
  }
  return empty;
}

function boundedSessionGrants(grants: Map<string, Set<string>>): Map<string, Set<string>> {
  const entries: Array<[string, Set<string>]> = [];
  for (const [threadId, keys] of grants) {
    if (threadId.length === 0 || threadId.length > GATEKEEPER_SESSION_MAX_THREAD_ID_LENGTH) {
      continue;
    }
    const boundedKeys = [...keys]
      .filter((key) => key.length > 0 && key.length <= GATEKEEPER_SESSION_MAX_GRANT_KEY_LENGTH)
      .slice(-GATEKEEPER_SESSION_MAX_GRANTS_PER_THREAD);
    if (boundedKeys.length > 0) entries.push([threadId, new Set(boundedKeys)]);
  }
  return new Map(entries.slice(-GATEKEEPER_SESSION_MAX_THREADS));
}

export interface ThreadPermissionConfig {
  permissionPolicy: PermissionPolicy;
}

const DEFAULT_CONFIG: ThreadPermissionConfig = {
  permissionPolicy: 'untrusted',
};

const ORIGINLESS_TOOLS = new Set([
  'tabs_list',
  'memory_read',
  'memory_write',
  'load_skill',
  'ask_user',
  'request_user_action',
  'schedule_resume',
]);

export class GatekeeperService {
  /** threadId → session grants (acceptForSession; storage.session, docs/06 §4). */
  private sessionGrants = new Map<string, Set<string>>();
  /** threadId → per-thread permission-policy overrides. */
  private threadConfig = new Map<string, ThreadPermissionConfig>();
  private readonly sessionStorage: SessionStorageArea | undefined;
  private readonly stateReady: Promise<void>;
  private mutationTail = Promise.resolve();
  private stateError: Error | undefined;
  private permissionRevokedDuringHydration = false;

  constructor(
    private db: PanelotDB,
    private getOrigin: (threadId: string) => Promise<string>,
    private hostPermissions: HostPermissionBroker = new HostPermissionBroker(),
    sessionStorage: SessionStorageArea | undefined = currentSessionStorage(),
    listenForPermissionRemoval = true,
  ) {
    this.sessionStorage = sessionStorage;
    this.stateReady = this.hydrateSessionState().catch((error: unknown) => {
      this.sessionGrants.clear();
      this.stateError = new Error('Session permission state is unavailable', { cause: error });
    });
    if (
      listenForPermissionRemoval &&
      typeof chrome !== 'undefined' &&
      chrome.permissions?.onRemoved
    ) {
      chrome.permissions.onRemoved.addListener(() => this.handleHostPermissionsRemoved());
    }
  }

  handleHostPermissionsRemoved(): void {
    this.permissionRevokedDuringHydration = true;
    this.sessionGrants.clear();
    void this.mutateSessionGrants((grants) => grants.clear()).catch(() => {});
  }

  async ready(): Promise<void> {
    await this.stateReady;
    if (this.stateError) throw this.stateError;
  }

  async flushState(): Promise<void> {
    await this.ready();
    await this.mutationTail;
    if (this.stateError) throw this.stateError;
  }

  private async hydrateSessionState(): Promise<void> {
    if (!this.sessionStorage) return;
    const stored = await this.sessionStorage.get(GATEKEEPER_SESSION_STATE_KEY);
    const grants = parseSessionGrants(stored[GATEKEEPER_SESSION_STATE_KEY]);
    if (!grants) throw new Error('Invalid session permission state');
    this.sessionGrants = this.permissionRevokedDuringHydration ? new Map() : grants;
  }

  private async mutateSessionGrants(
    mutate: (grants: Map<string, Set<string>>) => void,
  ): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      await this.ready();
      const next = this.cloneSessionGrants();
      mutate(next);
      const bounded = boundedSessionGrants(next);
      if (this.sessionStorage) {
        const state: StoredGatekeeperSessionState = {
          version: 1,
          grants: [...bounded].map(([threadId, keys]) => [threadId, [...keys].sort()]),
        };
        await this.sessionStorage.set({ [GATEKEEPER_SESSION_STATE_KEY]: state });
      }
      this.sessionGrants = bounded;
    });
    this.mutationTail = operation.catch((error: unknown) => {
      this.sessionGrants.clear();
      this.stateError = new Error('Session permission state is unavailable', { cause: error });
    });
    await operation;
  }

  private cloneSessionGrants(): Map<string, Set<string>> {
    return new Map(
      [...this.sessionGrants].map(([threadId, grants]) => [threadId, new Set(grants)]),
    );
  }

  setThreadConfig(threadId: string, config: Partial<ThreadPermissionConfig>): void {
    const current = this.threadConfig.get(threadId) ?? { ...DEFAULT_CONFIG };
    this.threadConfig.set(threadId, { ...current, ...config });
  }

  getThreadConfig(threadId: string): ThreadPermissionConfig {
    return this.threadConfig.get(threadId) ?? { ...DEFAULT_CONFIG };
  }

  async check(
    call: GatekeeperCall & {
      level?: string;
      target?: { origin?: string; serverId?: string };
    } & GatekeeperCheckPhase,
    threadId: string,
  ): Promise<StatefulGatekeeperVerdict | { verdict: 'allow' }> {
    await this.ready();
    const [rules, sensitiveUser, thread, origin] = await Promise.all([
      storageGet<PermissionRule[]>(RULES_KEY, []),
      storageGet<string[]>(SENSITIVE_KEY, []),
      this.db.threads.get(threadId),
      this.getOrigin(threadId),
    ]);
    // Per-thread override wins; otherwise fall back to the configured defaults.
    let config = this.threadConfig.get(threadId);
    if (!config) {
      const global = await storageGet<LegacyGlobalSettings>('global_settings', {});
      config = {
        permissionPolicy:
          global.defaultPermissionPolicy ??
          normalizePermissionPolicy(global.defaultApprovalPolicy, global.defaultCapabilityScope) ??
          DEFAULT_CONFIG.permissionPolicy,
      };
    }
    const destination = destinationOrigin(call.toolName, call.params);
    const originless =
      ORIGINLESS_TOOLS.has(call.toolName) ||
      (call.level === 'builtin' && !call.target?.origin && !destination);
    const targetOrigin = call.target?.origin ?? destination ?? (originless ? '' : origin);

    const sensitivePatterns = [...DEFAULT_SENSITIVE_PATTERNS, ...sensitiveUser];
    const revision = authorizationRevision(config.permissionPolicy, rules, sensitivePatterns);
    const verdict = checkGate(call, {
      threadId,
      targetOrigin,
      permissionPolicy: config.permissionPolicy,
      scopeOrigins: thread?.scopeOrigins ?? [],
      rules,
      sensitivePatterns,
      sessionGrants: this.sessionGrants.get(threadId) ?? new Set(),
      originless,
    });
    if (verdict.verdict === 'deny' || originless || !/^https?:\/\//i.test(targetOrigin)) {
      return finalizeGatekeeperVerdict(verdict, revision, call);
    }
    if (typeof chrome === 'undefined' || !chrome.permissions) {
      return finalizeGatekeeperVerdict(verdict, revision, call);
    }
    const permission = await this.hostPermissions.inspect(targetOrigin);
    if (permission.granted) return finalizeGatekeeperVerdict(verdict, revision, call);
    if (verdict.verdict === 'ask') {
      return {
        ...verdict,
        request: {
          ...verdict.request,
          targetOrigin: permission.origin,
          flags: [...new Set([...verdict.request.flags, 'host_permission' as const])],
        },
        authorizationRevision: revision,
      };
    }
    return {
      verdict: 'ask',
      request: {
        tool: call.toolName,
        label: `Allow access to ${permission.origin}`,
        params: call.params,
        targetOrigin: permission.origin,
        flags: ['host_permission'],
      },
      authorizationRevision: revision,
    };
  }

  /**
   * Apply an approval decision's side effects (docs/06 §4):
   *  - accept: origin joins scopeOrigins (cross-scope approved once = in scope)
   *  - acceptForSession: in-memory (tool, origin) grant for this thread
   *  - acceptForSite: persistent allow rule
   */
  async applyDecision(
    approvalId: string,
    threadId: string,
    tool: string,
    targetOrigin: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    await this.ready();
    if (decision.kind === 'decline' || decision.kind === 'cancel') return;

    // Any acceptance of a cross-scope action brings the origin into scope.
    if (targetOrigin) {
      const thread = await this.db.threads.get(threadId);
      if (thread && !thread.scopeOrigins.includes(targetOrigin)) {
        await this.db.threads.update(threadId, {
          scopeOrigins: [...thread.scopeOrigins, targetOrigin],
          revision: thread.revision + 1,
          updatedAt: Date.now(),
        });
      }
    }

    if (decision.kind === 'acceptForSession') {
      await this.mutateSessionGrants((next) => {
        let grants = next.get(threadId);
        if (!grants) {
          grants = new Set();
        }
        const key = sessionGrantKey(tool, targetOrigin);
        grants.delete(key);
        grants.add(key);
        next.delete(threadId);
        next.set(threadId, grants);
      });
    } else if (decision.kind === 'acceptForSite') {
      await storageUpdate<PermissionRule[]>(RULES_KEY, [], (rules) =>
        rules.some((rule) => rule.sourceApprovalId === approvalId)
          ? rules
          : [
              ...rules,
              {
                id: `approval:${approvalId}`,
                tool,
                origin: targetOrigin || '*',
                verdict: 'allow',
                source: 'approval_persist',
                createdAt: Date.now(),
                sourceThreadId: threadId,
                sourceApprovalId: approvalId,
              },
            ],
      );
    }
  }

  async clearSession(threadId: string): Promise<void> {
    await this.ready();
    this.threadConfig.delete(threadId);
    await this.mutateSessionGrants((next) => next.delete(threadId));
  }

  // ---- rule management (settings page) --------------------------------------

  static async listRules(): Promise<PermissionRule[]> {
    return storageGet<PermissionRule[]>(RULES_KEY, []);
  }

  /**
   * Seed shipped defaults exactly once. The durable marker distinguishes a
   * user-deleted default from a profile that has never been initialized.
   */
  static async seedDefaultRules(): Promise<void> {
    if (await storageGet<boolean>(DEFAULT_RULES_SEEDED_KEY, false)) return;
    await storageUpdate<PermissionRule[]>(RULES_KEY, [], (rules) =>
      rules.some((rule) => rule.tool === 'run_javascript')
        ? rules
        : [
            ...rules,
            {
              id: 'default:run_javascript-deny',
              tool: 'run_javascript',
              origin: '*',
              verdict: 'deny',
              source: 'user_setting',
              createdAt: Date.now(),
            },
          ],
    );
    await storageUpdate<boolean>(DEFAULT_RULES_SEEDED_KEY, false, () => true);
  }

  static async removeRule(id: string): Promise<void> {
    await storageUpdate<PermissionRule[]>(RULES_KEY, [], (rules) =>
      rules.filter((rule) => rule.id !== id),
    );
  }

  static async addRule(rule: Omit<PermissionRule, 'id' | 'createdAt'>): Promise<void> {
    await storageUpdate<PermissionRule[]>(RULES_KEY, [], (rules) => [
      ...rules,
      { ...rule, id: crypto.randomUUID(), createdAt: Date.now() },
    ]);
  }
}
