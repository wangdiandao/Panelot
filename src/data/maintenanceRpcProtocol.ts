import type { DataImportCommitResult } from './maintenanceTypes';
import type {
  DataImportCoordinatorCommitRequest,
  DataImportCoordinatorPreview,
} from './maintenanceCoordinator';
export const DATA_IMPORT_RPC_TYPE = 'panelot.dataImport' as const;

export type DataImportRpcRequest =
  | { type: typeof DATA_IMPORT_RPC_TYPE; action: 'status' }
  | {
      type: typeof DATA_IMPORT_RPC_TYPE;
      action: 'preview';
      operationId: string;
      input: unknown;
    }
  | ({ type: typeof DATA_IMPORT_RPC_TYPE; action: 'commit' } & DataImportCoordinatorCommitRequest);

export interface DataImportMaintenanceStatus {
  blocked: boolean;
  reconciliation: 'none' | 'rolled_back' | 'rolled_forward';
  journal?: { operationId: string; digest: string; phase: string };
  lastCompleted?: { operationId: string; digest: string; completedAt: number };
}

export type DataImportRpcResult =
  DataImportMaintenanceStatus | DataImportCoordinatorPreview | DataImportCommitResult;

export type DataImportRpcResponse<T extends DataImportRpcResult = DataImportRpcResult> =
  { ok: true; result: T } | { ok: false; error: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

export function parseDataImportRpcRequest(input: unknown): DataImportRpcRequest | null {
  if (!isRecord(input) || input.type !== DATA_IMPORT_RPC_TYPE || typeof input.action !== 'string') {
    return null;
  }
  if (input.action === 'status') {
    return hasOnlyKeys(input, ['type', 'action'])
      ? { type: DATA_IMPORT_RPC_TYPE, action: 'status' }
      : null;
  }
  if (
    !['preview', 'commit'].includes(input.action) ||
    typeof input.operationId !== 'string' ||
    !UUID_PATTERN.test(input.operationId) ||
    !isRecord(input.input)
  ) {
    return null;
  }
  if (input.action === 'preview') {
    if (!hasOnlyKeys(input, ['type', 'action', 'operationId', 'input'])) return null;
    return {
      type: DATA_IMPORT_RPC_TYPE,
      action: 'preview',
      operationId: input.operationId,
      input: input.input,
    };
  }
  if (
    !hasOnlyKeys(input, [
      'type',
      'action',
      'operationId',
      'input',
      'expectedDigest',
      'settings',
      'oauthAccessToClear',
      'localSecretKey',
      'confirmDiscardDormant',
    ]) ||
    typeof input.expectedDigest !== 'string' ||
    !DIGEST_PATTERN.test(input.expectedDigest) ||
    !isRecord(input.settings) ||
    !Number.isSafeInteger(input.oauthAccessToClear) ||
    Number(input.oauthAccessToClear) < 0 ||
    Number(input.oauthAccessToClear) > 10_000 ||
    (input.localSecretKey !== undefined && !isLocalSecretKey(input.localSecretKey)) ||
    (input.confirmDiscardDormant !== undefined && typeof input.confirmDiscardDormant !== 'boolean')
  ) {
    return null;
  }
  return {
    type: DATA_IMPORT_RPC_TYPE,
    action: 'commit',
    operationId: input.operationId,
    input: input.input,
    expectedDigest: input.expectedDigest,
    settings: input.settings,
    oauthAccessToClear: input.oauthAccessToClear as number,
    ...(Array.isArray(input.localSecretKey)
      ? { localSecretKey: input.localSecretKey as number[] }
      : {}),
    ...(typeof input.confirmDiscardDormant === 'boolean'
      ? { confirmDiscardDormant: input.confirmDiscardDormant }
      : {}),
  };
}

export function isTrustedDataImportSender(
  sender: { id?: string; url?: string; tab?: { url?: string } },
  runtimeId: string,
  extensionRoot: string,
): boolean {
  if (sender.id !== runtimeId) return false;
  const source = sender.url ?? sender.tab?.url;
  if (!source) return false;
  try {
    const actual = new URL(source);
    const expected = new URL('options.html', extensionRoot);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function isLocalSecretKey(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 32 &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
