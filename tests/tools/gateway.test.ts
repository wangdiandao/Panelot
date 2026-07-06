/**
 * BrowserToolGateway target-tab fallback: the extension's own pages
 * (chrome-extension://) must never be auto-attached as the operation target —
 * they are never a meaningful target for browser ops (the user means the web
 * page they were looking at, not the chat UI itself).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserToolGateway } from '../../src/tools/gateway';

type TabStub = { id: number; url: string; active: boolean; lastAccessed?: number; status?: string; title?: string };

let tabs: TabStub[] = [];
let sendMessage: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tabs = [];
  sendMessage = vi.fn();
  executeScript = vi.fn(async () => {});
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: vi.fn(async (q: { active?: boolean }) =>
        tabs.filter((t) => (q.active === undefined ? true : t.active === q.active))),
      get: vi.fn(async (id: number) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('no tab');
        return { status: 'complete', ...t };
      }),
      sendMessage,
    },
    scripting: { executeScript },
  };
});

describe('BrowserToolGateway.getTargetTab fallback', () => {
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

  it('keeps an explicitly pinned tab as the target', async () => {
    tabs = [
      { id: 1, url: 'chrome-extension://abcdef/chat.html', active: true, lastAccessed: 3000 },
      { id: 5, url: 'https://attached.example.com/', active: false },
    ];
    const gw = new BrowserToolGateway();
    gw.pinTarget('t1', 5);
    await expect(gw.getTargetTab('t1')).resolves.toBe(5);
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

  it('a pinned target survives releaseFloatingTarget; an auto-discovered one is released', async () => {
    tabs = [
      { id: 2, url: 'https://example.com/', active: true, lastAccessed: 2000 },
      { id: 5, url: 'https://pinned.example.com/', active: false },
    ];
    const gw = new BrowserToolGateway();
    // Auto-discovered target (unpinned): released at the turn boundary.
    await expect(gw.getTargetTab('t1')).resolves.toBe(2);
    gw.releaseFloatingTarget('t1');
    expect(gw.currentTarget('t1')).toBeUndefined();
    // Pinned target: persists across the boundary.
    gw.pinTarget('t2', 5);
    gw.releaseFloatingTarget('t2');
    expect(gw.currentTarget('t2')).toBe(5);
  });
});

describe('navigation-aware dispatch (click → page change ≠ failure)', () => {
  it('a channel error with a changed URL is reported as successful navigation', async () => {
    tabs = [{ id: 5, url: 'https://shop.example.com/list', active: true, title: '列表' }];
    const gw = new BrowserToolGateway();
    gw.pinTarget('t1', 5);

    let calls = 0;
    sendMessage.mockImplementation(async (_tabId: number, op: { tool: string }) => {
      calls++;
      if (op.tool === '__ping') return 'pong';
      if (op.tool === 'click') {
        // The click navigates: content script torn down mid-call.
        tabs[0]!.url = 'https://shop.example.com/item/42';
        tabs[0]!.title = '商品详情';
        throw new Error('The message channel closed before a response was received.');
      }
      if (op.tool === 'read_page') {
        return { requestId: 'x', ok: true, result: { resultText: '# Page Snapshot (s1)\n- button "买" [ref=s1_1]' } };
      }
      throw new Error(`unexpected ${op.tool}`);
    });

    const result = await gw.callContentTool('t1', 'click', { ref: 's0_1' });
    expect(result.resultText).toContain('页面已跳转到 https://shop.example.com/item/42');
    expect(result.resultText).toContain('旧 ref 已全部失效');
    expect(result.snapshot).toContain('Page Snapshot');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('a genuine failure with an unchanged URL still surfaces as an error', async () => {
    tabs = [{ id: 5, url: 'https://shop.example.com/list', active: true }];
    const gw = new BrowserToolGateway();
    gw.pinTarget('t1', 5);
    sendMessage.mockImplementation(async (_tabId: number, op: { tool: string }) => {
      if (op.tool === '__ping') return 'pong';
      return { requestId: 'x', ok: false, error: '快照已过期：ref "s0_1" 不属于当前快照' };
    });
    await expect(gw.callContentTool('t1', 'click', { ref: 's0_1' })).rejects.toThrow(/快照已过期/);
  });

  it('a reported tool error is NEVER reframed as navigation, even if the URL changed', async () => {
    // The dangerous case: the tool genuinely failed (response arrived ok:false)
    // AND some unrelated redirect changed the URL. Must stay an error, not a
    // false "navigation succeeded".
    tabs = [{ id: 5, url: 'https://shop.example.com/list', active: true }];
    const gw = new BrowserToolGateway();
    gw.pinTarget('t1', 5);
    sendMessage.mockImplementation(async (_tabId: number, op: { tool: string }) => {
      if (op.tool === '__ping') return 'pong';
      // A background redirect fires while the tool reports failure.
      tabs[0]!.url = 'https://shop.example.com/promo';
      return { requestId: 'x', ok: false, error: '元素被遮挡，真实用户无法点到' };
    });
    await expect(gw.callContentTool('t1', 'click', { ref: 's1_1' })).rejects.toThrow(/元素被遮挡/);
  });

  it('a timeout with an UNCHANGED url stays a timeout (not a fake navigation)', async () => {
    tabs = [{ id: 5, url: 'https://shop.example.com/list', active: true, status: 'loading' }];
    const gw = new BrowserToolGateway();
    gw.pinTarget('t1', 5);
    let pinged = false;
    sendMessage.mockImplementation(async (_tabId: number, op: { tool: string }) => {
      if (op.tool === '__ping') { pinged = true; return 'pong'; }
      // Never resolves for the real tool → the race rejects with a timeout.
      return new Promise(() => {});
    });
    await expect(gw.callContentTool('t1', 'click', { ref: 's1_1' })).rejects.toThrow(/超时/);
    expect(pinged).toBe(true);
  }, 20_000);
});
