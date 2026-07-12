import { expect, test } from '@playwright/test';
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
  expect(button?.backendDOMNodeId).toBeTruthy();
  const { model } = await session.send('DOM.getBoxModel', {
    backendNodeId: button!.backendDOMNodeId,
  });
  const quad = model.content;
  const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
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
  try {
    await page.goto(`http://localhost:${hostPort}/`);
    await expect.poll(() => page.frames().length).toBe(2);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
    const session = await page.context().newCDPSession(frame);
    await session.send('Accessibility.enable');
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    const input = nodes.find(
      (node) => node.role?.value === 'textbox' && node.name?.value === 'Frame email',
    );
    expect(input?.backendDOMNodeId).toBeTruthy();
  } finally {
    await close(hostServer);
    await close(frameServer);
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
  });
}
