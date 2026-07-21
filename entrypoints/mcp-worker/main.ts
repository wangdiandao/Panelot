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
import { McpWorkerSessions } from '../../src/mcp/workerSessions';

const sessions = new McpWorkerSessions<McpClient>();
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
    connectionId?: string;
    operationId?: string;
    url?: string;
    authorization?: string | null;
    name?: string;
    args?: unknown;
    uri?: string;
    context?: { threadId: string; itemId: string };
  };
  if (
    !request.type?.startsWith('panelot.mcpWorker.') ||
    !request.serverId ||
    !request.connectionId
  ) {
    return undefined;
  }

  try {
    if (request.type === 'panelot.mcpWorker.connect') {
      if (!request.url) throw new Error('MCP worker URL is missing');
      const { lease, previous } = sessions.claimConnection(request.serverId, request.connectionId);
      if (previous) await previous.client.close();
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
              connectionId: request.connectionId,
              catalog: catalog(client),
            })
            .catch(() => {});
        },
        onElicit: async (elicitation, context) => {
          const response = (await chrome.runtime.sendMessage({
            type: 'panelot.mcpWorkerElicitation',
            serverId: request.serverId,
            context,
            ...elicitation,
          })) as { action?: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
          return {
            action: response.action ?? 'decline',
            ...(response.content
              ? {
                  content: response.content as Record<string, string | number | boolean | string[]>,
                }
              : {}),
          };
        },
      });
      await client.connect();
      if (!sessions.commitConnection(lease, client)) {
        await client.close().catch(() => undefined);
        throw new Error('MCP worker connection was superseded');
      }
      return { ok: true, catalog: catalog(client) };
    }

    if (request.type === 'panelot.mcpWorker.close') {
      const closing = sessions.closeConnection(request.serverId, request.connectionId);
      if (!closing.owned) return { ok: true };
      await closing.client?.close();
      return { ok: true };
    }
    if (request.type === 'panelot.mcpWorker.cancel') {
      if (!request.operationId) throw new Error('MCP operation id is missing');
      sessions.cancelToolCall(request.serverId, request.connectionId, request.operationId);
      return { ok: true };
    }
    const client = sessions.getClient(request.serverId, request.connectionId);
    if (!client) {
      throw new Error(`MCP server session is not connected: ${request.serverId}`);
    }
    if (request.type === 'panelot.mcpWorker.callTool') {
      if (!request.name) throw new Error('MCP tool name is missing');
      if (!request.operationId) throw new Error('MCP operation id is missing');
      const controller = sessions.claimToolCall(
        request.serverId,
        request.connectionId,
        request.operationId,
      );
      try {
        return {
          ok: true,
          result: await client.callTool(
            request.name,
            request.args,
            request.context,
            controller.signal,
          ),
        };
      } finally {
        sessions.finishToolCall(
          request.serverId,
          request.connectionId,
          request.operationId,
          controller,
        );
      }
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
