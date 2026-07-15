import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const extensionPath = path.resolve('dist/chrome-mv3');

const oldThread = {
  id: 'data-e2e-old-thread',
  revision: 1,
  title: 'Existing data',
  createdAt: 1,
  updatedAt: 2,
  leafId: 'data-e2e-old-node',
  tags: [],
  pinned: false,
  archived: false,
  stats: { turns: 1, totalTokens: 0, costUsd: 0 },
  scopeOrigins: [],
};
const oldNode = {
  id: 'data-e2e-old-node',
  threadId: oldThread.id,
  parentId: null,
  seq: 0,
  ts: 1,
  type: 'user_message',
  payload: { content: [{ type: 'text', text: 'existing data' }] },
};
const importedThread = {
  ...oldThread,
  id: 'data-e2e-imported-thread',
  title: 'Imported data',
  leafId: 'data-e2e-imported-node',
};
const importedNode = {
  ...oldNode,
  id: 'data-e2e-imported-node',
  threadId: importedThread.id,
  payload: { content: [{ type: 'text', text: 'imported data' }] },
};
const bundle = {
  version: 2,
  exportedAt: 10,
  threads: [importedThread],
  nodes: [importedNode],
  skills: [],
  memories: [],
  settings: {
    connections: null,
    model_presets: null,
    global_settings: { language: 'en' },
    permission_rules: null,
    sensitive_origins: null,
    mcp_servers: null,
    site_prompts: [{ pattern: 'imported.example', prompt: 'Imported prompt' }],
  },
};

test('data import cancels cleanly, rechecks TOCTOU blockers, and reconciles after reload', async () => {
  test.setTimeout(90_000);
  const testInfo = test.info();
  const profilePath = testInfo.outputPath('profile');
  const importPath = testInfo.outputPath('panelot-import.json');
  writeFileSync(importPath, JSON.stringify(bundle));

  let context = await launchExtension(profilePath);
  let contextClosed = false;
  context.on('close', () => {
    contextClosed = true;
  });

  try {
    const worker = await backgroundWorker(context);
    const extensionId = new URL(worker.url()).host;
    await expect
      .poll(() =>
        worker.evaluate(async () => {
          const stored = await chrome.storage.local.get('panelot_storage_generation');
          return stored.panelot_storage_generation;
        }),
      )
      .toBe('panelot_v1');
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        global_settings: { language: 'en' },
        site_prompts: [{ pattern: 'existing.example', prompt: 'Existing prompt' }],
      });
    });

    const page = await openDataPage(context, extensionId);
    await seedExistingData(page);

    await page.locator('#data-json-import').setInputFiles(importPath);
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(await readDataState(page)).toMatchObject({
      threadIds: [oldThread.id],
      nodeIds: [oldNode.id],
      runIds: [],
      marker: null,
      journal: null,
      sitePrompts: [{ pattern: 'existing.example', prompt: 'Existing prompt' }],
    });

    await page.locator('#data-json-import').setInputFiles(importPath);
    await dialog.getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(
      dialog.getByText('Preview passed. Ready to commit.', { exact: true }),
    ).toBeVisible();

    await putRun(page, {
      id: 'data-e2e-blocker',
      threadId: oldThread.id,
      turnId: 'data-e2e-turn',
      clientId: 'data-e2e-client',
      submissionId: 'data-e2e-submission',
      input: { text: 'in flight' },
      state: 'streaming_model',
      revision: 1,
      stepCursor: 0,
      createdAt: 3,
      updatedAt: 3,
    });
    await dialog.getByRole('button', { name: 'Overwrite and import', exact: true }).click();
    await expect(
      dialog.getByText('Current activity blocks this import', { exact: true }),
    ).toBeVisible();
    expect(await readDataState(page)).toMatchObject({
      threadIds: [oldThread.id],
      nodeIds: [oldNode.id],
      runIds: ['data-e2e-blocker'],
      marker: null,
      journal: null,
      sitePrompts: [{ pattern: 'existing.example', prompt: 'Existing prompt' }],
    });

    await deleteRun(page, 'data-e2e-blocker');
    await dialog.getByRole('button', { name: 'Preview import', exact: true }).click();
    await expect(
      dialog.getByText('Preview passed. Ready to commit.', { exact: true }),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Overwrite and import', exact: true }).click();
    await expect(
      page.getByText('Data maintenance is waiting for an extension reload'),
    ).toBeVisible();

    const committed = await readDataState(page);
    expect(committed).toMatchObject({
      threadIds: [importedThread.id],
      nodeIds: [importedNode.id],
      runIds: [],
      marker: { id: 'data-import' },
      journal: { phase: 'db_committed' },
      sitePrompts: [{ pattern: 'imported.example', prompt: 'Imported prompt' }],
    });
    const operationId = committed.journal?.operationId;
    const digest = committed.journal?.digest;
    expect(operationId).toBeTruthy();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'panelot.dataImport', action: 'status' });
    });
    const workerBeforeReload = await backgroundWorker(context);
    const epochBeforeReload = await workerBeforeReload.evaluate(async () => {
      const stored = await chrome.storage.session.get('panelot_engine_stream_epoch');
      return stored.panelot_engine_stream_epoch as number;
    });
    expect(epochBeforeReload).toBeGreaterThan(0);
    await page
      .getByRole('button', { name: 'Reload extension now', exact: true })
      .click()
      .catch((error: unknown) => {
        if (!page.isClosed() && !contextClosed) throw error;
      });
    await expect.poll(() => page.isClosed() || contextClosed).toBe(true);

    if (!contextClosed) await context.close();
    context = await launchExtension(profilePath);
    contextClosed = false;
    context.on('close', () => {
      contextClosed = true;
    });
    const reloadedWorker = await backgroundWorker(context);
    expect(reloadedWorker).not.toBe(workerBeforeReload);
    expect(new URL(reloadedWorker.url()).host).toBe(extensionId);
    let epochAfterReconcile = 0;
    await expect
      .poll(async () => {
        epochAfterReconcile = await reloadedWorker.evaluate(async () => {
          const stored = await chrome.storage.session.get('panelot_engine_stream_epoch');
          return stored.panelot_engine_stream_epoch as number;
        });
        return epochAfterReconcile;
      })
      .toBeGreaterThan(0);

    const recoveredPage = await openDataPage(context, extensionId);
    await expect(
      recoveredPage.getByText('A committed import was detected and recovery cleanup completed.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(await readDataState(recoveredPage)).toMatchObject({
      threadIds: [importedThread.id],
      nodeIds: [importedNode.id],
      runIds: [],
      marker: null,
      journal: null,
      lastCompleted: { operationId, digest },
      sitePrompts: [{ pattern: 'imported.example', prompt: 'Imported prompt' }],
    });

    const internalsPage = await context.newPage();
    await internalsPage.goto('chrome://serviceworker-internals/');
    const stopWorker = internalsPage.locator('cr-button[data-command="stop"]');
    await expect(stopWorker).toHaveCount(1);
    await stopWorker.click();
    await expect(internalsPage.locator('body')).toContainText('Running Status: STOPPED');
    await internalsPage.close();
    await recoveredPage.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: 'panelot.dataImport', action: 'status' });
    });
    await expect
      .poll(() =>
        recoveredPage.evaluate(async () => {
          const stored = await chrome.storage.session.get('panelot_engine_stream_epoch');
          return stored.panelot_engine_stream_epoch;
        }),
      )
      .toBe(epochAfterReconcile + 1);
  } finally {
    if (!contextClosed) await context.close();
  }
});

