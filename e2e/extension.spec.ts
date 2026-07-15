import { expect, test, chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const extensionPath = path.resolve('dist/chrome-mv3');
const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
  version: string;
};

test.describe.configure({ mode: 'serial' });

test('loads the production extension in a persistent Chromium context', async () => {
  const testInfo = test.info();
  const context = await chromium.launchPersistentContext(testInfo.outputPath('profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/options.html`);

    await expect(page).toHaveTitle(/Panelot Settings/);
    await expect(page.getByText('Panelot', { exact: false }).first()).toBeVisible();
    const manifest = await page.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions).toContain('<all_urls>');
    expect(manifest.permissions).toContain('offscreen');
  } finally {
    await context.close();
  }
});

test('new Chat and Side Panel drafts explain why file upload is unavailable', async () => {
  const testInfo = test.info();
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath('attachment-profile'),
    {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    },
  );

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        connections: [
          {
            id: 'local-e2e',
            name: 'Local E2E',
            kind: 'openai',
            baseUrl: 'http://localhost:11434/v1',
            apiKeys: [],
            enabled: true,
          },
        ],
      });
    });

    for (const surface of [
      {
        path: 'chat.html',
        language: 'zh-CN',
        add: '添加',
        upload: '上传文件',
        message: '请先发送一条消息创建会话，再上传文件。',
      },
      {
        path: 'sidepanel.html',
        language: 'en',
        add: 'Add',
        upload: 'Upload file',
        message: 'Send a message to create the chat before uploading a file.',
      },
    ]) {
      await worker.evaluate(async (language) => {
        await chrome.storage.local.set({ global_settings: { language } });
      }, surface.language);
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extensionId}/${surface.path}`);
      const before = await countAttachments(page);
      await page.getByRole('button', { name: surface.add, exact: true }).click();
      const chooser = page.waitForEvent('filechooser', { timeout: 500 });
      await page.getByRole('menuitem', { name: surface.upload, exact: true }).click();
      await expect(chooser).rejects.toThrow();
      await expect(page.getByText(surface.message, { exact: true })).toBeVisible();
      expect(await countAttachments(page)).toBe(before);
      await page.close();
    }
  } finally {
    await context.close();
  }
});

test('collapsed Chat sidebar keeps a visible expand trigger', async () => {
  const testInfo = test.info();
  const context = await chromium.launchPersistentContext(testInfo.outputPath('sidebar-profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        global_settings: { language: 'en', sidebarCollapsed: false },
      });
    });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/chat.html`);

    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
    await expect(page.locator('[data-slot="sidebar"][data-state="collapsed"]')).toBeAttached();

    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await expect(page.locator('[data-slot="sidebar"][data-state="expanded"]')).toBeAttached();
  } finally {
    await context.close();
  }
});

async function countAttachments(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('panelot_v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('attachments')) {
            db.close();
            resolve(0);
            return;
          }
          const transaction = db.transaction('attachments', 'readonly');
          const count = transaction.objectStore('attachments').count();
          count.onerror = () => reject(count.error);
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
        };
      }),
  );
}
