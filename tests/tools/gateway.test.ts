/**
 * BrowserToolGateway target-tab fallback: the extension's own pages
 * (chrome-extension://) must never be auto-attached as the operation target —
 * they are never a meaningful target for browser ops (the user means the web
 * page they were looking at, not the chat UI itself).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserToolGateway } from '../../src/tools/gateway';
import { CONTENT_SCRIPT_PROTOCOL, CONTENT_SCRIPT_SCHEMA_HASH } from '../../src/messaging/protocol';

type TabStub = {
  id: number;
  url: string;
  active: boolean;
  lastAccessed?: number;
  status?: string;
  title?: string;
  openerTabId?: number;
  windowId?: number;
};

let tabs: TabStub[] = [];
let sendMessage: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;
let updateTab: ReturnType<typeof vi.fn>;
let updateWindow: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tabs = [];
  sendMessage = vi.fn();
  executeScript = vi.fn(async () => {});
  updateTab = vi.fn(async (id: number, update: { active?: boolean }) => {
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) throw new Error('no tab');
    if (update.active) {
      for (const candidate of tabs) {
        if (candidate.windowId === tab.windowId) candidate.active = false;
      }
      tab.active = true;
    }
    return tab;
  });
  updateWindow = vi.fn(async () => ({}));
  const sendMessageWithEnvelope = async (tabId: number, op: { requestId: string }) => {
    const result = await (sendMessage as (...args: unknown[]) => unknown)(tabId, op);
    if (result === 'pong') {
      return {
        protocol: CONTENT_SCRIPT_PROTOCOL,
        schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
        requestId: op.requestId,
        ok: true,
        result,
      };
    }
    if (typeof result === 'object' && result !== null && 'ok' in result) {
      return {
        protocol: CONTENT_SCRIPT_PROTOCOL,
        schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
        requestId: op.requestId,
        ...result,
      };
    }
    return result;
  };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://panelot${path}` },
    tabs: {
      query: vi.fn(async (q: { active?: boolean }) =>
        tabs.filter((t) => (q.active === undefined ? true : t.active === q.active)),
      ),
      get: vi.fn(async (id: number) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('no tab');
        return { status: 'complete', ...t };
      }),
      update: updateTab,
      sendMessage: sendMessageWithEnvelope,
    },
    windows: { update: updateWindow },
    scripting: { executeScript },
  };
});

describe('BrowserToolGateway.getTargetTab fallback', () => {
  it('routes an explicit background tab without changing the fallback target', async () => {
    tabs = [
      { id: 2, url: 'https://visible.example.com/', active: true, lastAccessed: 2000 },
      { id: 7, url: 'https://background.example.com/', active: false },
    ];
    const gw = new BrowserToolGateway();
    await expect(gw.getOperationTab('t1', 7)).resolves.toBe(7);
    expect(gw.touchedTabs('t1')).toEqual([7]);
    await expect(gw.getTargetTab('t1')).resolves.toBe(2);
  });

  it('keeps omitted-tab calls on the submission tab after the active tab changes', async () => {
    tabs = [
      { id: 7, url: 'https://submitted.example.com/', active: false },
      { id: 9, url: 'https://later-active.example.com/', active: true, lastAccessed: 3000 },
    ];
    const gw = new BrowserToolGateway();
    gw.bindTurnTarget('t1', 7);

    await expect(gw.getTargetTab('t1')).resolves.toBe(7);
    tabs = tabs.filter((tab) => tab.id !== 7);
    await expect(gw.getTargetTab('t1')).rejects.toThrow(
      /submitted target tab \[7\].*no longer open/i,
    );
  });

  it('skips the extension page and picks the most recent active web tab', async () => {
    tabs = [
      // The chat page itself — active in the current window, most recent.
      { id: 1, url: 'chrome-extension://abcdef/chat.html', active: true, lastAccessed: 3000 },
      { id: 2, url: 'https://example.com/', active: true, lastAccessed: 2000 },
      { id: 3, url: 'https://older.example.org/', active: true, lastAccessed: 1000 },
    ];
    const gw = new BrowserToolGateway();
    await expect(gw.getTargetTab('t1')).resolves.toBe(2);
    expect(gw.touchedTabs('t1')).toEqual([2]);
  });

  it('throws a clear error when only extension/internal pages are active', async () => {
    tabs = [
      { id: 1, url: 'chrome-extension://abcdef/chat.html', active: true },
      { id: 4, url: 'chrome://settings', active: true },
    ];
    const gw = new BrowserToolGateway();
    await expect(gw.getTargetTab('t1')).rejects.toThrow(/网页标签页/);
  });

  it('suppresses manual-operation reports during the agent-input window', () => {
    const gw = new BrowserToolGateway();
    const paused: number[] = [];
    gw.onManualOperation = (tabId) => paused.push(tabId);
    gw.markAgentInput(7); // agent about to dispatch CDP input on tab 7
    gw.handleManualOperationReport(7);
    expect(paused).toEqual([]); // agent's own input — no pause
    gw.handleManualOperationReport(8);
    expect(paused).toEqual([8]); // another tab is a genuine manual op
  });

  it('droveThisTurn only after a write; reset at the turn boundary', () => {
    const gw = new BrowserToolGateway();
    expect(gw.droveThisTurn('t1', 5)).toBe(false);
    gw.markDriven('t1', 5);
    expect(gw.droveThisTurn('t1', 5)).toBe(true);
    expect(gw.droveThisTurn('t1', 6)).toBe(false);
    expect(gw.droveThisTurn('t2', 5)).toBe(false);
    gw.releaseFloatingTarget('t1'); // turn.complete hook
    expect(gw.droveThisTurn('t1', 5)).toBe(false);
  });

  it('releases an auto-discovered fallback at the turn boundary', async () => {
    tabs = [{ id: 2, url: 'https://example.com/', active: true, lastAccessed: 2000 }];
    const gw = new BrowserToolGateway();
    await expect(gw.getTargetTab('t1')).resolves.toBe(2);
    gw.releaseFloatingTarget('t1');
    await expect(gw.getTargetTab('t1')).resolves.toBe(2);
  });
});

describe('navigation-aware dispatch (click → page change ≠ failure)', () => {
  it('dispatches directly to an explicit inactive tab', async () => {
    tabs = [
      { id: 2, url: 'https://visible.example.com/', active: true },
      { id: 7, url: 'https://background.example.com/', active: false },
    ];
    const gw = new BrowserToolGateway();
    sendMessage.mockImplementation(
      async (tabId: number, op: { kind: string; requestId: string; tool?: string }) => {
        if (op.kind === 'ping') return 'pong';
        return { requestId: op.requestId, ok: true, result: { resultText: `clicked ${tabId}` } };
      },
    );

    const result = await gw.callContentTool('t1', 'click', { ref: 's1_1' }, 7);

    expect(result.resultText).toBe('clicked 7');
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ tool: 'click', params: { ref: 's1_1' } }),
    );
    await expect(gw.getTargetTab('t1')).resolves.toBe(2);
  });

  it('rejects a response from a stale content-script schema', async () => {
    tabs = [{ id: 7, url: 'https://background.example.com/', active: true }];
    const gw = new BrowserToolGateway();
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string }) => {
        if (op.kind === 'ping') return 'pong';
        return {
          protocol: CONTENT_SCRIPT_PROTOCOL,
          schemaHash: 'stale-schema',
          requestId: op.requestId,
          ok: true,
          result: { resultText: 'must not be accepted' },
        };
      },
    );

    await expect(gw.callContentTool('t1', 'read_page', {}, 7)).rejects.toThrow(
      /Invalid content-script response/,
    );
  });

  it('a channel error with a changed URL is reported as successful navigation', async () => {
    tabs = [{ id: 5, url: 'https://shop.example.com/list', active: true, title: '列表' }];
    const gw = new BrowserToolGateway();

    let calls = 0;
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string; tool?: string }) => {
        calls++;
        if (op.kind === 'ping') return 'pong';
        if (op.tool === 'click') {
          // The click navigates: content script torn down mid-call.
          tabs[0]!.url = 'https://shop.example.com/item/42';
          tabs[0]!.title = '商品详情';
          throw new Error('The message channel closed before a response was received.');
        }
        if (op.tool === 'read_page') {
          return {
            requestId: op.requestId,
            ok: true,
            result: { resultText: '# Page Snapshot (s1)\n- button "买" [ref=s1_1]' },
          };
        }
        throw new Error(`unexpected ${op.tool}`);
      },
    );

    const result = await gw.callContentTool('t1', 'click', { ref: 's0_1' });
    expect(result.resultText).toContain('页面已跳转到 https://shop.example.com/item/42');
    expect(result.resultText).toContain('旧 ref 已全部失效');
    expect(result.snapshot).toContain('Page Snapshot');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('does not replay a dispatched write when the channel closes without navigation', async () => {
    tabs = [{ id: 5, url: 'https://shop.example.com/cart', active: true }];
    const gateway = new BrowserToolGateway();
    let clickCalls = 0;
    sendMessage.mockImplementation(async (_tabId: number, op: { kind: string; tool?: string }) => {
      if (op.kind === 'ping') return 'pong';
      if (op.tool === 'click') {
        clickCalls++;
        throw new Error('The message channel closed before a response was received.');
      }
      throw new Error(`unexpected ${op.tool}`);
    });

    await expect(gateway.callContentTool('t1', 'click', { ref: 's0_1' }, 5)).rejects.toMatchObject({
      failure: {
        code: 'navigation_uncertain',
        retryable: false,
        details: { dispatched: true, effectMayHaveOccurred: true, channelUnavailable: true },
      },
    });
    expect(clickCalls).toBe(1);
    expect(executeScript).toHaveBeenCalledTimes(2); // install + restore dialog interception only
  });

  it('still reinjects and retries a read after a missing content-script channel', async () => {
    tabs = [{ id: 5, url: 'https://shop.example.com/cart', active: true }];
    const gateway = new BrowserToolGateway();
    let readCalls = 0;
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string; tool?: string }) => {
        if (op.kind === 'ping') return 'pong';
        if (op.tool !== 'read_page') throw new Error(`unexpected ${op.tool}`);
        readCalls++;
        if (readCalls === 1) throw new Error('Could not establish connection.');
        return { requestId: op.requestId, ok: true, result: { resultText: 'safe read' } };
      },
    );

    await expect(gateway.callContentTool('t1', 'read_page', {}, 5)).resolves.toMatchObject({
      resultText: 'safe read',
    });
    expect(readCalls).toBe(2);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('adopts a link-opened child tab and foregrounds it when the user is on Panelot chat', async () => {
    tabs = [
      {
        id: 1,
        url: 'chrome-extension://panelot/chat.html?thread=t1',
        active: true,
        windowId: 3,
      },
      {
        id: 5,
        url: 'https://shop.example.com/list',
        active: false,
        windowId: 3,
        status: 'complete',
      },
    ];
    const gateway = new BrowserToolGateway();
    gateway.bindTurnTarget('t1', 5);
    sendMessage.mockImplementation(
      async (tabId: number, op: { kind: string; requestId: string; tool?: string }) => {
        if (op.kind === 'ping') return 'pong';
        if (op.tool === 'click') {
          tabs.push({
            id: 8,
            url: 'https://shop.example.com/item/42',
            title: '商品详情',
            active: false,
            openerTabId: 5,
            windowId: 3,
            status: 'complete',
          });
          return {
            requestId: op.requestId,
            ok: true,
            result: { resultText: '已点击，但原页面没有变化' },
          };
        }
        if (op.tool === 'read_page' && tabId === 8) {
          return {
            requestId: op.requestId,
            ok: true,
            result: { resultText: '# 商品详情\n- button "购买" [ref=s1_1]' },
          };
        }
        throw new Error(`unexpected ${op.tool}`);
      },
    );

    const result = await gateway.callContentTool('t1', 'click', { ref: 's0_1' }, 5);

    expect(result).toMatchObject({
      resultTabId: 8,
      pageStabilized: true,
      evidence: { effectState: 'verified', observedEffects: ['tab_created'] },
    });
    expect(result.resultText).toContain('原标签页 [tabId=5] 保持不变');
    expect(result.resultText).toContain('已从 Panelot 对话页切换');
    expect(result.snapshot).toContain('商品详情');
    expect(updateTab).toHaveBeenCalledWith(8, { active: true });
    expect(updateWindow).toHaveBeenCalledWith(3, { focused: true });
    await expect(gateway.getTargetTab('t1')).resolves.toBe(8);
    expect(gateway.touchedTabs('t1')).toEqual([5, 8]);
  });

  it('detects a submit-created tab without stealing focus from a visible web page', async () => {
    tabs = [
      {
        id: 5,
        url: 'https://search.example.com/',
        active: true,
        windowId: 3,
        status: 'complete',
      },
    ];
    const gateway = new BrowserToolGateway();
    gateway.bindTurnTarget('t1', 5);
    sendMessage.mockImplementation(
      async (tabId: number, op: { kind: string; requestId: string; tool?: string }) => {
        if (op.kind === 'ping') return 'pong';
        if (op.tool === 'type') {
          tabs.push({
            id: 8,
            url: 'https://search.example.com/results?q=panelot',
            active: false,
            openerTabId: 5,
            windowId: 3,
            status: 'complete',
          });
          return {
            requestId: op.requestId,
            ok: true,
            result: { resultText: '已输入并提交' },
          };
        }
        if (op.tool === 'read_page' && tabId === 8) {
          return {
            requestId: op.requestId,
            ok: true,
            result: { resultText: '# Results' },
          };
        }
        throw new Error(`unexpected ${op.tool}`);
      },
    );

    const result = await gateway.callContentTool(
      't1',
      'type',
      { ref: 's0_1', text: 'panelot', submit: true },
      5,
    );

    expect(result).toMatchObject({
      resultTabId: 8,
      evidence: { observedEffects: ['tab_created'], outcome: 'verified' },
    });
    expect(updateTab).not.toHaveBeenCalled();
    await expect(gateway.getTargetTab('t1')).resolves.toBe(8);
  });

  it('a genuine failure with an unchanged URL still surfaces as an error', async () => {
    tabs = [{ id: 5, url: 'https://shop.example.com/list', active: true }];
    const gw = new BrowserToolGateway();
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string }) => {
        if (op.kind === 'ping') return 'pong';
        return {
          requestId: op.requestId,
          ok: false,
          error: '快照已过期：ref "s0_1" 不属于当前快照',
        };
      },
    );
    await expect(gw.callContentTool('t1', 'click', { ref: 's0_1' })).rejects.toThrow(/快照已过期/);
  });

  it('does not reframe a reported tool error as navigation even if the URL changed', async () => {
    // The dangerous case: the tool genuinely failed (response arrived ok:false)
    // AND some unrelated redirect changed the URL. Must stay an error, not a
    // false "navigation succeeded".
    tabs = [{ id: 5, url: 'https://shop.example.com/list', active: true }];
    const gw = new BrowserToolGateway();
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string }) => {
        if (op.kind === 'ping') return 'pong';
        // A background redirect fires while the tool reports failure.
        tabs[0]!.url = 'https://shop.example.com/promo';
        return { requestId: op.requestId, ok: false, error: '元素被遮挡，真实用户无法点到' };
      },
    );
    await expect(gw.callContentTool('t1', 'click', { ref: 's1_1' })).rejects.toThrow(/元素被遮挡/);
  });

  it('a timeout with an UNCHANGED url stays a timeout (not a fake navigation)', async () => {
    tabs = [{ id: 5, url: 'https://shop.example.com/list', active: true, status: 'loading' }];
    const gw = new BrowserToolGateway();
    let pinged = false;
    sendMessage.mockImplementation(async (_tabId: number, op: { kind: string }) => {
      if (op.kind === 'ping') {
        pinged = true;
        return 'pong';
      }
      // Never resolves for the real tool → the race rejects with a timeout.
      return new Promise(() => {});
    });
    const deadlineAt = Date.now() + 100;
    await expect(
      gw.callContentTool('t1', 'click', { ref: 's1_1' }, undefined, undefined, deadlineAt),
    ).rejects.toThrow(/超时/);
    expect(pinged).toBe(true);
  });
});

describe('same-tab request serialization and cancellation', () => {
  it('serializes the same tab across different thread owners', async () => {
    tabs = [{ id: 7, url: 'https://queue.example.com/', active: true }];
    const gateway = new BrowserToolGateway();
    const executeOps: { requestId: string; params: unknown }[] = [];
    let finishFirst!: () => void;
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string; params?: unknown }) => {
        if (op.kind === 'ping') return { requestId: op.requestId, ok: true, result: 'pong' };
        if (op.kind === 'cancel') {
          return { requestId: op.requestId, ok: true, result: 'cancelled' };
        }
        executeOps.push({ requestId: op.requestId, params: op.params });
        if (executeOps.length === 1) {
          await new Promise<void>((resolve) => {
            finishFirst = resolve;
          });
        }
        return {
          requestId: op.requestId,
          ok: true,
          result: { resultText: `done-${executeOps.length}` },
        };
      },
    );

    const first = gateway.callContentTool('thread-a', 'click', { ref: 's1_1' }, 7);
    await vi.waitFor(() => expect(executeOps).toHaveLength(1));
    const second = gateway.callContentTool('thread-b', 'click', { ref: 's1_2' }, 7);
    await Promise.resolve();
    expect(executeOps).toHaveLength(1);

    finishFirst();
    await expect(first).resolves.toMatchObject({ resultText: 'done-1' });
    await expect(second).resolves.toMatchObject({ resultText: 'done-2' });
    expect(executeOps.map((op) => op.params)).toEqual([{ ref: 's1_1' }, { ref: 's1_2' }]);
  });

  it('never dispatches a queued write after its signal is aborted', async () => {
    tabs = [{ id: 7, url: 'https://queue.example.com/', active: true }];
    const gateway = new BrowserToolGateway();
    const executeOps: { requestId: string; params: unknown }[] = [];
    let finishFirst!: () => void;
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string; params?: unknown }) => {
        if (op.kind === 'ping') return { requestId: op.requestId, ok: true, result: 'pong' };
        if (op.kind === 'cancel') {
          return { requestId: op.requestId, ok: true, result: 'cancelled' };
        }
        executeOps.push({ requestId: op.requestId, params: op.params });
        await new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        return { requestId: op.requestId, ok: true, result: { resultText: 'done' } };
      },
    );

    const first = gateway.callContentTool('thread-a', 'click', { ref: 's1_1' }, 7);
    await vi.waitFor(() => expect(executeOps).toHaveLength(1));
    const queuedController = new AbortController();
    const queued = gateway.callContentTool(
      'thread-b',
      'type',
      { ref: 's1_2', text: 'must-not-run' },
      7,
      queuedController.signal,
    );
    queuedController.abort();

    await expect(queued).rejects.toThrow(/中断/);
    finishFirst();
    await expect(first).resolves.toMatchObject({ resultText: 'done' });
    await Promise.resolve();
    expect(executeOps).toHaveLength(1);
    expect(executeOps[0]!.params).toEqual({ ref: 's1_1' });
  });

  it('cancels only the in-flight request id and reports write uncertainty', async () => {
    tabs = [{ id: 7, url: 'https://queue.example.com/', active: true }];
    const gateway = new BrowserToolGateway();
    let executeRequestId = '';
    let finishExecute!: () => void;
    const cancelOps: { cancelRequestId: string }[] = [];
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string; cancelRequestId?: string }) => {
        if (op.kind === 'ping') return { requestId: op.requestId, ok: true, result: 'pong' };
        if (op.kind === 'cancel') {
          cancelOps.push({ cancelRequestId: op.cancelRequestId! });
          return { requestId: op.requestId, ok: true, result: 'cancelled' };
        }
        executeRequestId = op.requestId;
        await new Promise<void>((resolve) => {
          finishExecute = resolve;
        });
        return { requestId: op.requestId, ok: true, result: { resultText: 'late result' } };
      },
    );
    const controller = new AbortController();

    const running = gateway.callContentTool(
      'thread-a',
      'click',
      { ref: 's1_1' },
      7,
      controller.signal,
    );
    await vi.waitFor(() => expect(executeRequestId).not.toBe(''));
    controller.abort();

    await expect(running).rejects.toMatchObject({
      failure: {
        code: 'aborted',
        details: { dispatched: true, effectMayHaveOccurred: true },
      },
    });
    expect(cancelOps).toEqual([{ cancelRequestId: executeRequestId }]);
    finishExecute();
  });

  it('rejects a response owned by another request id', async () => {
    tabs = [{ id: 7, url: 'https://queue.example.com/', active: true }];
    const gateway = new BrowserToolGateway();
    sendMessage.mockImplementation(
      async (_tabId: number, op: { kind: string; requestId: string }) => {
        if (op.kind === 'ping') return { requestId: op.requestId, ok: true, result: 'pong' };
        return { requestId: 'another-request', ok: true, result: { resultText: 'wrong owner' } };
      },
    );

    await expect(gateway.callContentTool('thread-a', 'read_page', {}, 7)).rejects.toThrow(
      /requestId mismatch/,
    );
  });
});
