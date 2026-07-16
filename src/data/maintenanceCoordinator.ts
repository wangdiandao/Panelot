import type { PanelotDB } from '../db/schema';
import type { MaintenanceMarker, RunState, SkillRecord } from '../db/types';
import { IMPORT_SETTINGS_KEYS, type ExportBundle } from './importContract';
import {
  assertSkillCollisions as assertImportedSkillCollisions,
  reconcileImportedAttachments,
  type MaintenanceValidator,
  type MaintenancePlan,
} from './maintenanceRuntime';
import type {
  DataImportBlockers,
  DataImportCommitResult,
  DataImportJournal,
  StorageAreaLike,
} from './maintenanceTypes';

export const DATA_IMPORT_JOURNAL_KEY = 'panelot_import_journal_v1';
export const DATA_IMPORT_LAST_COMPLETED_KEY = 'panelot_import_last_completed_v1';
export const DATA_IMPORT_MARKER_ID = 'data-import' as const;

const HARD = new Set<RunState>([
  'preparing',
  'streaming_model',
  'waiting_approval',
  'waiting_interaction',
  'executing_tool',
]);
const DORMANT = new Set<RunState>(['queued', 'paused_budget', 'paused_uncertain', 'interrupted']);
const LOCAL_KEYS = [
  ...IMPORT_SETTINGS_KEYS,
  'last_model',
  'thread_seen',
  'panelot_local_secret_key',
  'panelot_kek_v1',
] as const;

export interface DataImportCoordinatorPreview {
  operationId: string;
  digest: string;
  blockers: DataImportBlockers;
}

export interface DataImportCoordinatorOptions {
  local: StorageAreaLike;
  session: StorageAreaLike;
  validator: MaintenanceValidator;
  now?: () => number;
  activeThreadIds?: () => readonly string[];
  waitForAdmissionIdle?: () => Promise<void>;
  journalQuotaBytes?: number;
}

export interface DataImportCoordinatorCommitRequest {
  operationId: string;
  input: unknown;
  expectedDigest: string;
  settings: Record<string, unknown>;
  oauthAccessToClear: number;
  localSecretKey?: number[];
  confirmDiscardDormant?: boolean;
}

