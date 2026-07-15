import { chromium, expect, test, type Page } from '@playwright/test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ENGINE_PROTOCOL, ENGINE_SCHEMA_HASH } from '../src/messaging/protocol';

const productionExtensionPath = path.resolve('dist/chrome-mv3');
const packageJson = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')) as {
  version: string;
};

interface FixtureRequest {
  messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }>;
  tools?: unknown[];
}

interface RuntimeSnapshot {
  threads: Array<{ id: string; leafId: string | null }>;
  nodes: Array<{
    threadId: string;
    type: string;
    payload: Record<string, unknown>;
  }>;
  runs: Array<{
    id: string;
    threadId: string;
    state: string;
    pendingTool?: { toolName?: string };
    environment?: { snapshotVersion?: number; providerBinding?: { baseUrl?: string } };
  }>;
  approvals: Array<{ id: string; threadId: string; status: string }>;
}

interface EngineProbeResult {
  permission: boolean;
  health: string;
  outcome: 'initialized' | 'timeout' | `fatal: ${string}` | `disconnected: ${string}`;
  storageGeneration: unknown;
  databases: string[];
}

class LocalAgentFixture {
  readonly requests: FixtureRequest[] = [];
  private server: Server;
  private targetTabId?: number;

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');
    return `http://127.0.0.1:${address.port}`;
  }

  setTargetTabId(tabId: number): void {
    this.targetTabId = tabId;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }

    if (request.method === 'GET' && request.url === '/target') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Panelot Local Agent Fixture</title></head>
  <body>
    <main>
      <h1>Local agent target</h1>
      <button id="complete" type="button">Complete local task</button>
      <output id="status" aria-live="polite">pending</output>
    </main>
    <script>
      document.querySelector('#complete').addEventListener('click', () => {
        document.querySelector('#status').textContent = 'completed by Panelot';
      });
    </script>
  </body>
