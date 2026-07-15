import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CdpManager } from '../../src/tools/cdp/debugger';

// Minimal chrome.debugger mock.
const attach = vi.fn().mockResolvedValue(undefined);
const detach = vi.fn().mockResolvedValue(undefined);
const sendCommand = vi.fn().mockResolvedValue({});
const onDetachListeners = new Set<(s: { tabId: number }) => void>();
const onEventListeners = new Set<
  (
    s: { tabId: number; sessionId?: string },
    method: string,
    params?: Record<string, unknown>,
  ) => void
>();
const onRemovedListeners = new Set<(tabId: number) => void>();
const onReplacedListeners = new Set<(addedTabId: number, removedTabId: number) => void>();
const onUpdatedListeners = new Set<(tabId: number, changeInfo: { status?: string }) => void>();

function identityResponse(target: { sessionId?: string }, method: string): object {
  const suffix = target.sessionId ?? 'root';
  if (method === 'Page.getFrameTree') {
    return { frameTree: { frame: { id: `frame-${suffix}`, loaderId: `loader-${suffix}` } } };
  }
  if (method === 'DOM.getDocument') {
    return { root: { backendNodeId: target.sessionId ? 101 : 100 } };
  }
  return {};
}

function deepRef(snapshot: string): string {
  const match = snapshot.match(/\[ref=(c[a-z0-9]+_\d+_\d+_\d+)\]/i);
  if (!match) throw new Error(`deep ref missing from:\n${snapshot}`);
  return match[1]!;
}

async function readDeep(cdp: CdpManager, advanceMs = 200): Promise<string> {
  const operation = cdp.getDeepAxTree(7);
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(advanceMs);
  return operation;
}

