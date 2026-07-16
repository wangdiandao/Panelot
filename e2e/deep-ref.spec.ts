import { chromium, expect, test, type CDPSession } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';

const fixtureUrl = 'file://' + fileURLToPath(new URL('./fixtures/deep.html', import.meta.url));

test('CDP AXTree exposes a backend node inside a closed shadow root', async ({ page }) => {
  await page.goto(fixtureUrl);
  const session = await page.context().newCDPSession(page);
  await session.send('DOM.enable');
  await session.send('Accessibility.enable');
  const { nodes } = await session.send('Accessibility.getFullAXTree');
  const button = nodes.find(
    (node) => node.role?.value === 'button' && node.name?.value === 'Closed action',
  );
  const backendNodeId = button?.backendDOMNodeId;
  expect(backendNodeId).toBeTruthy();
  if (!backendNodeId) throw new Error('Closed-shadow button has no backend DOM node');
  const { model } = await session.send('DOM.getBoxModel', {
    backendNodeId,
  });
  const quad = model.content;
  if (quad.length < 8) throw new Error('Closed-shadow button has an incomplete content quad');
  const [
    leftTopX = 0,
    leftTopY = 0,
    rightTopX = 0,
    rightTopY = 0,
    rightBottomX = 0,
    rightBottomY = 0,
    leftBottomX = 0,
    leftBottomY = 0,
  ] = quad;
  const x = (leftTopX + rightTopX + rightBottomX + leftBottomX) / 4;
  const y = (leftTopY + rightTopY + rightBottomY + leftBottomY) / 4;
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await expect(page.locator('body')).toHaveAttribute('data-clicked', 'yes');
});

test('CDP AXTree exposes controls in a cross-origin iframe', async ({ page }) => {
  const frameServer = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<label>Email <input aria-label="Frame email"></label>');
  });
  const framePort = await listen(frameServer);
  const hostServer = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<iframe src="http://127.0.0.1:${framePort}/"></iframe>`);
  });
  const hostPort = await listen(hostServer);
  let session: CDPSession | undefined;
  try {
    await page.goto(`http://localhost:${hostPort}/`);
    await expect.poll(() => page.frames().length).toBe(2);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    if (!frame) throw new Error('Cross-origin child frame was not attached');
    session = await page.context().newCDPSession(frame);
    await session.send('Accessibility.enable');
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    const input = nodes.find(
      (node) => node.role?.value === 'textbox' && node.name?.value === 'Frame email',
    );
    expect(input?.backendDOMNodeId).toBeTruthy();
  } finally {
    await session?.detach().catch(() => {});
    await page.close();
    await Promise.all([close(hostServer), close(frameServer)]);
  }
});

test('Chromium exposes nested cross-site frames as independent OOPIF targets', async () => {
  let port = 0;
  const server = createServer((request, response) => {
    const host = (request.headers.host ?? '').split(':')[0];
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (host === 'a.test') {
      response.end(
        `<!doctype html><h1>Root</h1><iframe src="http://b.test:${port}/child"></iframe>`,
      );
      return;
    }
    if (host === 'b.test') {
      response.end(
        `<!doctype html><button>Child control</button><iframe src="http://c.test:${port}/grandchild"></iframe>`,
      );
      return;
    }
    if (host === 'c.test') {
      response.end(
        '<!doctype html><label>Grandchild <input aria-label="Grandchild control"></label>',
      );
      return;
    }
    response.statusCode = 404;
    response.end('not found');
  });
  port = await listen(server);
  let isolatedBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    isolatedBrowser = await chromium.launch({
      channel: 'chromium',
      headless: true,
      args: [
        '--site-per-process',
        '--no-proxy-server',
        '--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1,MAP c.test 127.0.0.1',
      ],
    });
    const browserSession = await isolatedBrowser.newBrowserCDPSession();
    await browserSession.send('Target.setDiscoverTargets', { discover: true });
    const context = await isolatedBrowser.newContext();
    const page = await context.newPage();
    await page.goto(`http://a.test:${port}/`, { waitUntil: 'load' });

    await expect
      .poll(() =>
        page
          .frames()
          .map((frame) => new URL(frame.url()).hostname)
          .sort(),
      )
      .toEqual(['a.test', 'b.test', 'c.test']);
    await expect
      .poll(async () => {
        const { targetInfos } = await browserSession.send('Target.getTargets');
        const iframeUrls = targetInfos
          .filter((target) => target.type === 'iframe')
          .map((target) => target.url);
        return {
          child: iframeUrls.some((url) => new URL(url).hostname === 'b.test'),
          grandchild: iframeUrls.some((url) => new URL(url).hostname === 'c.test'),
        };
      })
      .toEqual({ child: true, grandchild: true });

    const { targetInfos } = await browserSession.send('Target.getTargets');
    const childTarget = targetInfos.find(
      (target) => target.type === 'iframe' && new URL(target.url).hostname === 'b.test',
    );
    const grandchildTarget = targetInfos.find(
      (target) => target.type === 'iframe' && new URL(target.url).hostname === 'c.test',
    );
    expect(childTarget?.targetId).toBeTruthy();
    expect(grandchildTarget?.targetId).toBeTruthy();
    expect(childTarget?.targetId).not.toBe(grandchildTarget?.targetId);
  } finally {
    await isolatedBrowser?.close();
    await close(server);
  }
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('server has no TCP port'));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