</html>`);
      return;
    }

    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    const body = JSON.parse(await readBody(request)) as FixtureRequest;
    this.requests.push(body);
    if (!Array.isArray(body.tools)) {
      writeSse(response, [textFrame('Local browser flow'), terminalFrame('stop')]);
      return;
    }
    if (this.targetTabId === undefined) {
      response.writeHead(500).end('target tab id is not configured');
      return;
    }

    const lastToolResult = [...(body.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'tool');
    if (!lastToolResult) {
      writeSse(response, [
        toolFrame('read-page-1', 'read_page', { tabId: this.targetTabId, maxTokens: 1200 }),
        terminalFrame('tool_calls'),
      ]);
      return;
    }

    if (lastToolResult.tool_call_id === 'read-page-1') {
      const snapshot = String(lastToolResult.content ?? '');
      const ref = snapshot.match(/Complete local task[^\n]*\[ref=([^\]]+)\]/)?.[1];
      if (!ref) {
        response.writeHead(422).end('read_page result did not contain the target ref');
        return;
      }
      writeSse(response, [
        toolFrame('click-1', 'click', {
          tabId: this.targetTabId,
          element: 'Complete local task button',
          ref,
        }),
        terminalFrame('tool_calls'),
      ]);
      return;
    }

    if (lastToolResult.tool_call_id === 'click-1') {
      writeSse(response, [textFrame('The local task is complete.'), terminalFrame('stop')]);
      return;
    }

    response.writeHead(422).end(`unexpected tool result ${lastToolResult.tool_call_id ?? ''}`);
  }
}

class NestedOopifAgentFixture {
  readonly requests: FixtureRequest[] = [];
  private server: Server;
  private port?: number;
  private targetTabId?: number;

  constructor() {
    this.server = createServer((request, response) => void this.handle(request, response));
  }

  async start(): Promise<{ providerOrigin: string; targetUrl: string }> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server has no TCP port');
    this.port = address.port;
    return {
      providerOrigin: `http://127.0.0.1:${address.port}`,
      targetUrl: `http://a.test:${address.port}/target`,
    };
  }

  setTargetTabId(tabId: number): void {
    this.targetTabId = tabId;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = (request.headers.host ?? '').split(':')[0];
    if (request.method === 'GET' && request.url === '/health' && host === '127.0.0.1') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }
    if (request.method === 'GET' && request.url === '/target' && host === 'a.test') {
      this.writeHtml(
        response,
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Panelot Nested OOPIF Fixture</title></head><body><h1>Root frame</h1><iframe title="Child frame" src="http://b.test:${this.port}/child"></iframe></body></html>`,
      );
      return;
    }
    if (request.method === 'GET' && request.url === '/child' && host === 'b.test') {
      this.writeHtml(
        response,
        `<!doctype html><html lang="en"><body><h2>Child frame</h2><iframe title="Grandchild frame" src="http://c.test:${this.port}/grandchild"></iframe></body></html>`,
      );
      return;
    }
    if (request.method === 'GET' && request.url === '/grandchild' && host === 'c.test') {
      this.writeHtml(
        response,
        `<!doctype html><html lang="en"><body>
          <label>Nested value <input aria-label="Nested value"></label>
          <button type="button" aria-label="Apply nested value">Apply nested value</button>
          <output aria-label="Nested result">pending</output>
          <script>
            const input = document.querySelector('input');
            const output = document.querySelector('output');
            document.querySelector('button').addEventListener('click', (event) => {
              output.textContent = input.value;
              output.dataset.trustedClick = String(event.isTrusted);
            });
            input.addEventListener('input', (event) => {
              input.dataset.trustedInput = String(event.isTrusted);
            });
          </script>
        </body></html>`,
      );
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }

    const body = JSON.parse(await readBody(request)) as FixtureRequest;
    this.requests.push(body);
    if (!Array.isArray(body.tools)) {
      writeSse(response, [textFrame('Nested OOPIF flow'), terminalFrame('stop')]);
      return;
    }
    if (this.targetTabId === undefined) {
      response.writeHead(500).end('target tab id is not configured');
      return;
    }

    const lastToolResult = [...(body.messages ?? [])]
      .reverse()
      .find((message) => message.role === 'tool');
    if (!lastToolResult) {
      writeSse(response, [
        toolFrame('deep-read-1', 'read_page_deep', { tabId: this.targetTabId }),
        terminalFrame('tool_calls'),
      ]);
      return;
    }

    const snapshot = String(lastToolResult.content ?? '');
    if (lastToolResult.tool_call_id === 'deep-read-1') {
      const ref = deepRefFor(snapshot, 'textbox', 'Nested value');
      writeSse(response, [
        toolFrame('trusted-type-1', 'type_trusted', {
          tabId: this.targetTabId,
          element: 'Nested value input',
          ref,
          text: 'typed through Panelot',
        }),
        terminalFrame('tool_calls'),
      ]);
      return;
    }
    if (lastToolResult.tool_call_id === 'trusted-type-1') {
      const ref = deepRefFor(snapshot, 'button', 'Apply nested value');
      writeSse(response, [
        toolFrame('trusted-click-1', 'click_trusted', {
          tabId: this.targetTabId,
          element: 'Apply nested value button',
          ref,
        }),
        terminalFrame('tool_calls'),
      ]);
      return;
    }
    if (lastToolResult.tool_call_id === 'trusted-click-1') {
      writeSse(response, [textFrame('The nested OOPIF task is complete.'), terminalFrame('stop')]);
      return;
    }
    response.writeHead(422).end(`unexpected tool result ${lastToolResult.tool_call_id ?? ''}`);
  }

  private writeHtml(response: ServerResponse, body: string): void {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  }
}

test('recovers an approved browser action through a production module service worker restart', async () => {
  test.setTimeout(90_000);
  const fixture = new LocalAgentFixture();
  const origin = await fixture.start();
  const testInfo = test.info();
  const extensionPath = testInfo.outputPath('extension');
  const diagnostics: string[] = [];
  prepareLoopbackExtension(extensionPath);
  const context = await chromium.launchPersistentContext(testInfo.outputPath('agent-profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    worker.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        diagnostics.push(`background ${message.type()}: ${message.text()}`);
      }
    });
    worker.on('close', () => diagnostics.push('background worker closed'));
    const extensionId = new URL(worker.url()).host;
    const probePage = await context.newPage();
    await probePage.goto(`chrome-extension://${extensionId}/options.html`);
    const probe = await engineProbe(probePage, origin);
    await testInfo.attach('engine-ready-probe', {
      body: JSON.stringify(probe, null, 2),
      contentType: 'application/json',
    });
    expect(probe.permission, JSON.stringify(probe)).toBe(true);
    expect(probe.health, JSON.stringify(probe)).toBe('ok');
    expect(probe.outcome, JSON.stringify(probe)).toBe('initialized');
    await probePage.close();

    const targetPage = await context.newPage();
    await targetPage.goto(`${origin}/target`);
    await expect(targetPage.getByRole('button', { name: 'Complete local task' })).toBeVisible();

    const targetTabId = await worker.evaluate(async (targetUrl) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === targetUrl)?.id;
    }, targetPage.url());
    if (targetTabId === undefined) throw new Error('Could not resolve fixture tab id');
    fixture.setTargetTabId(targetTabId);

    await worker.evaluate(
      async ({ baseUrl, version }) => {
        await chrome.storage.local.set({
          connections: [
            {
              id: 'local-agent-e2e',
              name: 'Local Agent E2E',
              kind: 'openai',
              baseUrl: `${baseUrl}/v1`,
              apiKeys: ['local-e2e-key'],
              modelIds: ['fixture-model'],
              enabled: true,
            },
          ],
          global_settings: {
            language: 'en',
            defaultModel: { connectionId: 'local-agent-e2e', modelId: 'fixture-model' },
            defaultApprovalPolicy: 'untrusted',
            defaultCapabilityScope: 'full',
          },
          panelot_e2e_build_version: version,
        });
      },
      { baseUrl: origin, version: packageJson.version },
    );

    const chatPage = await context.newPage();
    chatPage.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        diagnostics.push(`chat ${message.type()}: ${message.text()}`);
      }
    });
    chatPage.on('pageerror', (error) => diagnostics.push(`chat pageerror: ${error.message}`));
    await chatPage.goto(`chrome-extension://${extensionId}/chat.html`);
    await attachTargetTab(chatPage);

    await chatPage.locator('textarea').fill('Complete the task on the attached local page.');
    await chatPage.locator('textarea').press('Enter');

    await expect
      .poll(() => fixture.requests.length, {
        message: 'the production engine must reach the local Provider',
        timeout: 15_000,
      })
      .toBeGreaterThan(0);

    const approval = chatPage.locator('[data-approval-focus-target="true"]');
    await expect(approval).toBeVisible({ timeout: 15_000 });
    await expect(approval).toContainText('Complete local task button');
    await expect(approval).toContainText(origin);

    const waiting = await readRuntimeSnapshot(chatPage);
    const waitingRun = waiting.runs.find((run) => run.state === 'waiting_approval');
    expect(waitingRun).toMatchObject({
      pendingTool: { toolName: 'click' },
      environment: {
        snapshotVersion: 1,
        providerBinding: { baseUrl: `${origin}/v1` },
      },
    });
    expect(waiting.approvals).toContainEqual(
      expect.objectContaining({ threadId: waitingRun?.threadId, status: 'pending' }),
    );
    const threadId = waitingRun?.threadId;
    if (!threadId) throw new Error('Waiting run has no thread id');
    const streamEpochBeforeRestart = await worker.evaluate(async () => {
      const stored = await chrome.storage.session.get('panelot_engine_stream_epoch');
      return stored.panelot_engine_stream_epoch as number;
    });

    await chatPage.close();
    const internalsPage = await context.newPage();
    await internalsPage.goto('chrome://serviceworker-internals/');
    const stopWorker = internalsPage.locator('cr-button[data-command="stop"]');
    await expect(stopWorker).toHaveCount(1);
    await stopWorker.click();
    await expect(internalsPage.locator('body')).toContainText('Running Status: STOPPED');
    await internalsPage.close();

    const recoveredPage = await context.newPage();
    await recoveredPage.goto(
      `chrome-extension://${extensionId}/chat.html?thread=${encodeURIComponent(threadId)}`,
    );
    await expect
      .poll(() =>
        recoveredPage.evaluate(async () => {
          const stored = await chrome.storage.session.get('panelot_engine_stream_epoch');
          return stored.panelot_engine_stream_epoch as number;
        }),
      )
      .toBe(streamEpochBeforeRestart + 1);

    const recoveredApproval = recoveredPage.locator('[data-approval-focus-target="true"]');
    await expect(recoveredApproval).toBeVisible();
    await expect(recoveredApproval).toContainText('Complete local task button');
    await recoveredApproval.getByRole('button', { name: /Allow once/ }).click();

    await expect(targetPage.locator('#status')).toHaveText('completed by Panelot');
    await expect(
      recoveredPage.getByText('The local task is complete.', { exact: true }),
    ).toBeVisible();

    await expect
      .poll(async () => {
        const snapshot = await readRuntimeSnapshot(recoveredPage);
        return snapshot.runs.find((run) => run.id === waitingRun?.id)?.state;
      })
      .toBe('completed');

    const completed = await readRuntimeSnapshot(recoveredPage);
    const threadNodes = completed.nodes.filter((node) => node.threadId === threadId);
    expect(threadNodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_call',
          payload: expect.objectContaining({ toolName: 'read_page' }),
        }),
        expect.objectContaining({
          type: 'tool_call',
          payload: expect.objectContaining({ toolName: 'click' }),
        }),
        expect.objectContaining({
          type: 'tool_result',
          payload: expect.objectContaining({ itemId: 'click-1', ok: true }),
        }),
        expect.objectContaining({
          type: 'assistant_message',
          payload: expect.objectContaining({ providerStopReason: 'end' }),
        }),
      ]),
    );
    expect(completed.approvals).toContainEqual(
      expect.objectContaining({ threadId, status: 'decided' }),
    );
    expect(
      fixture.requests.filter((request) => Array.isArray(request.tools)).map(lastToolCallId),
    ).toEqual([undefined, 'read-page-1', 'click-1']);
  } finally {
    await testInfo.attach('agent-recovery-diagnostics', {
      body: diagnostics.join('\n') || 'no captured warnings or errors',
      contentType: 'text/plain',
    });
    await testInfo.attach('agent-fixture-requests', {
      body: JSON.stringify(fixture.requests, null, 2),
      contentType: 'application/json',
    });
    await context.close();
    await fixture.close();
  }
});

