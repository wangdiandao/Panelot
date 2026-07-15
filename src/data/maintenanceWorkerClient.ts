import type { CanonicalImportPlan, ExportBundle } from './importContract';
import {
  maintenanceDigest,
  type MaintenancePlan,
  type MaintenanceValidator,
} from './maintenanceRuntime';
import {
  MAINTENANCE_WORKER_PORT,
  type MaintenanceWorkerRequest,
  type MaintenanceWorkerResponse,
  type OffscreenWorkerCommand,
} from './maintenanceWorkerProtocol';
import { ensureMcpWorkerDocument } from '../mcp/offscreenWorker';

const DEFAULT_TIMEOUT_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

type WorkerPort = Pick<chrome.runtime.Port, 'name' | 'sender' | 'postMessage' | 'disconnect'> & {
  onMessage: Pick<chrome.runtime.Port['onMessage'], 'addListener' | 'removeListener'>;
  onDisconnect: Pick<chrome.runtime.Port['onDisconnect'], 'addListener' | 'removeListener'>;
};

interface PendingRequest {
  operationId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve(response: MaintenanceWorkerResponse): void;
  reject(error: Error): void;
}

let workerPort: WorkerPort | undefined;
const portWaiters = new Set<{ resolve(port: WorkerPort): void; reject(error: Error): void }>();
const pending = new Map<string, PendingRequest>();

export function isTrustedMaintenanceWorkerSender(
  port: Pick<WorkerPort, 'name' | 'sender'>,
  runtimeId = chrome.runtime.id,
  workerUrl = chrome.runtime.getURL('mcp-worker.html'),
): boolean {
  return (
    port.name === MAINTENANCE_WORKER_PORT &&
    port.sender?.id === runtimeId &&
    port.sender.url === workerUrl
  );
}

export function acceptMaintenanceWorkerPort(port: chrome.runtime.Port): boolean {
  if (port.name !== MAINTENANCE_WORKER_PORT) return false;
  if (!isTrustedMaintenanceWorkerSender(port) || workerPort) {
    port.disconnect();
    return true;
  }
  workerPort = port;
  port.onMessage.addListener(handleWorkerResponse);
  port.onDisconnect.addListener(handleWorkerDisconnect);
  for (const waiter of portWaiters) waiter.resolve(port);
  portWaiters.clear();
  return true;
}

export async function sendOffscreenWorkerCommand(command: OffscreenWorkerCommand): Promise<void> {
  await ensureMcpWorkerDocument();
  const port = workerPort ?? (await waitForPort(DEFAULT_TIMEOUT_MS));
  port.postMessage(command);
}

export async function cleanupOffscreenAttachments(): Promise<void> {
  await ensureMcpWorkerDocument();
  const response: unknown = await chrome.runtime.sendMessage({
    type: 'panelot.offscreen.attachments.cleanup',
  });
  if (!isRecord(response) || response.ok !== true) {
    throw new Error(
      isRecord(response) && typeof response.error === 'string'
        ? response.error
        : 'OFFSCREEN_ATTACHMENT_CLEANUP',
    );
  }
}