export class DataImportCoordinator {
  private blocked = false;
  private active: () => readonly string[];
  private idle: () => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly db: PanelotDB,
    private readonly options: DataImportCoordinatorOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.active = options.activeThreadIds ?? (() => []);
    this.idle = options.waitForAdmissionIdle ?? (() => Promise.resolve());
  }

  setRuntimeHooks(hooks: {
    activeThreadIds: () => readonly string[];
    waitForAdmissionIdle: () => Promise<void>;
  }): void {
    this.active = hooks.activeThreadIds;
    this.idle = hooks.waitForAdmissionIdle;
  }

  isAdmissionBlocked(): boolean {
    return this.blocked;
  }

  async status() {
    const [stored, marker] = await Promise.all([
      this.options.local.get([DATA_IMPORT_JOURNAL_KEY, DATA_IMPORT_LAST_COMPLETED_KEY]),
      this.db.maintenance.get(DATA_IMPORT_MARKER_ID),
    ]);
    const journal = journalOf(stored[DATA_IMPORT_JOURNAL_KEY]);
    const lastCompleted = completedOf(stored[DATA_IMPORT_LAST_COMPLETED_KEY]);
    return {
      blocked: this.blocked || !!journal || !!marker,
      journal: journal
        ? { operationId: journal.operationId, digest: journal.digest, phase: journal.phase }
        : undefined,
      lastCompleted,
    };
  }

  async preview(input: unknown, operationId: string): Promise<DataImportCoordinatorPreview> {
    const plan = await this.plan(input, operationId);
    return {
      operationId,
      digest: plan.digest,
      blockers: await this.blockers(),
    };
  }

  async commit(request: DataImportCoordinatorCommitRequest): Promise<DataImportCommitResult> {
    const plan = await this.options.validator.buildPlan(request.input, request.operationId);
    if (request.expectedDigest !== plan.digest) throw new Error('IMPORT_CHANGED');
    if (
      !Number.isSafeInteger(request.oauthAccessToClear) ||
      request.oauthAccessToClear < 0 ||
      request.oauthAccessToClear > 10_000
    )
      throw new Error('IMPORT_OAUTH_COUNT');
    const stored = await this.options.local.get([
      DATA_IMPORT_LAST_COMPLETED_KEY,
      DATA_IMPORT_JOURNAL_KEY,
      'panelot_local_secret_key',
    ]);
    const completed = completedOf(stored[DATA_IMPORT_LAST_COMPLETED_KEY]);
    if (completed?.operationId === request.operationId) {
      if (completed.digest !== plan.digest) throw new Error('OPERATION_REUSED');
      return {
        status: 'committed',
        operationId: request.operationId,
        digest: plan.digest,
        reloadRequired: true,
        oauthAccessToClear: request.oauthAccessToClear,
      };
    }
    if (journalOf(stored[DATA_IMPORT_JOURNAL_KEY])) throw new Error('IMPORT_INCOMPLETE');
    await this.options.validator.validateMaterialized(
      request.settings,
      request.localSecretKey,
      stored.panelot_local_secret_key,
      plan.bundle.settings,
    );
    await this.assertNoImportedSkillCollisions(plan.portableSkills);
    this.blocked = true;
    let blockers: DataImportBlockers;
    try {
      await this.idle();
      blockers = await this.blockers();
    } catch (error) {
      this.blocked = false;
      throw error;
    }
    if (
      blockers.hardBlocked ||
      (blockers.requiresDormantConfirmation && !request.confirmDiscardDormant)
    ) {
      this.blocked = false;
      return { status: 'blocked', blockers };
    }
    let journal: DataImportJournal | undefined;
    try {
      await this.createJournal(request.operationId, plan.digest);
      journal = journalOf(
        (await this.options.local.get(DATA_IMPORT_JOURNAL_KEY))[DATA_IMPORT_JOURNAL_KEY],
      );
      if (!journal) throw new Error('IMPORT_JOURNAL_WRITE');
      await this.applySettings(plan.bundle, request.settings, request.localSecretKey, journal);
      await this.phase(journal, 'settings_applied');
      await this.commitDb(plan, request.operationId);
      await this.phase(journal, 'db_committed');
      return {
        status: 'committed',
        operationId: request.operationId,
        digest: plan.digest,
        reloadRequired: true,
        oauthAccessToClear: request.oauthAccessToClear,
      };
    } catch (error) {
      const marker = await this.db.maintenance.get(DATA_IMPORT_MARKER_ID);
      if (marker?.operationId === request.operationId && marker.digest === plan.digest) {
        this.blocked = true;
        throw new Error('IMPORT_COMMITTED_RELOAD');
      }
      if (journal) {
        await this.restore(journal);
        await this.options.local.remove(DATA_IMPORT_JOURNAL_KEY);
      }
      this.blocked = false;
      throw error;
    }
  }

  async reconcileStartup(): Promise<'none' | 'rolled_back' | 'rolled_forward'> {
    const raw = (await this.options.local.get(DATA_IMPORT_JOURNAL_KEY))[DATA_IMPORT_JOURNAL_KEY];
    const journal = journalOf(raw);
    if (raw !== undefined && !journal) throw new Error('IMPORT_JOURNAL_CORRUPT');
    const marker = await this.db.maintenance.get(DATA_IMPORT_MARKER_ID);
    if (!journal && !marker) return 'none';
    this.blocked = true;
    if (marker) {
      if (
        journal &&
        (journal.operationId !== marker.operationId || journal.digest !== marker.digest)
      ) {
        throw new Error('IMPORT_MARKER_MISMATCH');
      }
      await this.finish(marker.operationId, marker.digest, journal);
      this.blocked = false;
      return 'rolled_forward';
    }
    if (!journal) throw new Error('IMPORT_JOURNAL_CORRUPT');
    await this.restore(journal);
    await this.options.local.remove(DATA_IMPORT_JOURNAL_KEY);
    this.blocked = false;
    return 'rolled_back';
  }

  private async plan(input: unknown, operationId: string): Promise<MaintenancePlan> {
    return this.options.validator.buildPlan(input, operationId);
  }

  private async blockers(): Promise<DataImportBlockers> {
    const [runs, pendingApprovals, pendingInteractions] = await Promise.all([
      this.db.runs.toArray(),
      this.db.approvals.filter((approval) => approval.status === 'pending').count(),
      this.db.interactions.filter((interaction) => interaction.status === 'pending').count(),
    ]);
    const hardRuns: Partial<Record<RunState, number>> = {};
    const dormantRuns: Partial<Record<RunState, number>> = {};
    for (const run of runs) {
      const target = HARD.has(run.state) ? hardRuns : DORMANT.has(run.state) ? dormantRuns : null;
      if (target) target[run.state] = (target[run.state] ?? 0) + 1;
    }
    const activeThreadIds = [...new Set(this.active())];
    return {
      activeThreadIds,
      hardRuns,
      dormantRuns,
      pendingApprovals,
      pendingInteractions,
      requiresDormantConfirmation: Object.keys(dormantRuns).length > 0,
      hardBlocked:
        !!activeThreadIds.length ||
        !!Object.keys(hardRuns).length ||
        pendingApprovals > 0 ||
        pendingInteractions > 0,
    };
  }

  private async assertNoImportedSkillCollisions(imported: readonly SkillRecord[]): Promise<void> {
    const preserved = await this.db.skills
      .filter((skill) => skill.source === 'plugin' || skill.source === 'builtin')
      .toArray();
    assertImportedSkillCollisions(imported, preserved);
  }

  private async createJournal(operationId: string, digest: string): Promise<void> {
    const all = await this.options.local.get(null);
    const keys = new Set<string>([
      ...LOCAL_KEYS,
      ...Object.keys(all).filter((key) => key.startsWith('thread_params:')),
    ]);
    const preimage: DataImportJournal['preimage'] = {};
    for (const key of keys) {
      preimage[key] = Object.prototype.hasOwnProperty.call(all, key)
        ? { exists: true, value: structuredClone(all[key]) }
        : { exists: false };
    }
    const journal: DataImportJournal = {
      version: 1,
      operationId,
      digest,
      phase: 'prepared',
      createdAt: this.now(),
      preimage,
    };
    const bytes = new TextEncoder().encode(JSON.stringify(journal)).byteLength;
    const used = this.options.local.getBytesInUse
      ? await this.options.local.getBytesInUse(null)
      : 0;
    if (used + bytes > (this.options.journalQuotaBytes ?? 10 * 1024 * 1024)) {
      this.blocked = false;
      throw new Error('IMPORT_JOURNAL_QUOTA');
    }
    await this.options.local.set({ [DATA_IMPORT_JOURNAL_KEY]: journal });
  }

  private async applySettings(
    bundle: ExportBundle,
    settings: Record<string, unknown>,
    localSecretKey: number[] | undefined,
    journal: DataImportJournal,
  ): Promise<void> {
    const writes: Record<string, unknown> = {};
    const removes = new Set<string>();
    for (const key of IMPORT_SETTINGS_KEYS) {
      const value = settings[key];
      if (value === null || value === undefined) removes.add(key);
      else writes[key] = value;
    }
    if (localSecretKey) writes.panelot_local_secret_key = localSecretKey;
    const global = record(settings.global_settings) ? settings.global_settings : {};
    const model = record(global.defaultModel) ? global.defaultModel : undefined;
    const connections = Array.isArray(settings.connections) ? settings.connections : [];
    if (
      model &&
      typeof model.connectionId === 'string' &&
      typeof model.modelId === 'string' &&
      connections.some(
        (value) => record(value) && value.id === model.connectionId && value.enabled !== false,
      )
    ) {
      writes.last_model = { connectionId: model.connectionId, modelId: model.modelId };
    } else removes.add('last_model');
    writes.thread_seen = Object.fromEntries(
      bundle.threads.map((thread) => [
        thread.id,
        Number.isFinite(thread.updatedAt) ? thread.updatedAt : this.now(),
      ]),
    );
    for (const key of Object.keys(journal.preimage)) {
      if (key.startsWith('thread_params:')) removes.add(key);
    }
    if (Object.keys(writes).length) await this.options.local.set(writes);
    if (removes.size) await this.options.local.remove([...removes]);
  }

  private async commitDb(plan: MaintenancePlan, operationId: string): Promise<void> {
    const marker: MaintenanceMarker = {
      id: DATA_IMPORT_MARKER_ID,
      operationId,
      digest: plan.digest,
      committedAt: this.now(),
    };
    await this.db.transaction(
      'rw',
      [
        this.db.threads,
        this.db.nodes,
        this.db.attachments,
        this.db.skills,
        this.db.memories,
        this.db.runs,
        this.db.commandReceipts,
        this.db.approvals,
        this.db.interactions,
        this.db.maintenance,
      ],
      async () => {
        const [preserved, attachments] = await Promise.all([
          this.db.skills
            .filter((skill) => skill.source === 'plugin' || skill.source === 'builtin')
            .toArray(),
          this.db.attachments.toArray(),
        ]);
        assertImportedSkillCollisions(plan.portableSkills, preserved);
        const reconciled = reconcileImportedAttachments(plan.bundle.nodes, attachments, this.now());
        await Promise.all([
          this.db.threads.clear(),
          this.db.nodes.clear(),
          this.db.skills.clear(),
          this.db.memories.clear(),
          this.db.runs.clear(),
          this.db.commandReceipts.clear(),
          this.db.approvals.clear(),
          this.db.interactions.clear(),
        ]);
        await Promise.all([
          this.db.threads.bulkPut(plan.bundle.threads),
          this.db.nodes.bulkPut(reconciled.nodes),
          this.db.skills.bulkPut([...preserved, ...plan.portableSkills]),
          this.db.memories.bulkPut(plan.bundle.memories as never[]),
          this.db.attachments.bulkPut(reconciled.attachments),
          this.db.maintenance.put(marker),
        ]);
      },
    );
  }

  private async phase(journal: DataImportJournal, phase: DataImportJournal['phase']) {
    journal.phase = phase;
    await this.options.local.set({ [DATA_IMPORT_JOURNAL_KEY]: journal });
  }

  private async restore(journal: DataImportJournal): Promise<void> {
    const writes: Record<string, unknown> = {};
    const removes: string[] = [];
    for (const [key, value] of Object.entries(journal.preimage)) {
      if (value.exists) writes[key] = structuredClone(value.value);
      else removes.push(key);
    }
    if (Object.keys(writes).length) await this.options.local.set(writes);
    if (removes.length) await this.options.local.remove(removes);
  }

  private async finish(operationId: string, digest: string, journal?: DataImportJournal) {
    await clearImportSession(this.options.session);
    if (journal) await this.phase(journal, 'hydrated');
    await this.options.local.set({
      [DATA_IMPORT_LAST_COMPLETED_KEY]: { operationId, digest, completedAt: this.now() },
    });
    await this.options.local.remove(DATA_IMPORT_JOURNAL_KEY);
    await this.db.maintenance.delete(DATA_IMPORT_MARKER_ID);
  }
}