test('production Agent reads and operates a nested cross-site OOPIF through deep refs', async () => {
  test.setTimeout(90_000);
  const fixture = new NestedOopifAgentFixture();
  const { providerOrigin, targetUrl } = await fixture.start();
  const testInfo = test.info();
  const extensionPath = testInfo.outputPath('nested-oopif-extension');
  const diagnostics: string[] = [];
  prepareLoopbackExtension(extensionPath, [
    'http://a.test/*',
    'http://b.test/*',
    'http://c.test/*',
  ]);
  const context = await chromium.launchPersistentContext(
    testInfo.outputPath('nested-oopif-profile'),
    {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--site-per-process',
        '--no-proxy-server',
        '--host-resolver-rules=MAP a.test 127.0.0.1,MAP b.test 127.0.0.1,MAP c.test 127.0.0.1',
      ],
    },
  );

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    worker.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        diagnostics.push(`background ${message.type()}: ${message.text()}`);
      }
    });
    const extensionId = new URL(worker.url()).host;
    const probePage = await context.newPage();
    await probePage.goto(`chrome-extension://${extensionId}/options.html`);
    const probe = await engineProbe(probePage, providerOrigin);
    expect(probe.permission, JSON.stringify(probe)).toBe(true);
    expect(probe.health, JSON.stringify(probe)).toBe('ok');
    expect(probe.outcome, JSON.stringify(probe)).toBe('initialized');
    await probePage.close();

    const targetPage = await context.newPage();
    await targetPage.goto(targetUrl, { waitUntil: 'load' });
    await expect
      .poll(() =>
        targetPage
          .frames()
          .map((frame) => new URL(frame.url()).hostname)
          .sort(),
      )
      .toEqual(['a.test', 'b.test', 'c.test']);
    const grandchild = targetPage
      .frames()
      .find((frame) => new URL(frame.url()).hostname === 'c.test');
    if (!grandchild) throw new Error('Grandchild OOPIF did not load');
    await expect(grandchild.getByRole('textbox', { name: 'Nested value' })).toBeVisible();

    const targetTabId = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === url)?.id;
    }, targetPage.url());
    if (targetTabId === undefined) throw new Error('Could not resolve nested fixture tab id');
    fixture.setTargetTabId(targetTabId);

    await worker.evaluate(
      async ({ baseUrl, version }) => {
        await chrome.storage.local.set({
          connections: [
            {
              id: 'nested-oopif-e2e',
              name: 'Nested OOPIF E2E',
              kind: 'openai',
              baseUrl: `${baseUrl}/v1`,
              apiKeys: ['local-e2e-key'],
              modelIds: ['fixture-model'],
              enabled: true,
            },
          ],
          global_settings: {
            language: 'en',
            defaultModel: { connectionId: 'nested-oopif-e2e', modelId: 'fixture-model' },
            defaultApprovalPolicy: 'always',
            defaultCapabilityScope: 'full',
          },
          panelot_e2e_build_version: version,
        });
      },
      { baseUrl: providerOrigin, version: packageJson.version },
    );

    const chatPage = await context.newPage();
    chatPage.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') {
        diagnostics.push(`chat ${message.type()}: ${message.text()}`);
      }
    });
    await chatPage.goto(`chrome-extension://${extensionId}/chat.html`);
    await attachTargetTab(chatPage, 'Panelot Nested OOPIF Fixture');
    await chatPage.locator('textarea').fill('Type and apply the value inside the nested frame.');
    await chatPage.locator('textarea').press('Enter');

    for (const toolName of ['read_page_deep', 'type_trusted', 'click_trusted']) {
      const approval = chatPage.locator('[data-approval-focus-target="true"]');
      await expect(approval).toBeVisible({ timeout: 20_000 });
      await expect
        .poll(async () => {
          const snapshot = await readRuntimeSnapshot(chatPage);
          return snapshot.runs.find((run) => run.state === 'waiting_approval')?.pendingTool
            ?.toolName;
        })
        .toBe(toolName);
      await approval.getByRole('button', { name: /Allow once/ }).click();
    }

    await expect(grandchild.getByRole('textbox', { name: 'Nested value' })).toHaveValue(
      'typed through Panelot',
    );
    await expect(grandchild.getByRole('textbox', { name: 'Nested value' })).toHaveAttribute(
      'data-trusted-input',
      'true',
    );
    await expect(grandchild.getByRole('status', { name: 'Nested result' })).toHaveText(
      'typed through Panelot',
    );
    await expect(grandchild.getByRole('status', { name: 'Nested result' })).toHaveAttribute(
      'data-trusted-click',
      'true',
    );
    await expect(
      chatPage.getByText('The nested OOPIF task is complete.', { exact: true }),
    ).toBeVisible();
    expect(
      fixture.requests.filter((request) => Array.isArray(request.tools)).map(lastToolCallId),
    ).toEqual([undefined, 'deep-read-1', 'trusted-type-1', 'trusted-click-1']);
    const completed = await readRuntimeSnapshot(chatPage);
    expect(
      completed.nodes
        .filter((node) => node.type === 'tool_call')
        .map((node) => node.payload.toolName),
    ).toEqual(expect.arrayContaining(['read_page_deep', 'type_trusted', 'click_trusted']));
  } finally {
    await testInfo.attach('nested-oopif-diagnostics', {
      body: diagnostics.join('\n') || 'no captured warnings or errors',
      contentType: 'text/plain',
    });
    await testInfo.attach('nested-oopif-fixture-requests', {
      body: JSON.stringify(fixture.requests, null, 2),
      contentType: 'application/json',
    });
    await context.close();
    await fixture.close();
  }
});

