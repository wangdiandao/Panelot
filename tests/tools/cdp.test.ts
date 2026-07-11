import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpManager } from '../../src/tools/cdp/debugger';

// Minimal chrome.debugger mock.
const attach = vi.fn().mockResolvedValue(undefined);
const detach = vi.fn().mockResolvedValue(undefined);
const sendCommand = vi.fn().mockResolvedValue({});
const onDetachListeners = new Set<(s: { tabId: number }) => void>();

beforeEach(() => {
  vi.useFakeTimers();
  attach.mockClear();
  detach.mockClear();
  sendCommand.mockClear();
  onDetachListeners.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    debugger: {
      attach,
      detach,
      sendCommand,
      onDetach: {
        addListener: (cb: (s: { tabId: number }) => void) => onDetachListeners.add(cb),
        removeListener: (cb: (s: { tabId: number }) => void) => onDetachListeners.delete(cb),
      },
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CdpManager (docs/05 §2 — on-demand, single-target, idle detach)', () => {
  it('attaches once per tab and reuses within the idle window', async () => {
    const cdp = new CdpManager();
    await cdp.withTab(1, async () => {});
    await cdp.withTab(1, async () => {});
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
  });

  it('switches target: detaches the old tab before attaching the new (single-target)', async () => {
    const cdp = new CdpManager();
    await cdp.withTab(1, async () => {});
    await cdp.withTab(2, async () => {});
    expect(detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(attach).toHaveBeenCalledTimes(2);
    expect(cdp.isAttached(2)).toBe(true);
    expect(cdp.isAttached(1)).toBe(false);
  });

  it('auto-detaches after the 30s idle window', async () => {
    const cdp = new CdpManager();
    await cdp.withTab(1, async () => {});
    expect(detach).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(cdp.isAttached(1)).toBe(false);
  });

  it('serializes concurrent withTab calls (no interleaved sessions)', async () => {
    const cdp = new CdpManager();
    const order: string[] = [];
    const p1 = cdp.withTab(1, async () => {
      order.push('start-1');
      await Promise.resolve();
      order.push('end-1');
    });
    const p2 = cdp.withTab(2, async () => {
      order.push('start-2');
      order.push('end-2');
    });
    await vi.runAllTimersAsync();
    await Promise.all([p1, p2]);
    // Task 1 fully completes before task 2 begins.
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('forgets the session when the browser detaches externally', async () => {
    const cdp = new CdpManager();
    await cdp.withTab(1, async () => {});
    // Simulate DevTools opening / user detaching.
    for (const cb of onDetachListeners) cb({ tabId: 1 });
    expect(cdp.isAttached(1)).toBe(false);
  });

  it('a failing task still lets the next task attach (chain stays alive)', async () => {
    const cdp = new CdpManager();
    await expect(
      cdp.withTab(1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await cdp.withTab(2, async () => {});
    expect(cdp.isAttached(2)).toBe(true);
  });
});
