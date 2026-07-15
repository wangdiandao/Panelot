/**
 * L0 tab tools — view-state honesty (docs/05 §6): the agent's working tab and
 * the user's visible tab are different things. Tool results must state
 * explicitly whether the USER's view changed, so the model never offers to
 * "switch back" after an operation that didn't touch the user's screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserToolGateway } from '../../src/tools/gateway';
import { createL0Tools } from '../../src/tools/browserTools';
import type { AnyAgentTool } from '../../src/agent/tool';

type TabStub = {
  id: number;
  url: string;
  title?: string;
  active: boolean;
  windowId?: number;
  lastFocused?: boolean;
  lastAccessed?: number;
  status?: string;
};

let tabs: TabStub[] = [];
let removed: number[];
let updated: { tabId: number; props: Record<string, unknown> }[];
let windowsUpdated: number[];

beforeEach(() => {
  tabs = [];
  removed = [];
  updated = [];
  windowsUpdated = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: vi.fn(
        async (q: { active?: boolean; lastFocusedWindow?: boolean; currentWindow?: boolean }) =>
          tabs.filter((t) => {
            if (q.active !== undefined && t.active !== q.active) return false;
            if (q.lastFocusedWindow && !t.lastFocused) return false;
            return true;
          }),
      ),
      get: vi.fn(async (id: number) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('no tab');
        return { status: 'complete', ...t };
      }),
      remove: vi.fn(async (id: number) => {
        removed.push(id);
        const t = tabs.find((x) => x.id === id);
        tabs = tabs.filter((x) => x.id !== id);
        // Chrome auto-activates a neighbor when the active tab closes.
        if (t?.active && tabs.length > 0) {
          tabs[0]!.active = true;
          tabs[0]!.lastFocused = true;
        }
      }),
      create: vi.fn(async (props: { url: string }) => {
        const tab = { id: 900, url: props.url, active: false, status: 'complete' };
        tabs.push(tab);
        return tab;
      }),
      update: vi.fn(async (id: number, props: Record<string, unknown>) => {
        updated.push({ tabId: id, props });
        const tab = tabs.find((candidate) => candidate.id === id);
        if (tab && typeof props.url === 'string') tab.url = props.url;
        if (tab && typeof props.active === 'boolean') tab.active = props.active;
      }),
      sendMessage: vi.fn(async (_tabId: number, op: { requestId: string }) => ({
        requestId: op.requestId,
        ok: true,
        result: { resultText: 'snap' },
      })),
    },
    windows: {
      update: vi.fn(async (id: number) => {
        windowsUpdated.push(id);
      }),
    },
    scripting: { executeScript: vi.fn(async () => {}) },
  };
});

function toolset(): { gw: BrowserToolGateway; tool: (name: string) => AnyAgentTool } {
  const gw = new BrowserToolGateway();
  const all = createL0Tools(gw, () => 't1');
  return { gw, tool: (name) => all.find((t) => t.name === name)! };
}

const text = (r: { content: { type: string; text?: string }[] }) => r.content[0]!.text!;
const abort = () => new AbortController().signal;

describe('tab_close view-state honesty', () => {
  it('closing a background tab says the user view did NOT change', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', title: '用户页面', active: true, lastFocused: true },
      { id: 2, url: 'https://b.com/', title: '视频页', active: false },
    ];
    const { tool } = toolset();
    const result = await tool('tab_close').execute('c1', { tabId: 2 } as never, abort(), undefined);
    expect(removed).toEqual([2]);
    expect(text(result)).toContain('后台标签页');
    expect(text(result)).toContain('没有变化');
    expect(text(result)).toContain('不需要切换回去');
    expect(text(result)).toContain('用户页面');
  });

  it('closing the tab the user is LOOKING at says the browser switched', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', title: '要关的页', active: true, lastFocused: true },
      { id: 2, url: 'https://b.com/', title: '邻居页', active: false },
    ];
    const { tool } = toolset();
    const result = await tool('tab_close').execute('c1', { tabId: 1 } as never, abort(), undefined);
    expect(removed).toEqual([1]);
    expect(text(result)).toContain('用户正在看的页面');
    expect(text(result)).toContain('自动切换');
  });

  it('closing a non-existent tab reports a clean error', async () => {
    tabs = [{ id: 1, url: 'https://a.com/', active: true, lastFocused: true }];
    const { tool } = toolset();
    await expect(
      tool('tab_close').execute('c1', { tabId: 99 } as never, abort(), undefined),
    ).rejects.toThrow(/不存在/);
  });

  it('can close any tab, not just ones the agent touched (user asked for it)', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', active: true, lastFocused: true },
      { id: 7, url: 'https://c.com/', title: '别的页', active: false },
    ];
    const { gw, tool } = toolset();
    expect(gw.touchedTabs('t1')).toEqual([]); // never targeted
    await tool('tab_close').execute('c1', { tabId: 7 } as never, abort(), undefined);
    expect(removed).toEqual([7]);
  });
});

describe('tab_focus foreground-only behavior', () => {
  it('prepares the selected tab and URL destination before permission checks', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', active: true, lastFocused: true },
      { id: 2, url: 'https://b.com/path', active: false },
    ];
    const { tool } = toolset();

    await expect(tool('tab_focus').resolveTarget!({ tabId: 2 } as never)).resolves.toEqual({
      tabId: 2,
      origin: 'https://b.com',
    });
    await expect(
      tool('tab_open').resolveTarget!({ url: 'https://new.example/path' } as never),
    ).resolves.toEqual({ origin: 'https://new.example' });
  });

  it('brings the tab to the foreground and says so', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', title: 'A', active: true, lastFocused: true, windowId: 10 },
      { id: 2, url: 'https://b.com/', title: 'B', active: false, windowId: 10 },
    ];
    const { tool } = toolset();
    const result = await tool('tab_focus').execute('c1', { tabId: 2 } as never, abort(), undefined);
    expect(updated).toEqual([{ tabId: 2, props: { active: true } }]);
    expect(windowsUpdated).toEqual([10]);
    expect(text(result)).toContain('前台');
  });
});

describe('tabs_list user-view marking', () => {
  it('has no window-scope parameter', () => {
    const { tool } = toolset();

    expect(tool('tabs_list').parameters.safeParse({}).success).toBe(true);
    expect(tool('tabs_list').parameters.safeParse({ all: true }).success).toBe(false);
  });

  it("marks the user's visible tab without declaring a global agent target", async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', title: 'A', active: true, lastFocused: true },
      { id: 2, url: 'https://b.com/', title: 'B', active: false },
    ];
    const { tool } = toolset();
    const result = await tool('tabs_list').execute('c1', {} as never, abort(), undefined);
    expect(text(result)).toContain('[1] (用户正在看) A');
    expect(text(result)).toContain('[2] B');
    expect(text(result)).not.toContain('当前操作目标');
  });

  it('always lists tabs across the whole browser', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', title: 'A', active: true, lastFocused: true },
      { id: 2, url: 'https://b.com/', title: 'B', active: false },
      { id: 3, url: 'https://c.com/', title: 'C', active: false },
    ];
    const { tool } = toolset();
    // No tab ever touched — every open tab still shows up.
    const result = await tool('tabs_list').execute('c1', {} as never, abort(), undefined);
    expect(chrome.tabs.query).toHaveBeenCalledWith({});
    expect(text(result)).toContain('[1]');
    expect(text(result)).toContain('[2]');
    expect(text(result)).toContain('[3]');
  });
});

describe('tab_open stays in the background', () => {
  it('opening a new tab reports background + user view unchanged', async () => {
    tabs = [{ id: 1, url: 'https://a.com/', title: 'A', active: true, lastFocused: true }];
    const { tool } = toolset();
    const result = await tool('tab_open').execute(
      'c1',
      { url: 'https://new.example.com/x' } as never,
      abort(),
      undefined,
    );
    expect(text(result)).toContain('后台');
    expect(text(result)).toContain('用户看到的页面没有变化');
  });

  it('reusing an existing tab does not focus it', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', title: 'A', active: true, lastFocused: true },
      { id: 3, url: 'https://shop.com/cart', title: '购物车', active: false },
    ];
    const { tool } = toolset();
    const result = await tool('tab_open').execute(
      'c1',
      { url: 'https://shop.com/cart' } as never,
      abort(),
      undefined,
    );
    expect(updated).toEqual([]); // never touches active state
    expect(text(result)).toContain('复用');
    expect(text(result)).toContain('没有变化');
  });

  it('describes an exact-url reuse honestly when it is already the visible tab', async () => {
    tabs = [
      {
        id: 3,
        url: 'https://shop.com/cart',
        title: '购物车',
        active: true,
        lastFocused: true,
      },
    ];
    const { tool } = toolset();

    const result = await tool('tab_open').execute(
      'c1',
      { url: 'https://shop.com/cart' } as never,
      abort(),
      undefined,
    );

    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(text(result)).toContain('用户当前正在看的标签页');
    expect(text(result)).not.toContain('后台标签页');
  });

  it('does not reuse a same-path tab when query or hash differs', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', title: 'A', active: true, lastFocused: true },
      {
        id: 3,
        url: 'https://shop.com/cart?view=summary#top',
        title: '购物车摘要',
        active: false,
      },
    ];
    const { tool } = toolset();

    const result = await tool('tab_open').execute(
      'c1',
      { url: 'https://shop.com/cart?view=checkout#payment' } as never,
      abort(),
      undefined,
    );

    expect(updated).toEqual([]);
    expect(tabs.find((tab) => tab.id === 3)?.url).toBe('https://shop.com/cart?view=summary#top');
    expect(tabs.find((tab) => tab.id === 900)?.url).toBe(
      'https://shop.com/cart?view=checkout#payment',
    );
    expect(text(result)).toContain('后台打开标签页 [900]');
    expect(result.details).toMatchObject({
      actionEvidence: { effectState: 'verified', outcome: 'verified' },
    });
  });

  it('reuses only an exact full href, including query and hash', async () => {
    tabs = [
      { id: 1, url: 'https://a.com/', title: 'A', active: true, lastFocused: true },
      {
        id: 3,
        url: 'https://shop.com/cart?view=checkout#payment',
        title: '结账',
        active: false,
      },
    ];
    const { tool } = toolset();

    const result = await tool('tab_open').execute(
      'c1',
      { url: 'https://shop.com/cart?view=checkout#payment' } as never,
      abort(),
      undefined,
    );

    expect(chrome.tabs.create).not.toHaveBeenCalled();
    expect(updated).toEqual([]);
    expect(text(result)).toContain('URL 完全相同');
  });
});

describe('per-call tab routing', () => {
  it('navigates an inactive tab directly without focusing it', async () => {
    tabs = [
      { id: 1, url: 'https://visible.example/', title: 'Visible', active: true, lastFocused: true },
      { id: 2, url: 'https://background.example/', title: 'Background', active: false },
    ];
    const { tool } = toolset();

    const result = await tool('navigate').execute(
      'c1',
      { tabId: 2, url: 'https://destination.example/' } as never,
      abort(),
      undefined,
    );

    expect(updated).toContainEqual({
      tabId: 2,
      props: { url: 'https://destination.example/' },
    });
    expect(updated).not.toContainEqual({ tabId: 2, props: { active: true } });
    expect(text(result)).toContain('[tabId=2]');
    expect(result.details).toMatchObject({
      actionEvidence: {
        effectState: 'verified',
        outcome: 'verified',
        observedEffects: ['url_changed'],
      },
    });
  });

  it('does not claim a navigation when the tab already has the exact href', async () => {
    tabs = [
      { id: 1, url: 'https://visible.example/', active: true, lastFocused: true },
      {
        id: 2,
        url: 'https://destination.example/path?q=1#result',
        active: false,
      },
    ];
    const { tool } = toolset();

    const result = await tool('navigate').execute(
      'c1',
      { tabId: 2, url: 'https://destination.example/path?q=1#result' } as never,
      abort(),
      undefined,
    );

    expect(updated).toEqual([]);
    expect(text(result)).toContain('未派发导航');
    expect(result.details).toBeUndefined();
  });
});