export async function clearImportSession(session: StorageAreaLike): Promise<void> {
  const all = await session.get(null);
  const keys = Object.keys(all).filter(
    (key) =>
      key === 'panelot_engine_stream_epoch' ||
      key.startsWith('engine_client_id:') ||
      key.startsWith('engine_outbox:') ||
      (key.startsWith('draft:') && key !== 'draft:draft') ||
      key.startsWith('panelot_session_secret:'),
  );
  if (keys.length) await session.remove(keys);
}

function journalOf(value: unknown): DataImportJournal | undefined {
  const preimage = record(value) ? value.preimage : undefined;
  if (
    !record(value) ||
    value.version !== 1 ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    typeof value.digest !== 'string' ||
    value.digest.length === 0 ||
    !['prepared', 'settings_applied', 'db_committed', 'hydrated'].includes(String(value.phase)) ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !record(preimage)
  ) {
    return undefined;
  }

  const expectedKeys = new Set<string>(LOCAL_KEYS);
  const entries = Object.entries(preimage);
  if (entries.length < expectedKeys.size || entries.length > 10_000) return undefined;
  if ([...expectedKeys].some((key) => !Object.hasOwn(preimage, key))) return undefined;
  for (const [key, candidate] of entries) {
    const allowedDynamicKey =
      key.startsWith('thread_params:') && key.length > 'thread_params:'.length;
    if (
      (!expectedKeys.has(key) && !allowedDynamicKey) ||
      !record(candidate) ||
      typeof candidate.exists !== 'boolean'
    ) {
      return undefined;
    }
    const candidateKeys = Object.keys(candidate);
    if (candidateKeys.some((entryKey) => entryKey !== 'exists' && entryKey !== 'value')) {
      return undefined;
    }
    if (candidate.exists && !Object.hasOwn(candidate, 'value')) return undefined;
    if (!candidate.exists && Object.hasOwn(candidate, 'value')) return undefined;
  }
  return value as unknown as DataImportJournal;
}

function completedOf(value: unknown) {
  return record(value) &&
    typeof value.operationId === 'string' &&
    typeof value.digest === 'string' &&
    Number.isFinite(value.completedAt)
    ? (value as { operationId: string; digest: string; completedAt: number })
    : undefined;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
