import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpManager } from '../../src/tools/cdp/debugger';

// Minimal chrome.debugger mock.
const attach = vi.fn().mockResolvedValue(undefined);
const detach = vi.fn().mockResolvedValue(undefined);
const sendCommand = vi.fn().mockResolvedValue({});
const onDetachListeners = new Set<(s: { tabId: number }) => void>();
const onEventListeners = new Set<
  (s: { tabId: number }, method: string, params?: Record<string, unknown>) => void
>();

beforeEach(() => {
  vi.useFakeTimers();
  attach.mockClear();
  detach.mockClear();
  sendCommand.mockClear();
  onDetachListeners.clear();
  onEventListeners.clear();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    debugger: {
      attach,
      detach,
      sendCommand,
      onDetach: {
        addListener: (cb: (s: { tabId: number }) => void) => onDetachListeners.add(cb),
        removeListener: (cb: (s: { tabId: number }) => void) => onDetachListeners.delete(cb),
      },
      onEvent: {
        addListener: (
          cb: (s: { tabId: number }, method: string, params?: Record<string, unknown>) => void,
        ) => onEventListeners.add(cb),
        removeListener: (
          cb: (s: { tabId: number }, method: string, params?: Record<string, unknown>) => void,
        ) => onEventListeners.delete(cb),
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

  it('builds generation-scoped deep refs from backend AX nodes', async () => {
    sendCommand.mockImplementation(async (_target, method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { role: { value: 'heading' }, name: { value: 'Checkout' } },
            {
              role: { value: 'textbox' },
              name: { value: 'Cardholder' },
              backendDOMNodeId: 42,
            },
          ],
        };
      }
      return {};
    });
    const cdp = new CdpManager();
    const snapshot = await cdp.getDeepAxTree(7);
    expect(snapshot).toContain('textbox "Cardholder" [ref=c1_1]');
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Accessibility.getFullAXTree',
      undefined,
    );
  });

  it('resolves the latest deep ref to a backend-node center and rejects stale refs', async () => {
    sendCommand.mockImplementation(async (_target, method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 9 }],
        };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
      }
      return {};
    });
    const cdp = new CdpManager();
    await cdp.getDeepAxTree(7);
    await expect(cdp.getDeepRefCenter(7, 'c1_1')).resolves.toEqual({ x: 20, y: 30 });
    await cdp.getDeepAxTree(7);
    await expect(cdp.getDeepRefCenter(7, 'c1_1')).rejects.toThrow(/已过期/);
  });

  it('waits for tracked network requests to finish and then become idle', async () => {
    const cdp = new CdpManager();
    const operation = cdp.withNetworkSettled(7, async () => {
      for (const listener of onEventListeners) {
        listener({ tabId: 7 }, 'Network.requestWillBeSent', { requestId: 'r1' });
      }
      setTimeout(() => {
        for (const listener of onEventListeners) {
          listener({ tabId: 7 }, 'Network.loadingFinished', { requestId: 'r1' });
        }
      }, 100);
      return 'done';
    });
    await vi.advanceTimersByTimeAsync(700);
    await expect(operation).resolves.toEqual({ value: 'done', settled: true });
    expect(onEventListeners.size).toBe(0);
  });

  it('adds bounded event-listener targets that are absent from the AXTree', async () => {
    sendCommand.mockImplementation(async (_target, method: string) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      if (method === 'DOM.getFlattenedDocument') {
        return {
          nodes: [
            {
              nodeType: 1,
              nodeName: 'DIV',
              backendNodeId: 77,
              attributes: ['aria-label', 'Open picker'],
            },
          ],
        };
      }
      if (method === 'DOM.resolveNode') return { object: { objectId: 'object-77' } };
      if (method === 'DOMDebugger.getEventListeners') return { listeners: [{ type: 'click' }] };
      return {};
    });
    const cdp = new CdpManager();
    await expect(cdp.getDeepAxTree(7)).resolves.toContain(
      'event-target "Open picker" [events=click] [ref=c1_1]',
    );
  });

  it('collects OOPIF AX nodes through flat child sessions', async () => {
    sendCommand.mockImplementation(
      async (target: { tabId: number; sessionId?: string }, method) => {
        if (method === 'Target.setAutoAttach' && !target.sessionId) {
          for (const listener of onEventListeners) {
            listener({ tabId: 7 }, 'Target.attachedToTarget', {
              sessionId: 'child-1',
              targetInfo: { type: 'iframe' },
            });
          }
          return {};
        }
        if (method === 'Accessibility.getFullAXTree') {
          return target.sessionId
            ? {
                nodes: [
                  {
                    role: { value: 'textbox' },
                    name: { value: 'Frame email' },
                    backendDOMNodeId: 88,
                  },
                ],
              }
            : { nodes: [] };
        }
        if (method === 'DOM.getFlattenedDocument') return { nodes: [] };
        if (method === 'DOM.getBoxModel') {
          return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
        }
        return {};
      },
    );
    const cdp = new CdpManager();
    const snapshot = await cdp.getDeepAxTree(7);
    expect(snapshot).toContain('textbox "Frame email" [frame=cross-origin] [ref=c1_1]');
    await expect(cdp.getDeepRefCenter(7, 'c1_1')).resolves.toEqual({ x: 10, y: 5 });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-1' },
      'DOM.getBoxModel',
      { backendNodeId: 88 },
    );
    const click = cdp.clickDeepRef(7, 'c1_1');
    await vi.advanceTimersByTimeAsync(600);
    await expect(click).resolves.toEqual({ settled: true });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-1' },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 10, y: 5 }),
    );
    const type = cdp.typeDeepRef(7, 'c1_1', 'Ada');
    await vi.advanceTimersByTimeAsync(600);
    await expect(type).resolves.toEqual({ settled: true });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-1' },
      'Input.insertText',
      { text: 'Ada' },
    );
  });
});
