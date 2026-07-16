// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpOAuthPermissionRequired, McpServerConfig } from '../../src/mcp/types';
import { setLang, t } from '../../src/ui/i18n';

const permissionMocks = vi.hoisted(() => ({
  request: vi.fn(),
  requestAll: vi.fn(),
}));
const storeMocks = vi.hoisted(() => ({
  listMcpServers: vi.fn(),
  saveMcpServers: vi.fn(),
}));

vi.mock('../../src/permissions/hostPermissionBroker', () => ({
  hostPermissionBroker: {
    request: permissionMocks.request,
    requestAll: permissionMocks.requestAll,
  },
}));

vi.mock('../../src/mcp/store', () => ({
  listMcpServers: storeMocks.listMcpServers,
  saveMcpServers: storeMocks.saveMcpServers,
}));

import { McpPage } from '../../src/ui/settings/McpPage';

const server: McpServerConfig = {
  id: 'server-1',
  name: 'OAuth MCP',
  url: 'https://rs.example/mcp',
  auth: { kind: 'oauth' },
  enabled: true,
  disabledTools: [],
  connectOnStartup: false,
};

const secondServer: McpServerConfig = {
  ...server,
  id: 'server-2',
  name: 'Second MCP',
  url: 'https://second.example/mcp',
};

const permissionPlan: McpOAuthPermissionRequired = {
  status: 'permission_required',
  stage: 'oauth_endpoints',
  origins: ['https://register.example', 'https://token.example'],
  originReasons: [
    { origin: 'https://register.example', reason: '动态注册 Panelot OAuth 客户端' },
    { origin: 'https://token.example', reason: '交换或刷新 MCP OAuth token' },
  ],
  reason: 'host_permission_required',
  summary: {
    resource: server.url,
    issuer: 'https://as.example/tenant',
    authorizationEndpoint: 'https://as.example/authorize',
    tokenEndpoint: 'https://token.example/token',
    registrationEndpoint: 'https://register.example/register',
  },
  planDigest: 'a'.repeat(64),
  expiresAt: Date.now() + 300_000,
};

let root: Root;
let container: HTMLDivElement;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setLang('en');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  permissionMocks.request.mockResolvedValue(true);
  permissionMocks.requestAll.mockResolvedValue(true);
  storeMocks.listMcpServers.mockResolvedValue([structuredClone(server)]);
  storeMocks.saveMcpServers.mockResolvedValue(undefined);
  sendMessage = vi.fn(async (message: { type?: string; permissionApproval?: unknown }) => {
    if (message.type === 'panelot.mcpStatus') {
      return { ok: true, description: disconnectedDescription() };
    }
    if (message.type === 'panelot.mcpOauth' && !message.permissionApproval) {
      return { ok: false, permissionRequired: permissionPlan };
    }
    if (message.type === 'panelot.mcpOauth') {
      return { ok: true, description: disconnectedDescription() };
    }
    return { ok: true };
  });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('MCP OAuth staged permission UI', () => {
  it('shows every exact origin and continues only after a second permission gesture', async () => {
    await renderPage();
    await click(t('settings.mcp.authorize'));

    expect(permissionMocks.request).toHaveBeenCalledWith(server.url);
    expect(permissionMocks.requestAll).not.toHaveBeenCalled();
    expect(container.textContent).toContain(server.url);
    expect(container.textContent).toContain('https://as.example/tenant');
    expect(container.textContent).toContain('https://register.example');
    expect(container.textContent).toContain('https://token.example');

    await click(t('settings.mcp.permissionContinue'));

    expect(permissionMocks.requestAll).toHaveBeenCalledWith(permissionPlan.origins);
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'panelot.mcpOauth',
      id: server.id,
      permissionApproval: {
        stage: permissionPlan.stage,
        planDigest: permissionPlan.planDigest,
      },
    });
    expect(container.textContent).not.toContain('https://register.example');
  });

  it('keeps a denied plan retryable without sending a continuation or widening permissions', async () => {
    permissionMocks.requestAll.mockResolvedValue(false);
    await renderPage();
    await click(t('settings.mcp.authorize'));
    const oauthCallsBefore = oauthMessages().length;

    await click(t('settings.mcp.permissionContinue'));

    expect(oauthMessages()).toHaveLength(oauthCallsBefore);
    expect(container.textContent).toContain('https://token.example');
    expect(permissionMocks.requestAll).toHaveBeenCalledWith(permissionPlan.origins);

    await click(t('app.cancel'));
    expect(container.textContent).not.toContain('https://token.example');
    expect(oauthMessages()).toHaveLength(oauthCallsBefore);
  });

  it('serializes rapid server updates without losing an earlier change', async () => {
    const firstSave = deferred<void>();
    storeMocks.listMcpServers.mockResolvedValue([
      structuredClone(server),
      structuredClone(secondServer),
    ]);
    storeMocks.saveMcpServers
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValue(undefined);
    await renderPage();

    await clickSwitch(server.name);
    await clickSwitch(secondServer.name);

    expect(storeMocks.saveMcpServers).toHaveBeenCalledOnce();
    firstSave.resolve();
    await vi.waitFor(() => expect(storeMocks.saveMcpServers).toHaveBeenCalledTimes(2));

    expect(storeMocks.saveMcpServers).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: server.id, enabled: false }),
      expect.objectContaining({ id: secondServer.id, enabled: false }),
    ]);
  });
});

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(createElement(McpPage));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickSwitch(label: string): Promise<void> {
  const control = container.querySelector<HTMLButtonElement>(
    `button[role="switch"][aria-label="${label}"]`,
  );
  if (!control) throw new Error(`Switch not found: ${label}`);
  await act(async () => {
    control.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function oauthMessages(): unknown[][] {
  return sendMessage.mock.calls.filter(
    ([message]) => (message as { type?: string }).type === 'panelot.mcpOauth',
  );
}

function disconnectedDescription() {
  return {
    state: { status: 'disconnected' as const },
    tools: [],
    promptCount: 0,
    resourceCount: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