async function engineProbe(page: Page, origin: string): Promise<EngineProbeResult> {
  return page.evaluate(
    async ({ baseUrl, protocol, schemaHash }) => {
      const permission = await chrome.permissions.contains({ origins: ['http://127.0.0.1/*'] });
      let health = 'fetch failed';
      try {
        health = await (await fetch(`${baseUrl}/health`)).text();
      } catch (error) {
        health = error instanceof Error ? error.message : String(error);
      }
      const outcome = await new Promise<EngineProbeResult['outcome']>((resolve) => {
        const port = chrome.runtime.connect({ name: 'panelot-engine' });
        const keepalive = setInterval(() => {
          port.postMessage({ type: 'ping', submissionId: crypto.randomUUID() });
        }, 10_000);
        const finish = (result: EngineProbeResult['outcome']) => {
          clearInterval(keepalive);
          clearTimeout(timeout);
          resolve(result);
        };
        const timeout = setTimeout(() => {
          port.disconnect();
          finish('timeout');
        }, 25_000);
        port.onMessage.addListener((event: { type?: unknown; message?: unknown }) => {
          if (event.type === 'initialized') {
            port.disconnect();
            finish('initialized');
          } else if (event.type === 'fatal.reload_required') {
            finish(`fatal: ${String(event.message ?? 'no message')}`);
          }
        });
        port.onDisconnect.addListener(() => {
          finish(`disconnected: ${chrome.runtime.lastError?.message ?? 'no runtime error'}`);
        });
        port.postMessage({
          type: 'initialize',
          submissionId: crypto.randomUUID(),
          protocol,
          schemaHash,
          clientId: crypto.randomUUID(),
        });
      });

      const storageGeneration = (await chrome.storage.local.get('panelot_storage_generation'))
        .panelot_storage_generation;
      const databases = (await indexedDB.databases())
        .map((database) => database.name)
        .filter((name): name is string => typeof name === 'string');
      return { permission, health, outcome, storageGeneration, databases };
    },
    { baseUrl: origin, protocol: ENGINE_PROTOCOL, schemaHash: ENGINE_SCHEMA_HASH },
  );
}