export class MaintenanceWorkerValidator implements MaintenanceValidator {
  constructor(
    private readonly ensureWorker: () => Promise<void> = ensureMcpWorkerDocument,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async buildPlan(input: unknown, operationId: string): Promise<MaintenancePlan> {
    const localDigest = maintenanceDigest(input);
    const response = await this.request({
      requestId: crypto.randomUUID(),
      operationId,
      action: 'plan',
      input,
    });
    if (!response.ok) throw new Error(response.error || 'IMPORT_VALIDATOR_FAILED');
    if (!response.result || !isRecord(response.result.settings)) {
      throw new Error('IMPORT_VALIDATOR_RESPONSE');
    }
    const digest = await localDigest;
    if (response.result.digest !== digest || !DIGEST_PATTERN.test(response.result.digest)) {
      throw new Error('IMPORT_VALIDATOR_DIGEST');
    }
    const resultDigest = await maintenanceDigest({
      inputDigest: digest,
      settings: response.result.settings,
    });
    if (response.result.resultDigest !== resultDigest) {
      throw new Error('IMPORT_VALIDATOR_RESULT_DIGEST');
    }
    const root = input as CanonicalImportPlan;
    const bundle: ExportBundle = {
      version: 2,
      exportedAt: root.exportedAt,
      threads: root.threads,
      nodes: root.nodes,
      skills: root.skills,
      memories: root.memories,
      settings: response.result.settings,
    };
    return {
      bundle,
      portableSkills: bundle.skills.filter(
        (skill) => skill.source === 'user' || skill.source === 'imported',
      ),
      digest,
    };
  }

  async validateMaterialized(
    settings: Record<string, unknown>,
    localSecretKey: unknown,
    existingKey: unknown,
    plannedSettings: Record<string, unknown>,
  ): Promise<void> {
    await this.request({
      requestId: crypto.randomUUID(),
      operationId: crypto.randomUUID(),
      action: 'materialized',
      settings,
      localSecretKey,
      existingKey,
      plannedSettings,
    });
  }

  private async request(request: MaintenanceWorkerRequest): Promise<MaintenanceWorkerResponse> {
    if (!UUID_PATTERN.test(request.operationId)) throw new Error('IMPORT_OPERATION_ID');
    await this.ensureWorker();
    const port = workerPort ?? (await waitForPort(this.timeoutMs));
    return new Promise<MaintenanceWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(request.requestId);
        reject(new Error('IMPORT_VALIDATOR_TIMEOUT'));
        resetWorkerPort(new Error('IMPORT_VALIDATOR_TIMEOUT'));
      }, this.timeoutMs);
      pending.set(request.requestId, { operationId: request.operationId, timer, resolve, reject });
      try {
        port.postMessage(request);
      } catch {
        clearTimeout(timer);
        pending.delete(request.requestId);
        reject(new Error('IMPORT_VALIDATOR_DISCONNECTED'));
        resetWorkerPort(new Error('IMPORT_VALIDATOR_DISCONNECTED'));
      }
    });
  }
}

function waitForPort(timeoutMs: number): Promise<WorkerPort> {
  if (workerPort) return Promise.resolve(workerPort);
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject };
    portWaiters.add(waiter);
    setTimeout(() => {
      if (!portWaiters.delete(waiter)) return;
      reject(new Error('IMPORT_VALIDATOR_CONNECT_TIMEOUT'));
    }, timeoutMs);
  });
}

function handleWorkerResponse(message: unknown): void {
  if (!isWorkerResponse(message)) {
    resetWorkerPort(new Error('IMPORT_VALIDATOR_PROTOCOL'));
    return;
  }
  const request = pending.get(message.requestId);
  if (!request || request.operationId !== message.operationId) {
    resetWorkerPort(new Error('IMPORT_VALIDATOR_CORRELATION'));
    return;
  }
  pending.delete(message.requestId);
  clearTimeout(request.timer);
  if (!message.ok) request.reject(new Error(message.error || 'IMPORT_VALIDATOR_FAILED'));
  else request.resolve(message);
}

function handleWorkerDisconnect(): void {
  resetWorkerPort(new Error('IMPORT_VALIDATOR_DISCONNECTED'), false);
}

function resetWorkerPort(error: Error, disconnect = true): void {
  const port = workerPort;
  workerPort = undefined;
  if (port) {
    port.onMessage.removeListener(handleWorkerResponse);
    port.onDisconnect.removeListener(handleWorkerDisconnect);
    if (disconnect) port.disconnect();
  }
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
  for (const waiter of portWaiters) waiter.reject(error);
  portWaiters.clear();
}

function isWorkerResponse(value: unknown): value is MaintenanceWorkerResponse {
  if (!isRecord(value)) return false;
  if (
    typeof value.requestId !== 'string' ||
    typeof value.operationId !== 'string' ||
    typeof value.ok !== 'boolean'
  ) {
    return false;
  }
  return value.ok
    ? value.result === undefined || isRecord(value.result)
    : typeof value.error === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
