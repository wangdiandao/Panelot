// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelotDB } from '../../src/db/schema';
import type { BrowserToolGateway } from '../../src/tools/gateway';
import type { CdpManager } from '../../src/tools/cdp/debugger';
import { executeContentTool } from '../../src/tools/content/executor';
import { createL2Tools } from '../../src/tools/l2Tools';

beforeEach(() => {
  document.body.innerHTML = '';
});

async function iframeRef(): Promise<{
  frame: HTMLIFrameElement;
  ref: string;
  replacement: Document;
}> {
  document.body.innerHTML = '<iframe title="frame"></iframe>';
  const frame = document.querySelector('iframe')!;
  frame.contentDocument!.body.innerHTML = '<input aria-label="same target">';
  const snapshot = (await executeContentTool('read_page', {})).resultText;
  const ref = snapshot.match(/\[ref=(s[a-z0-9]+_\d+_\d+)\]/i)?.[1];
  if (!ref) throw new Error(`missing iframe ref in:\n${snapshot}`);
  const replacement = document.implementation.createHTMLDocument('replacement');
  replacement.body.innerHTML = '<input aria-label="same target">';
  return { frame, ref, replacement };
}

function replaceFrameDocument(frame: HTMLIFrameElement, replacement: Document): void {
  Object.defineProperty(frame, 'contentDocument', {
    configurable: true,
    get: () => replacement,
  });
}

function setupTrustedTools() {
  const send = vi.fn(async () => ({}));
  const cdp = {
    send,
    withTab: vi.fn(async (_tabId: number, action: () => Promise<unknown>) => action()),
    withNetworkSettled: vi.fn(async (_tabId: number, action: () => Promise<void>) => {
      await action();
      return { settled: true };
    }),
  };
  const gateway = {
    getOperationTab: vi.fn(async () => 7),
    getElementRect: vi.fn(),
    callContentTool: vi.fn(),
    markAgentInput: vi.fn(),
    markDriven: vi.fn(),
    runWithNewTabCapture: vi.fn(
      async (_threadId: string, _tabId: number, action: () => Promise<unknown>) => ({
        value: await action(),
      }),
    ),
  };
  const tools = createL2Tools(
    cdp as unknown as CdpManager,
    gateway as unknown as BrowserToolGateway,
    {} as PanelotDB,
    () => 'thread-1',
  );
  return {
    cdp,
    gateway,
    send,
    tool: (name: string) => tools.find((candidate) => candidate.name === name)!,
  };
}

describe('trusted same-origin ref validation', () => {
  it('sends no mouse input when the iframe document changes after rect lookup', async () => {
    const { frame, ref, replacement } = await iframeRef();
    const { gateway, send, tool } = setupTrustedTools();
    gateway.getElementRect.mockImplementation(async () => {
      await executeContentTool('get_rect', { ref, coordinateSpace: 'viewport' });
      replaceFrameDocument(frame, replacement);
      return { x: 0, y: 0, width: 20, height: 10 };
    });
    gateway.callContentTool.mockImplementation(
      async (_threadId: string, contentTool: string, params: unknown) =>
        executeContentTool(contentTool, params),
    );

    await expect(
      tool('click_trusted').execute(
        'call-1',
        { element: 'same target', ref },
        new AbortController().signal,
        undefined,
      ),
    ).rejects.toMatchObject({ failure: { code: 'stale_ref' } });
    expect(send).not.toHaveBeenCalledWith(expect.stringMatching(/^Input\./), expect.anything());
    expect(gateway.markAgentInput).not.toHaveBeenCalled();
  });

  it('sends no keyboard input when the iframe document changes after focus', async () => {
    const { frame, ref, replacement } = await iframeRef();
    const { gateway, send, tool } = setupTrustedTools();
    gateway.callContentTool.mockImplementation(
      async (_threadId: string, contentTool: string, params: unknown) => {
        const result = await executeContentTool(contentTool, params);
        if (contentTool === 'focus') replaceFrameDocument(frame, replacement);
        return result;
      },
    );

    await expect(
      tool('type_trusted').execute(
        'call-2',
        { element: 'same target', ref, text: 'Ada' },
        new AbortController().signal,
        undefined,
      ),
    ).rejects.toMatchObject({ failure: { code: 'stale_ref' } });
    expect(send).not.toHaveBeenCalledWith(expect.stringMatching(/^Input\./), expect.anything());
    expect(gateway.markAgentInput).not.toHaveBeenCalled();
  });
});

describe('trusted new-tab results', () => {
  it('returns the created tab as a verified click_xy result', async () => {
    const { gateway, tool } = setupTrustedTools();
    gateway.runWithNewTabCapture.mockImplementation(
      async (_threadId: string, _tabId: number, action: () => Promise<unknown>) => {
        const value = await action();
        return {
          value,
          createdTabResult: {
            resultTabId: 9,
            resultText: '链接已在新标签页打开：https://example.test/next',
            snapshot: '# Next page',
            evidence: {
              attemptId: 'attempt-1',
              attempts: [],
              effectState: 'verified',
              observedEffects: ['tab_created'],
              outcome: 'verified',
            },
          },
        };
      },
    );

    const result = await tool('click_xy').execute(
      'call-3',
      { x: 10, y: 20 },
      new AbortController().signal,
      undefined,
    );

    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('[tabId=9] 链接已在新标签页打开'),
    });
    expect(result.details).toMatchObject({
      actionEvidence: { observedEffects: ['tab_created'], outcome: 'verified' },
    });
  });
});
