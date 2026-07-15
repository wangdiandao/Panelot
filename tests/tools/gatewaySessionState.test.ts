import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_GATEWAY_SESSION_MAX_THREADS,
  BROWSER_GATEWAY_SESSION_STATE_KEY,
  BrowserToolGateway,
} from '../../src/tools/gateway';

class MemorySessionStorage {
  readonly values = new Map<string, unknown>();
  failGet = false;
  failSet = false;

  async get(key: string): Promise<Record<string, unknown>> {
    if (this.failGet) throw new Error('get failed');
    return this.values.has(key) ? { [key]: this.values.get(key) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    if (this.failSet) throw new Error('set failed');
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }
}

interface ChromeHarness {
  tabs: Map<
    number,
    Pick<chrome.tabs.Tab, 'id' | 'url' | 'active' | 'status'> & Partial<chrome.tabs.Tab>
  >;
  removed: Set<(tabId: number) => void>;
  replaced: Set<(addedTabId: number, removedTabId: number) => void>;
}

function installChromeHarness(): ChromeHarness {
  const tabs: ChromeHarness['tabs'] = new Map();
  const removed = new Set<(tabId: number) => void>();
  const replaced = new Set<(addedTabId: number, removedTabId: number) => void>();
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error('no tab');
        return tab;
      }),
      query: vi.fn(async () => [...tabs.values()]),
      onRemoved: { addListener: (listener: (tabId: number) => void) => removed.add(listener) },
      onReplaced: {
        addListener: (listener: (addedTabId: number, removedTabId: number) => void) =>
          replaced.add(listener),
      },
    },
  });
  return { tabs, removed, replaced };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BrowserToolGateway MV3 session state', () => {
  it('restores target, touched, and driven state in a new worker instance', async () => {
    const chromeHarness = installChromeHarness();
    chromeHarness.tabs.set(7, {
      id: 7,
      url: 'https://example.com/page',
      active: true,
      status: 'complete',
    });
    const session = new MemorySessionStorage();
    const first = new BrowserToolGateway(session);
    await first.ready();
    await first.getOperationTab('thread-1', 7);
    first.bindTurnTarget('thread-1', 7);
    first.markDriven('thread-1', 7);
    first.markAgentInput(7, 60_000);
    await first.flushState();

    const second = new BrowserToolGateway(session);
    await second.ready();
    const manualOperations: number[] = [];
    second.onManualOperation = (tabId) => manualOperations.push(tabId);

    expect(second.touchedTabs('thread-1')).toEqual([7]);
    expect(second.droveThisTurn('thread-1', 7)).toBe(true);
    await expect(second.getTargetTab('thread-1')).resolves.toBe(7);
    second.handleManualOperationReport(7);
    expect(manualOperations).toEqual([7]);
    expect(session.values.has(BROWSER_GATEWAY_SESSION_STATE_KEY)).toBe(true);
  });

  it('replays mutations that race an in-flight hydration before persisting', async () => {
    installChromeHarness();
    let releaseGet!: (value: Record<string, unknown>) => void;
    const values = new Map<string, unknown>();
    const storage = {
      get: vi.fn(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            releaseGet = resolve;
          }),
      ),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) values.set(key, value);
      }),
    };
    const gateway = new BrowserToolGateway(storage);
    gateway.bindTurnTarget('thread-new', 9);
    gateway.markDriven('thread-new', 9);

    releaseGet({
      [BROWSER_GATEWAY_SESSION_STATE_KEY]: {
        version: 1,
        target: [],
        submittedTarget: [],
        touched: [['thread-existing', [7]]],
        drivenTabs: [],
      },
    });
    await gateway.ready();
    await gateway.flushState();

    expect(gateway.touchedTabs('thread-existing')).toEqual([7]);
    expect(gateway.droveThisTurn('thread-new', 9)).toBe(true);
    expect(values.get(BROWSER_GATEWAY_SESSION_STATE_KEY)).toMatchObject({
      submittedTarget: [['thread-new', 9]],
      touched: [['thread-existing', [7]]],
      drivenTabs: [['thread-new', [9]]],
    });
  });

  it('migrates live tab identity on replacement and invalidates it on removal', async () => {
    const chromeHarness = installChromeHarness();
    chromeHarness.tabs.set(7, {
      id: 7,
      url: 'https://example.com/page',
      active: true,
      status: 'complete',
    });
    const session = new MemorySessionStorage();
    const gateway = new BrowserToolGateway(session);
    await gateway.ready();
    await gateway.getOperationTab('thread-1', 7);
    gateway.bindTurnTarget('thread-1', 7);
    gateway.markDriven('thread-1', 7);
    gateway.markAgentInput(7, 60_000);

    chromeHarness.tabs.delete(7);
    chromeHarness.tabs.set(8, {
      id: 8,
      url: 'https://example.com/page',
      active: true,
      status: 'complete',
    });
    for (const listener of chromeHarness.replaced) listener(8, 7);
    await gateway.flushState();

    const manualOperations: number[] = [];
    gateway.onManualOperation = (tabId) => manualOperations.push(tabId);
    await expect(gateway.getTargetTab('thread-1')).resolves.toBe(8);
    expect(gateway.touchedTabs('thread-1')).toEqual([8]);
    expect(gateway.droveThisTurn('thread-1', 8)).toBe(true);
    gateway.handleManualOperationReport(8);
    expect(manualOperations).toEqual([]);

    chromeHarness.tabs.delete(8);
    for (const listener of chromeHarness.removed) listener(8);
    await gateway.flushState();

    expect(gateway.touchedTabs('thread-1')).toEqual([]);
    expect(gateway.droveThisTurn('thread-1', 8)).toBe(false);
    expect(session.values.get(BROWSER_GATEWAY_SESSION_STATE_KEY)).toMatchObject({
      touched: [],
      drivenTabs: [],
    });
    await expect(gateway.getTargetTab('thread-1')).rejects.toThrow(/no captured web-page target/i);
  });

  it('keeps its persisted audit snapshot readable at the thread boundary', async () => {
    const chromeHarness = installChromeHarness();
    chromeHarness.tabs.set(7, {
      id: 7,
      url: 'https://example.com/page',
      active: true,
      status: 'complete',
    });
    const session = new MemorySessionStorage();
    const first = new BrowserToolGateway(session);
    for (let index = 0; index <= BROWSER_GATEWAY_SESSION_MAX_THREADS; index++) {
      await first.getOperationTab(`thread-${index}`, 7);
    }
    await first.flushState();

    const state = session.values.get(BROWSER_GATEWAY_SESSION_STATE_KEY) as {
      touched: Array<[string, number[]]>;
    };
    expect(state.touched).toHaveLength(BROWSER_GATEWAY_SESSION_MAX_THREADS);
    expect(state.touched[0]?.[0]).toBe('thread-1');
    expect(state.touched.at(-1)?.[0]).toBe(`thread-${BROWSER_GATEWAY_SESSION_MAX_THREADS}`);

    const restored = new BrowserToolGateway(session);
    await expect(restored.ready()).resolves.toBeUndefined();
    expect(restored.touchedTabs('thread-0')).toEqual([]);
    expect(restored.touchedTabs(`thread-${BROWSER_GATEWAY_SESSION_MAX_THREADS}`)).toEqual([7]);
  });

  it('does not restore routing or audit state after a deleted thread is cleared', async () => {
    const chromeHarness = installChromeHarness();
    chromeHarness.tabs.set(7, {
      id: 7,
      url: 'https://example.com/page',
      active: true,
      status: 'complete',
    });
    const session = new MemorySessionStorage();
    const first = new BrowserToolGateway(session);
    await first.getOperationTab('thread-1', 7);
    first.bindTurnTarget('thread-1', 7);
    first.markDriven('thread-1', 7);
    first.clearThread('thread-1');
    await first.flushState();

    expect(session.values.get(BROWSER_GATEWAY_SESSION_STATE_KEY)).toEqual({
      version: 1,
      target: [],
      submittedTarget: [],
      touched: [],
      drivenTabs: [],
    });
    const restored = new BrowserToolGateway(session);
    await restored.ready();
    expect(restored.touchedTabs('thread-1')).toEqual([]);
    expect(restored.droveThisTurn('thread-1', 7)).toBe(false);
    expect(restored.touchedThreadIds()).toEqual([]);
  });

  it('binds recovered tools only to the durable tab and origin', async () => {
    const chromeHarness = installChromeHarness();
    chromeHarness.tabs.set(7, {
      id: 7,
      url: 'https://example.com/page',
      active: true,
      status: 'complete',
    });
    const gateway = new BrowserToolGateway(new MemorySessionStorage());

    await gateway.bindRecoveredTarget('thread-1', {
      tabId: 7,
      origin: 'https://example.com',
    });
    await expect(gateway.getTargetTab('thread-1')).resolves.toBe(7);
    await expect(
      gateway.bindRecoveredTarget('thread-1', {
        tabId: 7,
        origin: 'https://other.example',
      }),
    ).rejects.toThrow(/different origin/i);
    await expect(
      gateway.bindRecoveredTarget('thread-1', {
        tabId: 99,
        origin: 'https://example.com',
      }),
    ).rejects.toThrow(/no longer open/i);
  });

  it('fails closed for malformed or unavailable session state', async () => {
    installChromeHarness();
    const malformed = new MemorySessionStorage();
    malformed.values.set(BROWSER_GATEWAY_SESSION_STATE_KEY, { version: 1, touched: 'invalid' });
    await expect(new BrowserToolGateway(malformed).ready()).rejects.toThrow(
      /browser session state is unavailable/i,
    );

    const unreadable = new MemorySessionStorage();
    unreadable.failGet = true;
    await expect(new BrowserToolGateway(unreadable).ready()).rejects.toThrow(
      /browser session state is unavailable/i,
    );

    const unwritable = new MemorySessionStorage();
    unwritable.failSet = true;
    const failedMutation = new BrowserToolGateway(unwritable);
    await failedMutation.ready();
    failedMutation.bindTurnTarget('thread-1', 7);
    await expect(failedMutation.flushState()).rejects.toThrow(
      /browser session state is unavailable/i,
    );
  });
});