async function launchExtension(profilePath: string): Promise<BrowserContext> {
  return chromium.launchPersistentContext(profilePath, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
}

async function backgroundWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers().at(-1) ?? context.waitForEvent('serviceworker');
}

async function openDataPage(context: BrowserContext, extensionId: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await expect(page).toHaveTitle(/Panelot Settings/);
  await page.getByRole('tab', { name: 'Data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Data', exact: true })).toBeVisible();
  return page;
}

async function seedExistingData(page: Page): Promise<void> {
  await page.evaluate(
    async ({ thread, node }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('panelot_v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(['threads', 'nodes'], 'readwrite');
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
          transaction.objectStore('threads').put(thread);
          transaction.objectStore('nodes').put(node);
        });
      } finally {
        db.close();
      }
    },
    { thread: oldThread, node: oldNode },
  );
}

async function putRun(page: Page, run: Record<string, unknown>): Promise<void> {
  await page.evaluate(async (value) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('panelot_v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['runs'], 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        transaction.objectStore('runs').put(value);
      });
    } finally {
      db.close();
    }
  }, run);
}

async function deleteRun(page: Page, runId: string): Promise<void> {
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('panelot_v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['runs'], 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
        transaction.objectStore('runs').delete(id);
      });
    } finally {
      db.close();
    }
  }, runId);
}

interface DataState {
  threadIds: string[];
  nodeIds: string[];
  runIds: string[];
  marker: null | { id: string; operationId: string; digest: string };
  journal: null | { operationId: string; digest: string; phase: string };
  lastCompleted: null | { operationId: string; digest: string };
  sitePrompts: unknown;
}

async function readDataState(page: Page): Promise<DataState> {
  return page.evaluate(async () => {
    const storage = await chrome.storage.local.get([
      'site_prompts',
      'panelot_import_journal_v1',
      'panelot_import_last_completed_v1',
    ]);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('panelot_v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      const transaction = db.transaction(['threads', 'nodes', 'runs', 'maintenance'], 'readonly');
      const result = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const [threads, nodes, runs, marker] = await Promise.all([
        result(transaction.objectStore('threads').getAll()),
        result(transaction.objectStore('nodes').getAll()),
        result(transaction.objectStore('runs').getAll()),
        result(transaction.objectStore('maintenance').get('data-import')),
      ]);
      return {
        threadIds: threads.map((value) => String((value as { id: unknown }).id)).sort(),
        nodeIds: nodes.map((value) => String((value as { id: unknown }).id)).sort(),
        runIds: runs.map((value) => String((value as { id: unknown }).id)).sort(),
        marker: (marker as DataState['marker']) ?? null,
        journal: (storage.panelot_import_journal_v1 as DataState['journal']) ?? null,
        lastCompleted:
          (storage.panelot_import_last_completed_v1 as DataState['lastCompleted']) ?? null,
        sitePrompts: storage.site_prompts,
      };
    } finally {
      db.close();
    }
  });
}
