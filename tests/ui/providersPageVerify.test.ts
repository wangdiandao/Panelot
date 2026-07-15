// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, type VerifyResult } from '../../src/providers/types';
import { setLang, t } from '../../src/ui/i18n';

const registryMocks = vi.hoisted(() => ({ createAdapter: vi.fn() }));
const permissionMocks = vi.hoisted(() => ({ request: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({
  getConnections: vi.fn(),
  upsertConnection: vi.fn(),
  removeConnection: vi.fn(),
  getGlobal: vi.fn(),
  patchGlobal: vi.fn(),
}));

vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/registry')>()),
  createAdapter: registryMocks.createAdapter,
}));

vi.mock('../../src/permissions/hostPermissionBroker', () => ({
  hostPermissionBroker: { request: permissionMocks.request },
}));

vi.mock('../../src/settings/store', () => ({
  storageGet: vi.fn((key: string, fallback: unknown) => {
    if (key === 'connections') return settingsMocks.getConnections();
    if (key === 'global_settings') return settingsMocks.getGlobal();
    return Promise.resolve(fallback);
  }),
  onStorageChange: vi.fn(() => () => {}),
  SettingsStore: {
    connections: {
      get: settingsMocks.getConnections,
      upsert: settingsMocks.upsertConnection,
      remove: settingsMocks.removeConnection,
    },
    global: {
      get: settingsMocks.getGlobal,
      patch: settingsMocks.patchGlobal,
    },
  },
}));

import { ProvidersPage } from '../../src/ui/settings/ProvidersPage';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  setLang('zh-CN');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  settingsMocks.getConnections.mockResolvedValue([]);
  settingsMocks.upsertConnection.mockResolvedValue(undefined);
  settingsMocks.removeConnection.mockResolvedValue(undefined);
  settingsMocks.getGlobal.mockResolvedValue({});
  settingsMocks.patchGlobal.mockResolvedValue(undefined);
  permissionMocks.request.mockResolvedValue(true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function openConnectionForm(): Promise<void> {
  await act(async () => root.render(createElement(ProvidersPage)));
  await act(async () =>
    buttonContaining(t('settings.providers.add')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    ),
  );
}

async function setControlValue(selector: string, value: string): Promise<void> {
  const control = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!control) throw new Error(`Control not found: ${selector}`);
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
  await act(async () => control.dispatchEvent(new Event('input', { bubbles: true })));
}

async function clickVerify(): Promise<void> {
  await act(async () => {
    buttonContaining(t('settings.providers.verify')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await Promise.resolve();
  });
}

describe('ProvidersPage connection verification', () => {
  it('keeps endpoint validation details in the selected UI language', async () => {
    setLang('en');
    await openConnectionForm();
    await setControlValue('#conn-url', 'http://api.example.com/v1');

    await clickVerify();
    await flush();

    const alertText = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alertText).toContain('valid HTTPS provider endpoint');
    expect(alertText).not.toMatch(/[\u3400-\u9fff]/u);
  });

  it('shows a safe validation error and restores the button after a synchronous URL failure', async () => {
    await openConnectionForm();
    await setControlValue('#conn-url', 'http://api.example.com/v1');
    await setControlValue('#conn-keys', 'sk-sync-secret');

    await clickVerify();
    await flush();

    const button = buttonContaining(t('settings.providers.verify'));
    const alertText = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(alertText).toContain('HTTPS');
    expect(alertText).not.toContain('sk-sync-secret');
    expect(registryMocks.createAdapter).not.toHaveBeenCalled();
  });

  it('turns an asynchronous adapter rejection into a visible message without leaking secrets', async () => {
    registryMocks.createAdapter.mockReturnValue({
      verify: vi.fn().mockRejectedValue(
        new ProviderError('auth', 'request failed with sk-async-secret', undefined, {
          status: 401,
          reason: 'invalid_key',
          upstreamMessage: 'credential sk-async-secret was rejected',
        }),
      ),
    });
    await openConnectionForm();
    await setControlValue('#conn-url', 'https://api.example.com/v1');
    await setControlValue('#conn-keys', 'sk-async-secret');

    await clickVerify();
    await flush();

    const button = buttonContaining(t('settings.providers.verify'));
    const alertText = container.querySelector('[role="alert"]')?.textContent ?? '';
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(alertText).toContain('Base URL');
    expect(alertText).toContain('HTTP 401');
    expect(alertText).not.toContain('request failed with sk-async-secret');
    expect(alertText).not.toContain('credential sk-async-secret was rejected');
    expect(alertText).not.toContain('sk-async-secret');
  });

  it('keeps the button busy until a successful verification settles, then renders the result', async () => {
    let resolveVerify!: (result: VerifyResult) => void;
    const pending = new Promise<VerifyResult>((resolve) => {
      resolveVerify = resolve;
    });
    registryMocks.createAdapter.mockReturnValue({ verify: vi.fn(() => pending) });
    await openConnectionForm();
    await setControlValue('#conn-url', 'https://api.example.com/v1');

    await clickVerify();

    let button = buttonContaining('验证中');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');

    await act(async () => {
      resolveVerify({
        reachable: true,
        keyValid: true,
        streaming: true,
        toolUse: true,
        models: ['model-a'],
      });
      await pending;
    });

    button = buttonContaining(t('settings.providers.verify'));
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('可达');
    expect(container.textContent).toContain('model-a');
  });
});
