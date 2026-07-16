import type { McpManager } from './manager';
import { permissionRequiredFromError } from './manager';
import type { McpOAuthPermissionApproval } from './types';

interface McpRuntimeMessage {
  type?: string;
  id?: string;
  resourceMetadataUrl?: string;
  scope?: string;
  error?: string;
  url?: string;
  permissionApproval?: McpOAuthPermissionApproval;
  serverId?: string;
  uri?: string;
}

type SendResponse = (response?: unknown) => void;

export function handleMcpRuntimeMessage(
  mcp: McpManager,
  message: unknown,
  sendResponse: SendResponse,
): void {
  const m = message as McpRuntimeMessage;
  if (m.type === 'panelot.mcpWorkerPermissionCheck' && m.id && m.url) {
    void mcp
      .checkWorkerFetchPermission(m.id, m.url)
      .then((result) =>
        sendResponse(
          result.status === 'complete'
            ? { allowed: true }
            : { allowed: false, permissionRequired: result },
        ),
      )
      .catch((error: unknown) => sendResponse({ allowed: false, error: errorMessage(error) }));
    return;
  }
  if (m.type === 'panelot.mcpWorkerUnauthorized' && m.id) {
    void mcp
      .reauthorizeWorker(m.id, {
        resourceMetadataUrl: m.resourceMetadataUrl,
        scope: m.scope,
        error: m.error,
      })
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, error: 'MCP reauthorization failed' }));
    return;
  }
  if (m.type === 'panelot.mcpOauth' && m.id) {
    const id = m.id;
    void mcp
      .runOAuthFlow(id, {}, m.permissionApproval)
      .then(async (result) => {
        if (result.status === 'permission_required') {
          sendResponse({ ok: false, permissionRequired: result });
          return;
        }
        await mcp.connect(id);
        sendResponse({ ok: true, description: mcp.describeServer(id) });
      })
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: errorMessage(error),
          permissionRequired: permissionRequiredFromError(error),
        }),
      );
    return;
  }
  if (m.type === 'panelot.mcpCatalog') {
    void mcp
      .ensureConnected('use')
      .then(() =>
        sendResponse({
          ok: true,
          prompts: mcp.listPromptCommands(),
          resources: mcp.listResourceReferences(),
        }),
      )
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return;
  }
  if ((m.type === 'panelot.mcpConnect' || m.type === 'panelot.mcpStatus') && m.id) {
    const id = m.id;
    void (m.type === 'panelot.mcpConnect' ? mcp.connect(id) : Promise.resolve())
      .then(() => sendResponse({ ok: true, description: mcp.describeServer(id) }))
      .catch((error: unknown) =>
        sendResponse({
          ok: false,
          error: errorMessage(error),
          permissionRequired: permissionRequiredFromError(error),
          description: mcp.describeServer(id),
        }),
      );
    return;
  }
  if (m.type === 'panelot.mcpDisconnect' && m.id) {
    const id = m.id;
    void mcp
      .disconnect(id)
      .then(() => sendResponse({ ok: true, description: mcp.describeServer(id) }))
      .catch(() => sendResponse({ ok: false, error: 'MCP disconnect failed' }));
    return;
  }
  if (m.type === 'panelot.mcpReadResource' && m.serverId && m.uri) {
    void mcp
      .readResourceContext(m.serverId, m.uri)
      .then((context) => sendResponse({ ok: true, context }))
      .catch((error: unknown) => sendResponse({ ok: false, error: errorMessage(error) }));
    return;
  }
  sendResponse({ ok: false, error: 'Invalid MCP request' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
