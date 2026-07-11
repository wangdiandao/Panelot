import { expect, test, chromium } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve('dist/chrome-mv3');

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
    expect(manifest.version).toBe('0.2.0');
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.optional_host_permissions).toContain('<all_urls>');
    expect(manifest.permissions).toContain('offscreen');
  } finally {
    await context.close();
  }
});
