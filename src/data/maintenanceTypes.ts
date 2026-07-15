import type { RunState } from '../db/types';

export type ImportJournalPhase = 'prepared' | 'settings_applied' | 'db_committed' | 'hydrated';

interface StoredPreimageValue {
  exists: boolean;
  value?: unknown;
}

export interface DataImportJournal {
  version: 1;
  operationId: string;
  digest: string;
  phase: ImportJournalPhase;
  createdAt: number;
  preimage: Record<string, StoredPreimageValue>;
}

export interface DataImportBlockers {
  activeThreadIds: string[];
  hardRuns: Partial<Record<RunState, number>>;
  dormantRuns: Partial<Record<RunState, number>>;
  pendingApprovals: number;
  requiresDormantConfirmation: boolean;
  hardBlocked: boolean;
}

export type DataImportCommitResult =
  | { status: 'blocked'; blockers: DataImportBlockers }
  | {
      status: 'committed';
      operationId: string;
      digest: string;
      reloadRequired: true;
      oauthAccessToClear: number;
    };

export interface StorageAreaLike {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  getBytesInUse?(keys?: string | string[] | null): Promise<number>;
}
