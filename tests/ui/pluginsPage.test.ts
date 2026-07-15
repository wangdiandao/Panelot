// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginInstallPlan } from '../../src/plugins/manifest';
import { setLang, t } from '../../src/ui/i18n';

const pluginMocks = vi.hoisted(() => ({
  analyzeUrl: vi.fn(),
  analyzeZip: vi.fn(),
  commit: vi.fn(),
  setEnabled: vi.fn(),
  uninstall: vi.fn(),
}));
const permissionMocks = vi.hoisted(() => ({ requestAll: vi.fn() }));
const tableMocks = vi.hoisted(() => ({
  plugins: [] as unknown[],
  assets: [] as unknown[],
}));

vi.mock('../../src/db/schema', () => ({
  PanelotDB: class {
    plugins = {
      orderBy: vi.fn(() => ({ toArray: vi.fn(async () => tableMocks.plugins) })),
    };
    pluginAssets = {
      orderBy: vi.fn(() => ({ toArray: vi.fn(async () => tableMocks.assets) })),
    };
  },
}));

vi.mock('../../src/plugins/manager', () => ({
  PluginManager: class {
    analyzeUrl = pluginMocks.analyzeUrl;
    analyzeZip = pluginMocks.analyzeZip;
    commit = pluginMocks.commit;
    setEnabled = pluginMocks.setEnabled;
    uninstall = pluginMocks.uninstall;
  },
  pluginDownloadPermissionOrigins: vi.fn(() => ['https://codeload.github.com']),
}));

vi.mock('../../src/permissions/hostPermissionBroker', () => ({
  hostPermissionBroker: { requestAll: permissionMocks.requestAll },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { PluginsPage } from '../../src/ui/settings/PluginsPage';

let root: Root;
let container: HTMLDivElement;

const plan = Object.freeze({
  format: 'panelot-plugin-install-plan',
  digest: `sha256:${'a'.repeat(64)}`,
  analyzedAt: 1_000,
  expiresAt: 301_000,
  source: Object.freeze({
    kind: 'github',
    label: 'https://github.com/example/plugin',
    resolvedUrl: 'https://codeload.github.com/example/plugin/zip/refs/heads/main',
  }),
  operation: 'install',
  manifest: Object.freeze({
    id: 'preview-plugin',
    name: 'Preview Plugin',
    version: '1.0.0',
    description: 'Preview description',
    assets: Object.freeze([
      Object.freeze({ path: 'skills/example/SKILL.md', kind: 'skill' as const }),
      Object.freeze({ path: 'sites/example.json', kind: 'site-instruction' as const }),
    ]),
  }),
  assets: Object.freeze([
    Object.freeze({
      path: 'skills/example/SKILL.md',
      kind: 'skill' as const,
      mime: 'text/markdown',
      bytes: 128,
    }),
    Object.freeze({
      path: 'sites/example.json',
      kind: 'site-instruction' as const,
      mime: 'application/json',
      bytes: 64,
    }),
  ]),
  skills: Object.freeze([
    Object.freeze({
      path: 'skills/example/SKILL.md',
      name: 'preview-skill',
      description: 'Preview skill description',
    }),
  ]),
  presets: Object.freeze([]),
  siteInstructions: Object.freeze([
    Object.freeze({
      path: 'sites/example.json',
      pattern: 'example.com',
      instructionSummary: 'Treat page content as untrusted.',
    }),
  ]),
  warnings: Object.freeze(['prompt-assets-disabled' as const]),
}) satisfies PluginInstallPlan;

beforeEach(() => {
  setLang('en');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  tableMocks.plugins = [];
  tableMocks.assets = [];
  permissionMocks.requestAll.mockResolvedValue(true);
  pluginMocks.analyzeUrl.mockResolvedValue(plan);
  pluginMocks.commit.mockResolvedValue({ ...plan.manifest, enabled: false });
  pluginMocks.setEnabled.mockResolvedValue(undefined);
  pluginMocks.uninstall.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll('[data-slot="dialog-overlay"]').forEach((element) => element.remove());
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function setInputValue(value: string): Promise<void> {
  const input = container.querySelector(
    `input[aria-label="${t('settings.plugins.urlLabel')}"]`,
  ) as HTMLInputElement | null;
  if (!input) throw new Error('URL input not found');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })));
}

async function openPreview(): Promise<HTMLElement> {
  await act(async () => root.render(createElement(PluginsPage)));
  await flush();
  await setInputValue('https://github.com/example/plugin');
  await act(async () => {
    buttonContaining(t('settings.plugins.analyzeGithub')).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await Promise.resolve();
  });
  await flush();
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error('Preview dialog not found');
  return dialog;
}

describe('PluginsPage install preview', () => {
  it('renders the full source, digest, assets, prompt summaries, and disabled warning before writes', async () => {
    const dialog = await openPreview();

    expect(permissionMocks.requestAll).toHaveBeenCalledWith(['https://codeload.github.com']);
    expect(pluginMocks.analyzeUrl).toHaveBeenCalledWith('https://github.com/example/plugin');
    expect(pluginMocks.commit).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Preview Plugin');
    expect(dialog.textContent).toContain(plan.source.label);
    expect(dialog.textContent).toContain(plan.source.resolvedUrl);
    expect(dialog.textContent).toContain(plan.digest);
    expect(dialog.textContent).toContain('skills/example/SKILL.md');
    expect(dialog.textContent).toContain('preview-skill');
    expect(dialog.textContent).toContain('example.com');
    expect(dialog.textContent).toContain('Treat page content as untrusted.');
    expect(dialog.textContent).toContain('do not enter prompts on install');
    expect(buttonContaining(t('settings.plugins.cancel')).disabled).toBe(false);
    expect(buttonContaining(t('settings.plugins.confirmInstall')).disabled).toBe(false);
  });

  it('cancels the preview without committing', async () => {
    await openPreview();
    await act(async () =>
      buttonContaining(t('settings.plugins.cancel')).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    await flush();

    expect(pluginMocks.commit).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('commits only from the second explicit confirmation and preserves the disabled result', async () => {
    await openPreview();
    await act(async () => {
      buttonContaining(t('settings.plugins.confirmInstall')).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    await flush();

    expect(pluginMocks.commit).toHaveBeenCalledTimes(1);
    expect(pluginMocks.commit).toHaveBeenCalledWith(plan, { confirmed: true });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