function prepareLoopbackExtension(extensionPath: string, targetOrigins: string[] = []): void {
  cpSync(productionExtensionPath, extensionPath, { recursive: true });
  const manifestPath = path.join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    host_permissions?: string[];
  };
  manifest.host_permissions = ['http://127.0.0.1/*', ...targetOrigins];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function attachTargetTab(page: Page, title = 'Panelot Local Agent Fixture'): Promise<void> {
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const attachPage = page.getByRole('menuitem', { name: 'Attach page', exact: true });
  await attachPage.hover();
  await page.getByRole('menuitem', { name: new RegExp(title) }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

function deepRefFor(snapshot: string, role: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = snapshot.match(
    new RegExp(`- ${role} "${escapedName}"[^\\n]*\\[ref=(c[a-z0-9_]+)\\]`, 'i'),
  );
  if (!match?.[1]) throw new Error(`deep ref for ${role} "${name}" missing from:\n${snapshot}`);
  return match[1];
}

async function readRuntimeSnapshot(page: Page): Promise<RuntimeSnapshot> {
  return page.evaluate(
    () =>
      new Promise<RuntimeSnapshot>((resolve, reject) => {
        const request = indexedDB.open('panelot_v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction(
            ['threads', 'nodes', 'runs', 'approvals'],
            'readonly',
          );
          const readAll = <T>(store: string) =>
            new Promise<T[]>((resolveStore, rejectStore) => {
              const read = transaction.objectStore(store).getAll();
              read.onerror = () => rejectStore(read.error);
              read.onsuccess = () => resolveStore(read.result as T[]);
            });
          Promise.all([
            readAll<RuntimeSnapshot['threads'][number]>('threads'),
            readAll<RuntimeSnapshot['nodes'][number]>('nodes'),
            readAll<RuntimeSnapshot['runs'][number]>('runs'),
            readAll<RuntimeSnapshot['approvals'][number]>('approvals'),
          ])
            .then(([threads, nodes, runs, approvals]) => {
              database.close();
              resolve({ threads, nodes, runs, approvals });
            })
            .catch((error: unknown) => {
              database.close();
              reject(error);
            });
        };
      }),
  );
}

function lastToolCallId(request: FixtureRequest): string | undefined {
  return [...(request.messages ?? [])].reverse().find((message) => message.role === 'tool')
    ?.tool_call_id;
}

function toolFrame(id: string, name: string, args: Record<string, unknown>): string {
  return JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
      },
    ],
  });
}

function textFrame(text: string): string {
  return JSON.stringify({ choices: [{ delta: { content: text } }] });
}

function terminalFrame(finishReason: 'stop' | 'tool_calls'): string {
  return JSON.stringify({
    choices: [{ delta: {}, finish_reason: finishReason }],
    usage: { prompt_tokens: 8, completion_tokens: 4 },
  });
}

function writeSse(response: ServerResponse, frames: string[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const queue = [...frames, '[DONE]'];
  const writeNext = () => {
    const frame = queue.shift();
    if (frame === undefined) {
      response.end();
      return;
    }
    response.write(`data: ${frame}\n\n`);
    setImmediate(writeNext);
  };
  writeNext();
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
