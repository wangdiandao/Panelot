export const MAINTENANCE_WORKER_PORT = 'panelot.maintenanceWorker' as const;

export type OffscreenWorkerCommand =
  | { type: 'panelot.offscreen.attachments.cleanup' }
  | { type: 'panelot.offscreen.attachments.evict'; activeThreadId?: string };

export type MaintenanceWorkerRequest =
  | {
      requestId: string;
      operationId: string;
      action: 'plan';
      input: unknown;
    }
  | {
      requestId: string;
      operationId: string;
      action: 'materialized';
      settings: Record<string, unknown>;
      localSecretKey: unknown;
      existingKey: unknown;
      plannedSettings: Record<string, unknown>;
    };

export type MaintenanceWorkerResponse =
  | {
      requestId: string;
      operationId: string;
      ok: true;
      result?: {
        digest: string;
        resultDigest: string;
        settings: Record<string, unknown>;
      };
    }
  | {
      requestId: string;
      operationId: string;
      ok: false;
      error: string;
    };
