import { defineConfig } from '@playwright/test';

/**
 * e2e config (docs/12 §8): drives real Chromium against local fixture pages.
 * The snapshot engine and content-script actions run in a real DOM here —
 * coverage that happy-dom unit tests can't provide.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './output/playwright/test-results',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  // Persistent extension profiles each launch a full Chromium instance and service worker.
  // Bounding concurrency keeps startup/recovery timing meaningful instead of measuring host contention.
  workers: 4,
  timeout: 30_000,
  use: {
    headless: true,
  },
  reporter: [['list']],
  projects: [{ name: 'chromium', use: { browserName: 'chromium', channel: 'chromium' } }],
});