beforeEach(() => {
  vi.useFakeTimers();
  attach.mockClear();
  detach.mockClear();
  sendCommand.mockReset();
  sendCommand.mockImplementation(async (target, method) => identityResponse(target, method));
  onDetachListeners.clear();
  onEventListeners.clear();
  onRemovedListeners.clear();
  onReplacedListeners.clear();
  onUpdatedListeners.clear();
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
    tabs: {
      onRemoved: { addListener: (cb: (tabId: number) => void) => onRemovedListeners.add(cb) },
      onReplaced: {
        addListener: (cb: (addedTabId: number, removedTabId: number) => void) =>
          onReplacedListeners.add(cb),
      },
      onUpdated: {
        addListener: (cb: (tabId: number, changeInfo: { status?: string }) => void) =>
          onUpdatedListeners.add(cb),
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

  it('does not start a queued CDP operation after cancellation', async () => {
    const cdp = new CdpManager();
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const first = cdp.withTab(1, async () => {
      markFirstStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    await firstStarted;
    const controller = new AbortController();
    let secondStarted = false;
    const second = cdp.withTab(
      2,
      async () => {
        secondStarted = true;
      },
      controller.signal,
    );

    controller.abort();
    await expect(second).rejects.toMatchObject({
      failure: { code: 'aborted', details: { dispatched: false } },
    });
    releaseFirst();
    await first;
    await Promise.resolve();
    expect(secondStarted).toBe(false);
  });

  it('preserves effect uncertainty when cancellation lands after a CDP write callback', async () => {
    const cdp = new CdpManager();
    const controller = new AbortController();

    const operation = cdp.withTab(
      1,
      async () => {
        controller.abort();
      },
      controller.signal,
      Date.now() + 10_000,
      true,
    );

    await expect(operation).rejects.toMatchObject({
      failure: {
        code: 'aborted',
        details: { dispatched: true, effectMayHaveOccurred: true },
      },
    });
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
    sendCommand.mockImplementation(async (target, method: string) => {
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
      return identityResponse(target, method);
    });
    const cdp = new CdpManager();
    const snapshot = await readDeep(cdp);
    expect(snapshot).toMatch(/textbox "Cardholder" \[ref=c[a-z0-9]+_1_1_1\]/i);
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      'Accessibility.getFullAXTree',
      undefined,
    );
  });

  it('resolves the latest deep ref to a backend-node center and rejects stale refs', async () => {
    sendCommand.mockImplementation(async (target, method: string) => {
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 9 }],
        };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } };
      }
      return identityResponse(target, method);
    });
    const cdp = new CdpManager();
    const firstRef = deepRef(await readDeep(cdp));
    await expect(cdp.getDeepRefCenter(7, firstRef)).resolves.toEqual({ x: 20, y: 30 });
    await readDeep(cdp);
    await expect(cdp.getDeepRefCenter(7, firstRef)).rejects.toThrow(/已过期/);
  });

  it.each([
    'Page.frameStartedNavigating',
    'Page.frameNavigated',
    'Page.frameDetached',
    'Target.detachedFromTarget',
  ])('invalidates deep refs on %s before any action CDP command', async (method) => {
    sendCommand.mockImplementation(async (target, command: string) => {
      if (command === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 9 }],
        };
      }
      if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
      return identityResponse(target, command);
    });
    const cdp = new CdpManager();
    const ref = deepRef(await readDeep(cdp));
    sendCommand.mockClear();

    for (const listener of onEventListeners) listener({ tabId: 7 }, method);

    await expect(cdp.clickDeepRef(7, ref)).rejects.toMatchObject({
      failure: { code: 'stale_ref', phase: 'resolve' },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^(DOM\.getBoxModel|DOM\.focus|Network\.|Input\.)/),
      expect.anything(),
    );
  });

  it.each(['removed', 'replaced', 'loading'])(
    'invalidates deep refs when a tab is %s',
    async (kind) => {
      sendCommand.mockImplementation(async (target, command: string) => {
        if (command === 'Accessibility.getFullAXTree') {
          return {
            nodes: [{ role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 9 }],
          };
        }
        if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
        return identityResponse(target, command);
      });
      const cdp = new CdpManager();
      const ref = deepRef(await readDeep(cdp));
      sendCommand.mockClear();

      if (kind === 'removed') for (const listener of onRemovedListeners) listener(7);
      if (kind === 'replaced') for (const listener of onReplacedListeners) listener(8, 7);
      if (kind === 'loading') {
        for (const listener of onUpdatedListeners) listener(7, { status: 'loading' });
      }

      await expect(cdp.focusDeepRef(7, ref)).rejects.toMatchObject({
        failure: { code: 'stale_ref' },
      });
      expect(sendCommand).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^(DOM\.focus|Input\.)/),
        expect.anything(),
      );
    },
  );

  it('rejects a ref issued by a previous service-worker manager nonce', async () => {
    sendCommand.mockImplementation(async (target, command: string) => {
      if (command === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 9 }],
        };
      }
      if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
      return identityResponse(target, command);
    });
    const firstManager = new CdpManager();
    const ref = deepRef(await readDeep(firstManager));
    const restartedManager = new CdpManager();
    sendCommand.mockClear();

    await expect(restartedManager.clickDeepRef(7, ref)).rejects.toMatchObject({
      failure: { code: 'stale_ref' },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^(DOM\.getBoxModel|DOM\.focus|Network\.|Input\.)/),
      expect.anything(),
    );
  });

  it('fails closed when loader identity changes without a lifecycle event', async () => {
    let loaderId = 'loader-root';
    sendCommand.mockImplementation(async (target, command: string) => {
      if (command === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'frame-root', loaderId } } };
      }
      if (command === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 9 }],
        };
      }
      if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
      return identityResponse(target, command);
    });
    const cdp = new CdpManager();
    const ref = deepRef(await readDeep(cdp));
    loaderId = 'loader-after-navigation';
    sendCommand.mockClear();

    await expect(cdp.clickDeepRef(7, ref)).rejects.toMatchObject({
      failure: { code: 'stale_ref', details: { reason: 'document_identity_changed' } },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^(DOM\.getBoxModel|DOM\.focus|Network\.|Input\.)/),
      expect.anything(),
    );
  });

  it('revalidates document identity after box lookup and before trusted click input', async () => {
    let loaderId = 'loader-root';
    sendCommand.mockImplementation(async (target, command: string) => {
      if (command === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'frame-root', loaderId } } };
      }
      if (command === 'DOM.getDocument') return { root: { backendNodeId: 100 } };
      if (command === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 9 }],
        };
      }
      if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
      if (command === 'DOM.getBoxModel') {
        loaderId = 'loader-after-box';
        return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
      }
      return identityResponse(target, command);
    });
    const cdp = new CdpManager();
    const ref = deepRef(await readDeep(cdp));
    sendCommand.mockClear();

    await expect(cdp.clickDeepRef(7, ref)).rejects.toMatchObject({
      failure: { code: 'stale_ref', details: { reason: 'document_identity_changed' } },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^Input\./),
      expect.anything(),
    );
  });

  it('revalidates document identity after Network.enable and before trusted typing writes', async () => {
    let loaderId = 'loader-root';
    sendCommand.mockImplementation(async (target, command: string) => {
      if (command === 'Page.getFrameTree') {
        return { frameTree: { frame: { id: 'frame-root', loaderId } } };
      }
      if (command === 'DOM.getDocument') return { root: { backendNodeId: 100 } };
      if (command === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 9 }],
        };
      }
      if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
      if (command === 'Network.enable') loaderId = 'loader-after-network-enable';
      return identityResponse(target, command);
    });
    const cdp = new CdpManager();
    const ref = deepRef(await readDeep(cdp));
    sendCommand.mockClear();

    await expect(cdp.typeDeepRef(7, ref, 'Ada')).rejects.toMatchObject({
      failure: { code: 'stale_ref', details: { reason: 'document_identity_changed' } },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^(DOM\.focus|Input\.)/),
      expect.anything(),
    );
  });

  it('rejects a lifecycle change during preparation even when identity reads stay unchanged', async () => {
    sendCommand.mockImplementation(async (target, command: string) => {
      if (command === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 9 }],
        };
      }
      if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
      if (command === 'Network.enable') {
        for (const listener of onEventListeners) {
          listener({ tabId: 7 }, 'Page.frameStartedNavigating', { frameId: 'frame-root' });
        }
      }
      return identityResponse(target, command);
    });
    const cdp = new CdpManager();
    const ref = deepRef(await readDeep(cdp));
    sendCommand.mockClear();

    await expect(cdp.typeDeepRef(7, ref, 'Ada')).rejects.toMatchObject({
      failure: { code: 'stale_ref' },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^(DOM\.focus|Input\.)/),
      expect.anything(),
    );
  });

  it('does not send text when focusing the deep ref starts a navigation', async () => {
    sendCommand.mockImplementation(async (target, command: string) => {
      if (command === 'Accessibility.getFullAXTree') {
        return {
          nodes: [{ role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 9 }],
        };
      }
      if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
      if (command === 'DOM.focus') {
        for (const listener of onEventListeners) {
          listener({ tabId: 7 }, 'Page.frameStartedNavigating', { frameId: 'frame-root' });
        }
      }
      return identityResponse(target, command);
    });
    const cdp = new CdpManager();
    const ref = deepRef(await readDeep(cdp));
    sendCommand.mockClear();

    await expect(cdp.typeDeepRef(7, ref, 'Ada')).rejects.toMatchObject({
      failure: { code: 'stale_ref' },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^Input\./),
      expect.anything(),
    );
  });

  it.each(['frame', 'root-document'] as const)(
    'revalidates %s identity immediately before focusing a deep ref',
    async (identityPart) => {
      let frameReads = 0;
      let documentReads = 0;
      sendCommand.mockImplementation(async (_target, command: string) => {
        if (command === 'Page.getFrameTree') {
          frameReads++;
          const frameId = identityPart === 'frame' && frameReads >= 3 ? 'frame-next' : 'frame-root';
          return { frameTree: { frame: { id: frameId, loaderId: 'loader-root' } } };
        }
        if (command === 'DOM.getDocument') {
          documentReads++;
          const backendNodeId = identityPart === 'root-document' && documentReads >= 3 ? 200 : 100;
          return { root: { backendNodeId } };
        }
        if (command === 'Accessibility.getFullAXTree') {
          return {
            nodes: [{ role: { value: 'textbox' }, name: { value: 'Email' }, backendDOMNodeId: 9 }],
          };
        }
        if (command === 'DOM.getFlattenedDocument') return { nodes: [] };
        return {};
      });
      const cdp = new CdpManager();
      const ref = deepRef(await readDeep(cdp));
      sendCommand.mockClear();

      await expect(cdp.focusDeepRef(7, ref)).rejects.toMatchObject({
        failure: { code: 'stale_ref', details: { reason: 'document_identity_changed' } },
      });
      expect(sendCommand).not.toHaveBeenCalledWith(
        expect.anything(),
        'DOM.focus',
        expect.anything(),
      );
    },
  );

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
    expect(onEventListeners.size).toBe(1);
  });

  it('adds bounded event-listener targets that are absent from the AXTree', async () => {
    sendCommand.mockImplementation(async (target, method: string) => {
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
      return identityResponse(target, method);
    });
    const cdp = new CdpManager();
    await expect(readDeep(cdp)).resolves.toMatch(
      /event-target "Open picker" \[events=click\] \[ref=c[a-z0-9]+_1_1_1\]/i,
    );
  });

  it('keeps recursive auto-attach registration alive for delayed child and grandchild sessions', async () => {
    sendCommand.mockImplementation(
      async (target: { tabId: number; sessionId?: string }, method: string) => {
        if (method === 'Target.setAutoAttach' && !target.sessionId) {
          setTimeout(() => {
            for (const listener of onEventListeners) {
              listener({ tabId: 7 }, 'Target.attachedToTarget', {
                sessionId: 'child-1',
                targetInfo: { type: 'iframe' },
              });
            }
          }, 10);
          return {};
        }
        if (method === 'Target.setAutoAttach' && target.sessionId === 'child-1') {
          setTimeout(() => {
            for (const listener of onEventListeners) {
              listener({ tabId: 7, sessionId: 'child-1' }, 'Target.attachedToTarget', {
                sessionId: 'grandchild-1',
                targetInfo: { type: 'iframe' },
              });
            }
          }, 15);
          return {};
        }
        if (method === 'Accessibility.getFullAXTree') {
          if (target.sessionId === 'grandchild-1') {
            return {
              nodes: [
                {
                  role: { value: 'textbox' },
                  name: { value: 'Grandchild control' },
                  backendDOMNodeId: 89,
                },
              ],
            };
          }
          if (target.sessionId === 'child-1') {
            return {
              nodes: [
                {
                  role: { value: 'button' },
                  name: { value: 'Child control' },
                  backendDOMNodeId: 88,
                },
              ],
            };
          }
          return { nodes: [{ role: { value: 'heading' }, name: { value: 'Root' } }] };
        }
        if (method === 'DOM.getFlattenedDocument') return { nodes: [] };
        return identityResponse(target, method);
      },
    );
    const cdp = new CdpManager();

    const snapshot = await readDeep(cdp, 250);

    expect(snapshot).toContain('button "Child control" [frame=cross-origin]');
    expect(snapshot).toContain('textbox "Grandchild control" [frame=cross-origin]');
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-1' },
      'Target.setAutoAttach',
      expect.anything(),
    );
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'grandchild-1' },
      'Target.setAutoAttach',
      expect.anything(),
    );
    expect(onEventListeners.size).toBe(1);
  });

  it('keeps the child-session tree after a snapshot so later descendants join the next read', async () => {
    let rootAttachCalls = 0;
    sendCommand.mockImplementation(
      async (target: { tabId: number; sessionId?: string }, method: string) => {
        if (method === 'Target.setAutoAttach' && !target.sessionId) {
          rootAttachCalls++;
          if (rootAttachCalls === 1) {
            for (const listener of onEventListeners) {
              listener({ tabId: 7 }, 'Target.attachedToTarget', {
                sessionId: 'child-persistent',
                targetInfo: { type: 'iframe' },
              });
            }
          }
          return {};
        }
        if (method === 'Accessibility.getFullAXTree') {
          if (target.sessionId === 'grandchild-late') {
            return {
              nodes: [
                {
                  role: { value: 'button' },
                  name: { value: 'Late descendant' },
                  backendDOMNodeId: 89,
                },
              ],
            };
          }
          return { nodes: [{ role: { value: 'heading' }, name: { value: 'Existing' } }] };
        }
        if (method === 'DOM.getFlattenedDocument') return { nodes: [] };
        return identityResponse(target, method);
      },
    );
    const cdp = new CdpManager();

    await expect(readDeep(cdp)).resolves.toContain('heading "Existing"');
    for (const listener of onEventListeners) {
      listener({ tabId: 7, sessionId: 'child-persistent' }, 'Target.attachedToTarget', {
        sessionId: 'grandchild-late',
        targetInfo: { type: 'iframe' },
      });
    }
    await Promise.resolve();

    await expect(readDeep(cdp)).resolves.toContain('button "Late descendant"');
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'grandchild-late' },
      'Target.setAutoAttach',
      expect.anything(),
    );
  });

  it('removes detached child-session subtrees before AX enumeration', async () => {
    sendCommand.mockImplementation(
      async (target: { tabId: number; sessionId?: string }, method: string) => {
        if (method === 'Target.setAutoAttach' && !target.sessionId) {
          setTimeout(() => {
            for (const listener of onEventListeners) {
              listener({ tabId: 7 }, 'Target.attachedToTarget', {
                sessionId: 'child-detached',
                targetInfo: { type: 'iframe' },
              });
            }
          }, 5);
          setTimeout(() => {
            for (const listener of onEventListeners) {
              listener({ tabId: 7 }, 'Target.detachedFromTarget', {
                sessionId: 'child-detached',
              });
            }
          }, 20);
          return {};
        }
        if (method === 'Accessibility.getFullAXTree') {
          return target.sessionId
            ? {
                nodes: [
                  {
                    role: { value: 'button' },
                    name: { value: 'Detached child' },
                    backendDOMNodeId: 88,
                  },
                ],
              }
            : { nodes: [{ role: { value: 'heading' }, name: { value: 'Root' } }] };
        }
        if (method === 'DOM.getFlattenedDocument') return { nodes: [] };
        return identityResponse(target, method);
      },
    );
    const cdp = new CdpManager();

    const snapshot = await readDeep(cdp, 200);

    expect(snapshot).not.toContain('Detached child');
    expect(sendCommand).not.toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-detached' },
      'Accessibility.getFullAXTree',
      undefined,
    );
    expect(onEventListeners.size).toBe(1);
  });

  it('drops a detached session from the pending registration barrier', async () => {
    let rootRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      rootRegistrationStarted = resolve;
    });
    sendCommand.mockImplementation(
      async (target: { tabId: number; sessionId?: string }, method: string) => {
        if (method === 'Target.setAutoAttach' && !target.sessionId) {
          for (const listener of onEventListeners) {
            listener({ tabId: 7 }, 'Target.attachedToTarget', {
              sessionId: 'child-pending',
              targetInfo: { type: 'iframe' },
            });
          }
          setTimeout(() => {
            for (const listener of onEventListeners) {
              listener({ tabId: 7 }, 'Target.detachedFromTarget', {
                sessionId: 'child-pending',
              });
            }
          }, 20);
          rootRegistrationStarted();
          return {};
        }
        if (method === 'Target.setAutoAttach' && target.sessionId === 'child-pending') {
          return new Promise(() => undefined);
        }
        if (method === 'Accessibility.getFullAXTree') {
          return { nodes: [{ role: { value: 'heading' }, name: { value: 'Root' } }] };
        }
        if (method === 'DOM.getFlattenedDocument') return { nodes: [] };
        return identityResponse(target, method);
      },
    );
    const cdp = new CdpManager();

    const snapshot = cdp.getDeepAxTree(7);
    await registrationStarted;
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(125);

    await expect(snapshot).resolves.toContain('heading "Root"');
    expect(onEventListeners.size).toBe(1);
    expect(sendCommand).not.toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-pending' },
      'Accessibility.getFullAXTree',
      undefined,
    );
  });

  it('times out recursive registration and removes the temporary child-session listener', async () => {
    sendCommand.mockImplementation(
      async (target: { tabId: number; sessionId?: string }, method: string) => {
        if (method === 'Target.setAutoAttach' && !target.sessionId) {
          for (const listener of onEventListeners) {
            listener({ tabId: 7 }, 'Target.attachedToTarget', {
              sessionId: 'child-stuck',
              targetInfo: { type: 'iframe' },
            });
          }
          return {};
        }
        if (method === 'Target.setAutoAttach' && target.sessionId === 'child-stuck') {
          return new Promise(() => undefined);
        }
        return identityResponse(target, method);
      },
    );
    const cdp = new CdpManager();
    const operation = cdp.getDeepAxTree(7, undefined, Date.now() + 100);
    const rejection = expect(operation).rejects.toMatchObject({
      failure: { code: 'timeout' },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(150);

    await rejection;
    expect(onEventListeners.size).toBe(1);
  });

  it('retries recursive registration after timeout without accepting the late attempt', async () => {
    let rootAttachCalls = 0;
    let childRegistrationCalls = 0;
    let firstRegistrationStarted!: () => void;
    const registrationStarted = new Promise<void>((resolve) => {
      firstRegistrationStarted = resolve;
    });
    let resolveFirstRegistration!: () => void;
    const firstRegistration = new Promise<void>((resolve) => {
      resolveFirstRegistration = resolve;
    });
    sendCommand.mockImplementation(
      async (target: { tabId: number; sessionId?: string }, method: string) => {
        if (method === 'Target.setAutoAttach' && !target.sessionId) {
          rootAttachCalls++;
          if (rootAttachCalls === 1) {
            for (const listener of onEventListeners) {
              listener({ tabId: 7 }, 'Target.attachedToTarget', {
                sessionId: 'child-retry',
                targetInfo: { type: 'iframe' },
              });
            }
          }
          return {};
        }
        if (method === 'Target.setAutoAttach' && target.sessionId === 'child-retry') {
          childRegistrationCalls++;
          if (childRegistrationCalls === 1) {
            firstRegistrationStarted();
            return firstRegistration;
          }
          return {};
        }
        if (method === 'Accessibility.getFullAXTree') {
          return target.sessionId === 'child-retry'
            ? {
                nodes: [
                  {
                    role: { value: 'button' },
                    name: { value: 'Retried child' },
                    backendDOMNodeId: 88,
                  },
                ],
              }
            : { nodes: [{ role: { value: 'heading' }, name: { value: 'Root' } }] };
        }
        if (method === 'DOM.getFlattenedDocument') return { nodes: [] };
        return identityResponse(target, method);
      },
    );
    const cdp = new CdpManager();
    const firstRead = cdp.getDeepAxTree(7, undefined, Date.now() + 100);
    const firstRejection = expect(firstRead).rejects.toMatchObject({
      failure: { code: 'timeout' },
    });
    await registrationStarted;
    await vi.advanceTimersByTimeAsync(150);
    await firstRejection;

    await expect(readDeep(cdp)).resolves.toContain('button "Retried child"');
    expect(childRegistrationCalls).toBe(2);

    resolveFirstRegistration();
    await Promise.resolve();
    await expect(readDeep(cdp)).resolves.toContain('button "Retried child"');
    expect(childRegistrationCalls).toBe(2);
    expect(onEventListeners.size).toBe(1);
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
        return identityResponse(target, method);
      },
    );
    const cdp = new CdpManager();
    const snapshot = await readDeep(cdp);
    const ref = deepRef(snapshot);
    expect(snapshot).toContain(`textbox "Frame email" [frame=cross-origin] [ref=${ref}]`);
    await expect(cdp.getDeepRefCenter(7, ref)).resolves.toEqual({ x: 10, y: 5 });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-1' },
      'DOM.getBoxModel',
      { backendNodeId: 88 },
    );
    const click = cdp.clickDeepRef(7, ref);
    await vi.advanceTimersByTimeAsync(600);
    await expect(click).resolves.toEqual({ settled: true });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-1' },
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed', x: 10, y: 5 }),
    );
    const type = cdp.typeDeepRef(7, ref, 'Ada');
    await vi.advanceTimersByTimeAsync(600);
    await expect(type).resolves.toEqual({ settled: true });
    expect(sendCommand).toHaveBeenCalledWith(
      { tabId: 7, sessionId: 'child-1' },
      'Input.insertText',
      { text: 'Ada' },
    );
  });

  it('fails closed when a child session detaches after box lookup but before click input', async () => {
    sendCommand.mockImplementation(
      async (target: { tabId: number; sessionId?: string }, method: string) => {
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
                    role: { value: 'button' },
                    name: { value: 'Frame action' },
                    backendDOMNodeId: 88,
                  },
                ],
              }
            : { nodes: [] };
        }
        if (method === 'DOM.getFlattenedDocument') return { nodes: [] };
        if (method === 'DOM.getBoxModel') {
          for (const listener of onEventListeners) {
            listener({ tabId: 7, sessionId: 'child-1' }, 'Target.detachedFromTarget', {
              sessionId: 'child-1',
            });
          }
          return { model: { content: [0, 0, 20, 0, 20, 10, 0, 10] } };
        }
        return identityResponse(target, method);
      },
    );
    const cdp = new CdpManager();
    const ref = deepRef(await readDeep(cdp));
    sendCommand.mockClear();

    await expect(cdp.clickDeepRef(7, ref)).rejects.toMatchObject({
      failure: { code: 'stale_ref' },
    });
    expect(sendCommand).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/^Input\./),
      expect.anything(),
    );
  });
});
