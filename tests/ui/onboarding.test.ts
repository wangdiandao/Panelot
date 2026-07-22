// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerifyResult } from '../../src/providers/types';
import { setLang, t } from '../../src/ui/i18n';

const registryMocks = vi.hoisted(() => ({ createAdapter: vi.fn() }));
const verifyMocks = vi.hoisted(() => ({ verifyConnection: vi.fn() }));
const permissionMocks = vi.hoisted(() => ({ request: vi.fn() }));
const settingsMocks = vi.hoisted(() => ({
  upsertConnection: vi.fn(),
  patchGlobal: vi.fn(),
}));

vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/registry')>()),
  createAdapter: registryMocks.createAdapter,
}));

vi.mock('../../src/providers/verify', () => ({
  verifyConnection: verifyMocks.verifyConnection,
}));

vi.mock('../../src/permissions/hostPermissionBroker', () => ({
  hostPermissionBroker: { request: permissionMocks.request },
}));

vi.mock('../../src/settings/crypto', () => ({
  encryptSecret: vi.fn(async (value: string) => `encrypted:${value}`),
}));

vi.mock('../../src/settings/store', () => ({
  SettingsStore: {
    connections: { upsert: settingsMocks.upsertConnection },
    global: { patch: settingsMocks.patchGlobal },
  },
}));

import { Onboarding } from '../../src/ui/components/Onboarding';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  setLang('zh-CN');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  permissionMocks.request.mockResolvedValue(true);
  registryMocks.createAdapter.mockReturnValue({});
  settingsMocks.upsertConnection.mockResolvedValue(undefined);
  settingsMocks.patchGlobal.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function setInput(selector: string, value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>(selector)!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function click(text: string): Promise<void> {
  await act(async () => {
    buttonContaining(text).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('Onboarding verification ordering', () => {
  it('keeps only the newest fingerprint result and saves it with an atomic upsert', async () => {
    const first = deferred<VerifyResult>();
    const second = deferred<VerifyResult>();
    verifyMocks.verifyConnection
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await act(async () =>
      root.render(
        createElement(Onboarding, {
          onConfigured: vi.fn(),
          onOpenSettings: vi.fn(),
          onTryDemo: vi.fn(),
        }),
      ),
    );
    await setInput('#ob-url', 'https://first.example/v1');
    await setInput('#ob-key', 'sk-local-secret');
    await click(t('settings.providers.verify'));

    await setInput('#ob-url', 'https://second.example/v1');
    await click(t('settings.providers.verify'));
    expect(registryMocks.createAdapter).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({
        reachable: true,
        keyValid: true,
        streaming: true,
        toolUse: true,
        models: ['model-b'],
      });
      await second.promise;
      await Promise.resolve();
    });
    expect(container.textContent).toContain('连接成功');
    expect(buttonContaining('下一步').disabled).toBe(false);

    await act(async () => {
      first.resolve({
        reachable: false,
        keyValid: false,
        streaming: false,
        toolUse: false,
        detail: 'stale failure containing sk-local-secret',
      });
      await first.promise;
      await Promise.resolve();
    });
    expect(container.textContent).toContain('连接成功');
    expect(container.textContent).not.toContain('stale failure');

    await click('下一步');
    expect(settingsMocks.upsertConnection).toHaveBeenCalledOnce();
    expect(settingsMocks.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: registryMocks.createAdapter.mock.calls[1]![0].id,
        baseUrl: 'https://second.example/v1',
        apiKeys: ['encrypted:sk-local-secret'],
      }),
    );
  });

  it('invalidates a successful verification as soon as a credential field changes', async () => {
    verifyMocks.verifyConnection.mockResolvedValue({
      reachable: true,
      keyValid: true,
      streaming: true,
      toolUse: true,
    });

    await act(async () =>
      root.render(
        createElement(Onboarding, {
          onConfigured: vi.fn(),
          onOpenSettings: vi.fn(),
          onTryDemo: vi.fn(),
        }),
      ),
    );
    await setInput('#ob-url', 'https://api.example/v1');
    await setInput('#ob-key', 'sk-one');
    await click(t('settings.providers.verify'));
    expect(buttonContaining('下一步').disabled).toBe(false);

    await setInput('#ob-key', 'sk-two');
    expect(buttonContaining('下一步').disabled).toBe(true);
    expect(container.textContent).not.toContain('连接成功');
  });
});
