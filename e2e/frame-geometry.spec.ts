import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import path from 'node:path';

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message);
  return value;
}

const executorBundle = buildSync({
  entryPoints: [path.resolve('src/tools/content/executor.ts')],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  globalName: '__panelotExecutor',
});
const executorSource = required(executorBundle.outputFiles[0], 'Executor bundle is missing').text;

test('frame-aware bounds drive trusted click, element clip, and annotations', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  await page.setContent(`
    <style>html,body{margin:0;min-height:1600px}</style>
    <iframe id="outer" title="outer" style="position:absolute;left:100px;top:500px;width:240px;height:140px;border:8px solid #000;transform:scale(1.25);transform-origin:0 0"></iframe>
  `);
  await installRandomUuid(page);
  const outerElement = page.locator('#outer');
  const outerHandle = required(
    await outerElement.elementHandle(),
    'Outer iframe handle is missing',
  );
  const outer = required(await outerHandle.contentFrame(), 'Outer iframe content frame is missing');
  await outer.setContent(`
    <style>html,body{margin:0}</style>
    <iframe id="inner" title="inner" style="position:absolute;left:30px;top:40px;width:140px;height:80px;border:6px solid #000;transform:scale(.8);transform-origin:0 0"></iframe>
  `);
  const innerHandle = required(
    await outer.locator('#inner').elementHandle(),
    'Inner iframe handle is missing',
  );
  const inner = required(await innerHandle.contentFrame(), 'Inner iframe content frame is missing');
  await inner.setContent(`
    <style>html,body{margin:0}</style>
    <button id="target" style="position:absolute;left:20px;top:15px;width:50px;height:24px" onclick="top.document.body.dataset.clicked='yes'">nested target</button>
  `);
  await page.evaluate(() => window.scrollTo(0, 300));
  await page.addScriptTag({ content: executorSource });

  const result = await page.evaluate(async () => {
    const executor = (
      window as unknown as {
        __panelotExecutor: {
          executeContentTool(
            tool: string,
            params: unknown,
          ): Promise<{
            resultText: string;
            rect?: { x: number; y: number; width: number; height: number };
          }>;
        };
      }
    ).__panelotExecutor;
    const snapshot = await executor.executeContentTool('read_page', {});
    const ref = snapshot.resultText.match(/\[ref=(s[a-z0-9]+_\d+_\d+)\]/i)?.[1];
    if (!ref) throw new Error(`ref missing from ${snapshot.resultText}`);
    const viewport = await executor.executeContentTool('get_rect', {
      ref,
      coordinateSpace: 'viewport',
    });
    const documentRect = await executor.executeContentTool('get_rect', {
      ref,
      coordinateSpace: 'document',
    });
    await executor.executeContentTool('annotate_refs', {});
    const overlay = document.querySelector('panelot-overlay');
    const badgeElement = overlay?.shadowRoot?.querySelector<HTMLElement>('#ref-annotations > div');
    if (!badgeElement || !viewport.rect || !documentRect.rect) {
      throw new Error('Frame geometry result or annotation badge is missing');
    }
    const badge = badgeElement.getBoundingClientRect();
    return {
      ref,
      viewport: viewport.rect,
      documentRect: documentRect.rect,
      badge: { x: badge.x, y: badge.y },
    };
  });
  const expected = await inner.locator('#target').boundingBox();
  expect(expected).not.toBeNull();
  if (!expected) throw new Error('Nested target has no bounding box');
  expect(result.viewport.x).toBeCloseTo(expected.x, 3);
  expect(result.viewport.y).toBeCloseTo(expected.y, 3);
  expect(result.viewport.width).toBeCloseTo(expected.width, 3);
  expect(result.viewport.height).toBeCloseTo(expected.height, 3);
  expect(result.documentRect.x).toBeCloseTo(result.viewport.x, 3);
  expect(result.documentRect.y).toBeCloseTo(result.viewport.y + 300, 3);
  expect(result.badge.x).toBeCloseTo(result.viewport.x, 3);
  expect(result.badge.y).toBeCloseTo(result.viewport.y, 3);

  const session = await page.context().newCDPSession(page);
  const click = {
    x: result.viewport.x + result.viewport.width / 2,
    y: result.viewport.y + result.viewport.height / 2,
    button: 'left' as const,
    clickCount: 1,
  };
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...click });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click });
  await expect(page.locator('body')).toHaveAttribute('data-clicked', 'yes');

  const image = await page.screenshot({
    clip: { ...result.documentRect },
  });
  expect(image.readUInt32BE(16)).toBe(Math.round(result.documentRect.width));
  expect(image.readUInt32BE(20)).toBe(Math.round(result.documentRect.height));
});

test('frame geometry fails closed for rotation', async ({ page }) => {
  await page.setContent(
    '<iframe id="frame" title="frame" style="width:200px;height:100px;transform:rotate(5deg)"></iframe>',
  );
  await installRandomUuid(page);
  const frameHandle = required(
    await page.locator('#frame').elementHandle(),
    'Rotated iframe handle is missing',
  );
  const frame = required(
    await frameHandle.contentFrame(),
    'Rotated iframe content frame is missing',
  );
  await frame.setContent('<button>rotated target</button>');
  await page.addScriptTag({ content: executorSource });

  const failure = await page.evaluate(async () => {
    const execute = (
      window as unknown as {
        __panelotExecutor: {
          executeContentTool(tool: string, params: unknown): Promise<{ resultText: string }>;
        };
      }
    ).__panelotExecutor.executeContentTool;
    const snapshot = await execute('read_page', {});
    const ref = snapshot.resultText.match(/\[ref=(s[a-z0-9]+_\d+_\d+)\]/i)?.[1];
    try {
      await execute('get_rect', { ref, coordinateSpace: 'viewport' });
      return null;
    } catch (error) {
      return (error as { failure?: { code?: string; details?: { reason?: string } } }).failure;
    }
  });

  expect(failure).toMatchObject({
    code: 'unsupported_frame',
    details: { reason: 'non_axis_aligned_transform' },
  });
});

async function installRandomUuid(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    if (typeof crypto.randomUUID === 'function') return;
    let sequence = 0;
    Object.defineProperty(crypto, 'randomUUID', {
      value: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    });
  });
}
