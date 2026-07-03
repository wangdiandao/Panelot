/**
 * BrowserToolGateway target-tab fallback: the extension's own pages
 * (chrome-extension://) must never be auto-attached as the operation target —
 * that would immediately hit the chrome-extension://* sensitive blacklist
 * and every tool call from the full-page chat tab would be denied.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserToolGateway } from '../../src/tools/gateway';

type TabStub = { id: number; url: string; active: boolean; lastAccessed?: number };

let tabs: TabStub[] = [];

beforeEach(() => {
  tabs = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: vi.fn(async (q: { active?: boolean }) =>
        tabs.filter((t) => (q.active === undefined ? true : t.active === q.active))),
      get: vi.fn(async (id: number) => {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('no tab');
        return t;
      }),
    },
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
    expect(gw.controls('t1')).toEqual([2]);
  });

  it('throws a clear error when only extension/internal pages are active', async () => {
    tabs = [
      { id: 1, url: 'chrome-extension://abcdef/chat.html', active: true },
      { id: 4, url: 'chrome://settings', active: true },
    ];
    const gw = new BrowserToolGateway();
    await expect(gw.getTargetTab('t1')).rejects.toThrow(/网页标签页/);
  });

  it('keeps an explicitly attached tab as the target', async () => {
    tabs = [
      { id: 1, url: 'chrome-extension://abcdef/chat.html', active: true, lastAccessed: 3000 },
      { id: 5, url: 'https://attached.example.com/', active: false },
    ];
    const gw = new BrowserToolGateway();
    gw.attachTab('t1', 5);
    await expect(gw.getTargetTab('t1')).resolves.toBe(5);
  });
});
