// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalImportPlan } from '../../src/data/importContract';
import type { ExportBundle } from '../../src/data/exportImport';
import { setLang, t } from '../../src/ui/i18n';

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  prepare: vi.fn(),
  materialize: vi.fn(),
  send: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('../../src/db/schema', () => ({ PanelotDB: class {} }));
vi.mock('../../src/data/exportImport', () => ({
  exportAll: vi.fn(),
  validateImportBundle: mocks.validate,
  materializeImportSettings: mocks.materialize,
}));
vi.mock('../../src/data/maintenancePlan', () => ({
  prepareCanonicalImport: mocks.prepare,
}));
vi.mock('../../src/data/maintenanceRpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/data/maintenanceRpc')>()),
  sendDataImportRpc: mocks.send,
}));
vi.mock('../../src/data/quota', () => ({
  getQuotaStatus: vi.fn(async () => ({ usage: 1, quota: 100, pct: 0.01, warn: false })),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { DataPage } from '../../src/ui/settings/DataPage';

let root: Root;
let container: HTMLDivElement;

const bundle: ExportBundle = {
  version: 2,
  exportedAt: 1,
  threads: [],
  nodes: [],
  skills: [],
  memories: [],
  settings: {
    connections: null,
    model_presets: null,
    global_settings: null,
    permission_rules: null,
    sensitive_origins: null,
    mcp_servers: null,
    site_prompts: null,
  },
};
const plan: CanonicalImportPlan = {
  version: 1,
  exportedAt: bundle.exportedAt,
  threads: bundle.threads,
  nodes: bundle.nodes,
  skills: [],
  memories: [],
  settings: bundle.settings,
};
const report = {
  bytes: 128,
  threadCount: 0,
  nodeCount: 0,
  skillCount: 0,
  memoryCount: 0,
  hasEncryptedSecrets: false,
};
const blockers = {
  activeThreadIds: [],
  hardRuns: {},
  dormantRuns: { queued: 1 },
  pendingApprovals: 0,
  requiresDormantConfirmation: true,
  hardBlocked: false,
};

beforeEach(() => {
  setLang('en');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { reload: mocks.reload },
  };
  mocks.validate.mockResolvedValue({ bundle, report });
  mocks.prepare.mockResolvedValue({ bundle, plan, report });
  mocks.materialize.mockResolvedValue({
    settings: bundle.settings,
    oauthAccessToClear: 0,
  });
  mocks.send.mockImplementation(async (request: { action: string; operationId?: string }) => {
    if (request.action === 'status') {
      const committed = mocks.send.mock.calls.some(([candidate]) => candidate.action === 'commit');
      return committed
        ? {
            blocked: true,
            reconciliation: 'none',
            journal: { operationId: 'op', digest: 'a'.repeat(64), phase: 'db_committed' },
          }
        : { blocked: false, reconciliation: 'none' };
    }
    if (request.action === 'preview') {
      return { operationId: request.operationId, digest: 'a'.repeat(64), blockers };
    }
    return {
      status: 'committed',
      operationId: request.operationId,
      digest: 'a'.repeat(64),
      reloadRequired: true,
      oauthAccessToClear: 0,
    };
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document
    .querySelectorAll('[data-slot="alert-dialog-overlay"]')
    .forEach((element) => element.remove());
  vi.clearAllMocks();
});

describe('DataPage maintenance import', () => {
  it('previews in the background before an explicitly confirmed commit and exposes reload', async () => {
    await act(async () => root.render(createElement(DataPage)));
    await flush();
    const file = new File([JSON.stringify(bundle)], 'backup.json', { type: 'application/json' });
    const input = container.querySelector<HTMLInputElement>('#data-json-import');
    if (!input) throw new Error('Import input not found');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    await flush();

    expect(actions()).toEqual(['status']);
    await clickButton(t('settings.data.previewImport'));
    expect(actions()).toEqual(['status', 'preview']);
    expect(mocks.materialize).not.toHaveBeenCalled();
    expect(actions()).not.toContain('commit');

    const commit = buttonContaining(t('settings.data.overwrite'));
    expect(commit.disabled).toBe(true);
    const confirmation = document.querySelector<HTMLButtonElement>('#confirm-dormant-import');
    if (!confirmation) throw new Error('Dormant confirmation not found');
    await act(async () => confirmation.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(buttonContaining(t('settings.data.overwrite')).disabled).toBe(false);

    await clickButton(t('settings.data.overwrite'));
    expect(actions()).toEqual(['status', 'preview', 'commit', 'status']);
    expect(mocks.send.mock.calls[2]?.[0]).toMatchObject({
      action: 'commit',
      expectedDigest: 'a'.repeat(64),
      confirmDiscardDormant: true,
    });
    expect(document.body.textContent).toContain(t('settings.data.reloadRequired'));

    await clickButton(t('settings.data.reloadNow'));
    expect(mocks.reload).toHaveBeenCalledOnce();
  });
});

function actions(): string[] {
  return mocks.send.mock.calls.map(([request]) => request.action as string);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

async function clickButton(text: string): Promise<void> {
  await act(async () => {
    buttonContaining(text).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await flush();
}
