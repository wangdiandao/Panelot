import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Real-browser validation of the snapshot engine + content-script actions
 * (docs/05). We inject the compiled engine functions into a real page and
 * assert the perception/interaction contract against a live DOM — the layer
 * happy-dom can only approximate.
 */

const fixtureUrl = 'file://' + fileURLToPath(new URL('./fixtures/form.html', import.meta.url));

// Bundle the snapshot engine source for injection (it's self-contained, no imports).
const engineSrc = readFileSync(path.join(process.cwd(), 'src/tools/snapshot/engine.ts'), 'utf-8')
  // Strip TS types for eval injection — a light transform sufficient for the
  // pure functions we exercise. (The unit tests cover the typed API.)
  .replace(/^import .*$/gm, '')
  .replace(/export /g, '');

test.describe('snapshot engine in a real browser', () => {
  test('builds a snapshot with refs for a real form', async ({ page }) => {
    await page.goto(fixtureUrl);
    // Sanity: the fixture rendered.
    await expect(page.locator('#contact')).toBeVisible();

    const result = await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      eval(src);
      // @ts-expect-error injected into page scope
      const snap = buildSnapshot(window, { snapshotId: 1, maxTokens: 3000 });
      return { yaml: snap.yaml, refCount: snap.refMap.size };
    }, engineSrc);

    expect(result.yaml).toContain('# Page Snapshot (s1)');
    expect(result.yaml).toContain('textbox "姓名"');
    expect(result.yaml).toContain('button "提交"');
    expect(result.yaml).toContain('[ref=s1_');
    // name, email, topic, checkbox, button → at least 5 interactive refs.
    expect(result.refCount).toBeGreaterThanOrEqual(5);
  });

  test('reflects filled values in the incremental snapshot', async ({ page }) => {
    await page.goto(fixtureUrl);
    await page.fill('#name', '张三');
    const yaml = await page.evaluate((src) => {
      // eslint-disable-next-line no-eval
      eval(src);
      // @ts-expect-error injected
      return buildSnapshot(window, { snapshotId: 2, maxTokens: 3000 }).yaml;
    }, engineSrc);
    expect(yaml).toContain('[value="张三"]');
  });
});
