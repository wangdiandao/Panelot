import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractionAutomation } from '../../src/engine/interactionAutomation';

type TabUpdatedListener = (tabId: number, changeInfo: { url?: string }) => void;

let tabUpdatedListener: TabUpdatedListener | undefined;
let resolveTabLookup: ((tab: { url?: string }) => void) | undefined;
const alarmsCreate = vi.fn();
const alarmsClear = vi.fn(async () => true);
const addTabListener = vi.fn((listener: TabUpdatedListener) => {
  tabUpdatedListener = listener;
});
const removeTabListener = vi.fn((listener: TabUpdatedListener) => {
  if (tabUpdatedListener === listener) tabUpdatedListener = undefined;
});
const getTab = vi.fn(
  () => new Promise<{ url?: string }>((resolve) => (resolveTabLookup = resolve)),
);

beforeEach(() => {
  vi.clearAllMocks();
  tabUpdatedListener = undefined;
  resolveTabLookup = undefined;
  getTab.mockImplementation(
    () => new Promise<{ url?: string }>((resolve) => (resolveTabLookup = resolve)),
  );
  vi.stubGlobal('chrome', {
    alarms: { create: alarmsCreate, clear: alarmsClear },
    tabs: {
      get: getTab,
      onUpdated: { addListener: addTabListener, removeListener: removeTabListener },
    },
    downloads: {
      search: vi.fn(async () => []),
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
});

describe('InteractionAutomation watcher cleanup', () => {
  it('does not resolve after abort wins the initial URL lookup race', async () => {
    const resolve = vi.fn(async () => undefined);
    const automation = new InteractionAutomation({} as never, resolve);
    automation.handle('thread-1', 'interaction-1', {
      kind: 'watch_page',
      tabId: 7,
      condition: { type: 'url', value: '/done' },
      deadlineAt: Date.now() + 60_000,
    });

    automation.clear('interaction-1');
    resolveTabLookup?.({ url: 'https://example.com/done' });
    await vi.waitFor(() => expect(getTab).toHaveBeenCalledOnce());

    expect(resolve).not.toHaveBeenCalled();
    expect(alarmsClear).toHaveBeenCalledWith('panelot-interaction:interaction-1');
    expect(addTabListener).not.toHaveBeenCalled();
  });

  it('removes a registered URL listener when cleared', async () => {
    getTab.mockResolvedValue({ url: 'https://example.com/pending' });
    const automation = new InteractionAutomation(
      {} as never,
      vi.fn(async () => undefined),
    );
    automation.handle('thread-1', 'interaction-2', {
      kind: 'watch_page',
      tabId: 7,
      condition: { type: 'url', value: '/done' },
      deadlineAt: Date.now() + 60_000,
    });
    await vi.waitFor(() => expect(addTabListener).toHaveBeenCalledOnce());
    const registered = tabUpdatedListener;

    automation.clear('interaction-2');

    expect(registered).toBeDefined();
    expect(removeTabListener).toHaveBeenCalledWith(registered);
    expect(tabUpdatedListener).toBeUndefined();
  });

  it('does not resolve when cleared during the final URL lookup after a match', async () => {
    let finishMatchedLookup: ((tab: { url?: string }) => void) | undefined;
    getTab.mockResolvedValueOnce({ url: 'https://example.com/pending' }).mockImplementationOnce(
      () =>
        new Promise<{ url?: string }>((resolve) => {
          finishMatchedLookup = resolve;
        }),
    );
    const resolve = vi.fn(async () => undefined);
    const automation = new InteractionAutomation({} as never, resolve);
    automation.handle('thread-1', 'interaction-final-lookup', {
      kind: 'watch_page',
      tabId: 7,
      condition: { type: 'url', value: '/done' },
      deadlineAt: Date.now() + 60_000,
    });
    await vi.waitFor(() => expect(addTabListener).toHaveBeenCalledOnce());

    tabUpdatedListener?.(7, { url: 'https://example.com/done' });
    await vi.waitFor(() => expect(getTab).toHaveBeenCalledTimes(2));
    automation.clear('interaction-final-lookup');
    finishMatchedLookup?.({ url: 'https://example.com/done' });
    await Promise.resolve();

    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not recreate an alarm when a stale resolve rejection arrives after clear', async () => {
    let rejectResolve: ((reason?: unknown) => void) | undefined;
    const resolve = vi.fn(() => new Promise<void>((_resolve, reject) => (rejectResolve = reject)));
    const automation = new InteractionAutomation({} as never, resolve);
    automation.handle('thread-1', 'interaction-3', {
      kind: 'schedule',
      resumeAt: Date.now() + 60_000,
      reason: 'retry later',
    });
    expect(automation.handleAlarm('panelot-interaction:interaction-3')).toBe(true);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());

    automation.clear('interaction-3');
    rejectResolve?.(new Error('persistence failed'));
    await Promise.resolve();

    expect(alarmsCreate).toHaveBeenCalledTimes(1);
  });

  it('contains a watcher rejection instead of leaking an unhandled promise', async () => {
    getTab.mockRejectedValueOnce(new Error('tab closed'));
    const automation = new InteractionAutomation(
      {} as never,
      vi.fn(async () => undefined),
    );

    expect(() =>
      automation.handle('thread-1', 'interaction-4', {
        kind: 'watch_page',
        tabId: 7,
        condition: { type: 'url', value: '/done' },
        deadlineAt: Date.now() + 60_000,
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(getTab).toHaveBeenCalledOnce());
  });
});
