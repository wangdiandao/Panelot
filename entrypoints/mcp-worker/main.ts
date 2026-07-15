import { McpClient } from '../../src/mcp/client';
import { inProcessMaintenanceValidator } from '../../src/data/maintenanceValidator';
import { maintenanceDigest } from '../../src/data/maintenanceRuntime';
import {
  MAINTENANCE_WORKER_PORT,
  type MaintenanceWorkerRequest,
  type MaintenanceWorkerResponse,
  type OffscreenWorkerCommand,
} from '../../src/data/maintenanceWorkerProtocol';
import { PanelotDB } from '../../src/db/schema';
import { AttachmentRepository } from '../../src/data/attachments';
import { evictAttachmentsIfNeeded } from '../../src/data/quota';

const clients = new Map<string, McpClient>();
const db = new PanelotDB();

function catalog(client: McpClient) {
  return {
    tools: client.tools,
    prompts: client.prompts,
    resources: client.resources,
  };
}

async function handle(message: unknown): Promise<unknown> {
  const request = message as {
    type?: string;
    serverId?: string;
    url?: string;
    authorization?: string | null;
    name?: string;
    args?: unknown;
    uri?: string;
  };
  if (!request.type?.startsWith('panelot.mcpWorker.') || !request.serverId) return undefined;

  try {
    if (request.type === 'panelot.mcpWorker.connect') {
      if (!request.url) throw new Error('MCP worker URL is missing');
      await clients.get(request.serverId)?.close();
      let authorization = request.authorization ?? null;
      const client = new McpClient({
        url: request.url,
        authHeader: async () => authorization,
        onBeforeFetch: async (url) => {
          const response = (await chrome.runtime.sendMessage({
            type: 'panelot.mcpWorkerPermissionCheck',
            id: request.serverId,
            url,
          })) as { allowed?: boolean } | undefined;
          if (!response?.allowed) throw new Error('MCP host permission is required');
        },
        onUnauthorized: async (challenge) => {
          const response = (await chrome.runtime.sendMessage({
            type: 'panelot.mcpWorkerUnauthorized',
            id: request.serverId,
            ...challenge,
          })) as { authorization?: string | null } | undefined;
          authorization = response?.authorization ?? null;
          return authorization !== null;
        },
        onCapabilitiesChanged: () => {
          void chrome.runtime
            .sendMessage({
              type: 'panelot.mcpWorker.changed',
              serverId: request.serverId,
              catalog: catalog(client),
            })
            .catch(() => {});
        },
      });
      await client.connect();
      clients.set(request.serverId, client);
      return { ok: true, catalog: catalog(client) };
    }

    const client = clients.get(request.serverId);
    if (!client) throw new Error(`MCP server is not connected: ${request.serverId}`);
    if (request.type === 'panelot.mcpWorker.close') {
      clients.delete(request.serverId);
      await client.close();
      return { ok: true };
    }
    if (request.type === 'panelot.mcpWorker.callTool') {
      if (!request.name) throw new Error('MCP tool name is missing');
      return { ok: true, result: await client.callTool(request.name, request.args) };
    }
    if (request.type === 'panelot.mcpWorker.getPrompt') {
      if (!request.name) throw new Error('MCP prompt name is missing');
      return {
        ok: true,
        result: await client.getPrompt(
          request.name,
          (request.args ?? {}) as Record<string, unknown>,
        ),
      };
    }
    if (request.type === 'panelot.mcpWorker.readResource') {
      if (!request.uri) throw new Error('MCP resource URI is missing');
      return { ok: true, result: await client.readResource(request.uri) };
    }
    return undefined;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = (message as { type?: string }).type;
  if (type === 'panelot.offscreen.attachments.cleanup') {
    void new AttachmentRepository(db)
      .cleanupIncomplete()
      .then(() => sendResponse({ ok: true }))
      .catch((error: unknown) =>
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    return true;
  }
  if (!type?.startsWith('panelot.mcpWorker.') || type === 'panelot.mcpWorker.changed') return;
  void handle(message).then(sendResponse);
  return true;
});

const INITIAL_RECONNECT_DELAY_MS = 100;
const MAX_RECONNECT_DELAY_MS = 5_000;
const STABLE_CONNECTION_MS = 10_000;
let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;

function connectMaintenanceWorker(): void {
  const port = chrome.runtime.connect({ name: MAINTENANCE_WORKER_PORT });
  const stableTimer = setTimeout(() => {
    reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  }, STABLE_CONNECTION_MS);
  port.onMessage.addListener((message: unknown) => {
    if (isOffscreenWorkerCommand(message)) {
      void handleOffscreenWorkerCommand(message).catch(() => {});
      return;
    }
    void handleMaintenanceRequest(message)
      .then((response) => port.postMessage(response))
      .catch(() => undefined);
  });
  port.onDisconnect.addListener(() => {
    clearTimeout(stableTimer);
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    setTimeout(connectMaintenanceWorker, delay);
  });
}

async function handleOffscreenWorkerCommand(command: OffscreenWorkerCommand): Promise<void> {
  if (command.type === 'panelot.offscreen.attachments.cleanup') {
    await new AttachmentRepository(db).cleanupIncomplete();
    return;
  }
  if (command.type === 'panelot.offscreen.attachments.evict') {
    await evictAttachmentsIfNeeded(db, command.activeThreadId);
  }
}

function isOffscreenWorkerCommand(message: unknown): message is OffscreenWorkerCommand {
  return (
    isRecord(message) &&
    typeof message.type === 'string' &&
    message.type.startsWith('panelot.offscreen.')
  );
}

async function handleMaintenanceRequest(message: unknown): Promise<MaintenanceWorkerResponse> {
  const request = message as Partial<MaintenanceWorkerRequest>;
  const requestId = typeof request.requestId === 'string' ? request.requestId : '';
  const operationId = typeof request.operationId === 'string' ? request.operationId : '';
  try {
    if (!requestId || !operationId) throw new Error('IMPORT_VALIDATOR_REQUEST');
    if (request.action === 'plan' && 'input' in request) {
      const plan = await inProcessMaintenanceValidator.buildPlan(request.input, operationId);
      const resultDigest = await maintenanceDigest({
        inputDigest: plan.digest,
        settings: plan.bundle.settings,
      });
      return {
        requestId,
        operationId,
        ok: true,
        result: { digest: plan.digest, resultDigest, settings: plan.bundle.settings },
      };
    }
    if (
      request.action === 'materialized' &&
      isRecord(request.settings) &&
      isRecord(request.plannedSettings)
    ) {
      await inProcessMaintenanceValidator.validateMaterialized(
        request.settings,
        request.localSecretKey,
        request.existingKey,
        request.plannedSettings,
      );
      return { requestId, operationId, ok: true };
    }
    throw new Error('IMPORT_VALIDATOR_REQUEST');
  } catch (error) {
    return {
      requestId,
      operationId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

connectMaintenanceWorker();
