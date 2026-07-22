/**
 * BrowserToolGateway (docs/development/architecture.md §5): engine-side router for browser tools.
 * L0 → chrome.tabs API directly; L1 → content script messaging with idempotent
 * injection + one retry; explicit tab routing + touched-tab audit (docs/development/browser-tools.md §6).
 */

import {
  CONTENT_SCRIPT_PROTOCOL,
  CONTENT_SCRIPT_SCHEMA_HASH,
  type ContentScriptExecuteOp,
  type ContentScriptOp,
  type ContentScriptResult,
} from '../messaging/protocol';
import { parseContentScriptResult } from '../messaging/validation';
import type { ExecuteResult } from './content/protocol';
import { ActionError } from './action/errors';
import { actionError } from './action/errors';
import { ActionDeadline, abortedAction, deadlineForTool, waitWithContext } from './action/deadline';
import type { ActionFailure } from './action/types';

export const BROWSER_GATEWAY_SESSION_STATE_KEY = 'panelot_browser_gateway_state_v1';
export const BROWSER_GATEWAY_SESSION_MAX_THREADS = 256;

const BROWSER_GATEWAY_SESSION_MAX_TABS_PER_THREAD = 512;
const BROWSER_GATEWAY_SESSION_MAX_THREAD_ID_LENGTH = 512;

interface SessionStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

interface StoredBrowserGatewayState {
  version: 1;
  target: Array<[threadId: string, tabId: number]>;
  submittedTarget: Array<[threadId: string, tabId: number | null]>;
  touched: Array<[threadId: string, tabIds: number[]]>;
  drivenTabs: Array<[threadId: string, tabIds: number[]]>;
}

interface NewTabWatch {
  sourceTabId: number;
  sourceUrl?: string;
  existingTabIds: Set<number>;
  userWasOnPanelotChat: boolean;
}

function isPanelotChatTab(tab: chrome.tabs.Tab | undefined): boolean {
  const chatUrl = chrome.runtime?.getURL?.('/chat.html');
  return !!chatUrl && (tab?.url === chatUrl || tab?.url?.startsWith(`${chatUrl}?`) === true);
}

function currentSessionStorage(): SessionStorageArea | undefined {
  if (typeof chrome === 'undefined' || !chrome.storage?.session) return undefined;
  return chrome.storage.session as SessionStorageArea;
}

function isTabId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseThreadTabMap(value: unknown): Map<string, number> | undefined {
  if (!Array.isArray(value) || value.length > BROWSER_GATEWAY_SESSION_MAX_THREADS) {
    return undefined;
  }
  const result = new Map<string, number>();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      entry[0].length === 0 ||
      entry[0].length > BROWSER_GATEWAY_SESSION_MAX_THREAD_ID_LENGTH ||
      !isTabId(entry[1])
    ) {
      return undefined;
    }
    result.set(entry[0], entry[1]);
  }
  return result;
}

function parseThreadNullableTabMap(value: unknown): Map<string, number | null> | undefined {
  if (!Array.isArray(value) || value.length > BROWSER_GATEWAY_SESSION_MAX_THREADS) {
    return undefined;
  }
  const result = new Map<string, number | null>();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      entry[0].length === 0 ||
      entry[0].length > BROWSER_GATEWAY_SESSION_MAX_THREAD_ID_LENGTH ||
      (entry[1] !== null && !isTabId(entry[1]))
    ) {
      return undefined;
    }
    result.set(entry[0], entry[1]);
  }
  return result;
}

function parseThreadTabSets(value: unknown): Map<string, Set<number>> | undefined {
  if (!Array.isArray(value) || value.length > BROWSER_GATEWAY_SESSION_MAX_THREADS) {
    return undefined;
  }
  const result = new Map<string, Set<number>>();
  for (const entry of value) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      entry[0].length === 0 ||
      entry[0].length > BROWSER_GATEWAY_SESSION_MAX_THREAD_ID_LENGTH ||
      !Array.isArray(entry[1]) ||
      entry[1].length > BROWSER_GATEWAY_SESSION_MAX_TABS_PER_THREAD ||
      !entry[1].every(isTabId)
    ) {
      return undefined;
    }
    if (entry[1].length > 0) result.set(entry[0], new Set(entry[1]));
  }
  return result;
}

function boundedThreadTabMap(map: Map<string, number>): Array<[string, number]> {
  return [...map]
    .filter(
      ([threadId, tabId]) =>
        threadId.length > 0 &&
        threadId.length <= BROWSER_GATEWAY_SESSION_MAX_THREAD_ID_LENGTH &&
        isTabId(tabId),
    )
    .slice(-BROWSER_GATEWAY_SESSION_MAX_THREADS);
}

function boundedThreadNullableTabMap(
  map: Map<string, number | null>,
): Array<[string, number | null]> {
  return [...map]
    .filter(
      ([threadId, tabId]) =>
        threadId.length > 0 &&
        threadId.length <= BROWSER_GATEWAY_SESSION_MAX_THREAD_ID_LENGTH &&
        (tabId === null || isTabId(tabId)),
    )
    .slice(-BROWSER_GATEWAY_SESSION_MAX_THREADS);
}

function boundedThreadTabSets(map: Map<string, Set<number>>): Array<[string, number[]]> {
  const entries: Array<[string, number[]]> = [];
  for (const [threadId, tabIds] of map) {
    if (threadId.length === 0 || threadId.length > BROWSER_GATEWAY_SESSION_MAX_THREAD_ID_LENGTH) {
      continue;
    }
    const boundedTabIds = [...tabIds]
      .filter(isTabId)
      .slice(-BROWSER_GATEWAY_SESSION_MAX_TABS_PER_THREAD)
      .sort((a, b) => a - b);
    if (boundedTabIds.length > 0) entries.push([threadId, boundedTabIds]);
  }
  return entries.slice(-BROWSER_GATEWAY_SESSION_MAX_THREADS);
}

function parseGatewayState(value: unknown): StoredBrowserGatewayState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const state = value as Partial<StoredBrowserGatewayState>;
  if (state.version !== 1) return undefined;
  const target = parseThreadTabMap(state.target);
  const submittedTarget = parseThreadNullableTabMap(state.submittedTarget);
  const touched = parseThreadTabSets(state.touched);
  const drivenTabs = parseThreadTabSets(state.drivenTabs);
  if (!target || !submittedTarget || !touched || !drivenTabs) return undefined;
  return {
    version: 1,
    target: [...target],
    submittedTarget: [...submittedTarget],
    touched: [...touched].map(([threadId, tabIds]) => [threadId, [...tabIds]]),
    drivenTabs: [...drivenTabs].map(([threadId, tabIds]) => [threadId, [...tabIds]]),
  };
}

/** A response arrived reporting failure — a genuine tool error, not navigation. */
class ToolReportedError extends Error {
  constructor(
    message: string,
    readonly failure?: ActionFailure,
  ) {
    super(message);
  }
}

class ContentProtocolError extends Error {}

/**
 * MAIN-world dialog patch (serialized by chrome.scripting — must be fully
 * self-contained). Dismisses alert/confirm/prompt so a write cannot deadlock
 * while preserving the safe default for decisions, and reports each result
 * through a CustomEvent consumed by the isolated-world executor.
 */
function installDialogInterception(): void {
  const w = window as Window & {
    __panelotDialogScope?: {
      depth: number;
      alert: typeof window.alert;
      confirm: typeof window.confirm;
      prompt: typeof window.prompt;
    };
  };
  if (w.__panelotDialogScope) {
    w.__panelotDialogScope.depth++;
    return;
  }
  const report = (kind: string, message: string, response: string) => {
    document.dispatchEvent(
      new CustomEvent('panelot:dialog', { detail: JSON.stringify({ kind, message, response }) }),
    );
  };
  w.__panelotDialogScope = {
    depth: 1,
    alert: window.alert,
    confirm: window.confirm,
    prompt: window.prompt,
  };
  window.alert = (message?: unknown) => {
    report('alert', String(message ?? ''), '已关闭');
  };
  window.confirm = (message?: unknown) => {
    report('confirm', String(message ?? ''), '已自动取消（false）');
    return false;
  };
  window.prompt = (message?: unknown, _default?: string) => {
    report('prompt', String(message ?? ''), '已自动取消（null）');
    return null;
  };
}

function restoreDialogInterception(): void {
  const w = window as Window & {
    __panelotDialogScope?: {
      depth: number;
      alert: typeof window.alert;
      confirm: typeof window.confirm;
      prompt: typeof window.prompt;
    };
  };
  const scope = w.__panelotDialogScope;
  if (!scope) return;
  scope.depth--;
  if (scope.depth > 0) return;
  window.alert = scope.alert;
  window.confirm = scope.confirm;
  window.prompt = scope.prompt;
  delete w.__panelotDialogScope;
}

/** Poll until the tab finishes loading (shared by navigation tools & gateway). */
export async function waitForTabLoad(
  tabId: number,
  timeoutMs = 15_000,
  signal?: AbortSignal,
  deadlineAt = Date.now() + timeoutMs,
): Promise<boolean> {
  const deadline = new ActionDeadline(timeoutMs, signal, deadlineAt);
  for (;;) {
    deadline.throwIfDone();
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return true;
    } catch {
      return false; // tab gone
    }
    await waitWithContext(Math.min(200, deadline.remaining()), { signal, deadlineAt });
  }
}

export class BrowserToolGateway {
  /**
   * Browser-level control model (2026-07-06): the agent may target ANY tab —
   * the safety gates are write approvals + the sensitive-origin blacklist
   * (docs/development/permissions.md), not tab membership. Per thread we keep:
   *  - fallback target: the submission-captured web tab used when a call omits
   *    tabId. It stays fixed during one turn; a legacy call without captured
   *    context resolves the most recently visible web tab once.
   *  - touched: audit trail of tabs the agent has operated on — drives the
   *    task-panel display, never a permission boundary.
   */
  #target = new Map<string, number>();
  /** Submission-captured fallback; null means the turn had no scriptable page identity. */
  #submittedTarget = new Map<string, number | null>();
  #touched = new Map<string, Set<number>>();
  /**
   * tabId → timestamp until which trusted input on that tab is the AGENT's
   * own doing (CDP Input.dispatch*). The content script cannot tell CDP
   * events from user events — both are isTrusted — so the engine, which
   * knows when it is dispatching, drops manual-operation reports inside
   * this window. Without it every press_key/click_xy pauses its own turn.
   */
  #agentInputUntil = new Map<number, number>();
  /**
   * threadId → tabs the agent has WRITTEN to in the current turn. The
   * manual-operation auto-pause only fires for these: a turn that merely
   * READS the page (Q&A about the user's own tab) must not pause when the
   * user scrolls or clicks their own page mid-answer.
   */
  #drivenTabs = new Map<string, Set<number>>();
  /** Same-tab L1 requests are serialized across threads and request owners. */
  #tabQueues = new Map<number, Promise<void>>();
  #sessionStorage: SessionStorageArea | undefined;
  #stateReady: Promise<void>;
  #mutationTail = Promise.resolve();
  #stateError: Error | undefined;
  #hydrated = false;
  #pendingHydrationMutations: Array<() => void> = [];
  /** Called when the user manually operates a page the agent is driving. */
  onManualOperation: (tabId: number) => void = () => {};
  /** Called after a thread's touched set changes so runtime state can be broadcast. */
  onTabsChanged: (threadId: string) => void = () => {};

  constructor(
    sessionStorage: SessionStorageArea | undefined = currentSessionStorage(),
    listenForTabLifecycle = true,
  ) {
    this.#sessionStorage = sessionStorage;
    this.#stateReady = this.#hydrateSessionState().catch((error: unknown) => {
      this.#clearInMemoryState();
      this.#stateError = new Error('Browser session state is unavailable', { cause: error });
      this.#hydrated = true;
      this.#pendingHydrationMutations = [];
    });
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
        if (
          (msg as { type?: string })?.type === 'panelot.manualOperation' &&
          sender.tab?.id !== undefined
        ) {
          this.handleManualOperationReport(sender.tab.id);
        }
      });
    }
    if (listenForTabLifecycle && typeof chrome !== 'undefined') {
      chrome.tabs?.onRemoved?.addListener((tabId) => this.handleTabRemoved(tabId));
      chrome.tabs?.onReplaced?.addListener((addedTabId, removedTabId) =>
        this.handleTabReplaced(addedTabId, removedTabId),
      );
    }
  }

  async ready(): Promise<void> {
    await this.#stateReady;
    if (this.#stateError) throw this.#stateError;
  }

  async flushState(): Promise<void> {
    await this.ready();
    await this.#mutationTail;
    if (this.#stateError) throw this.#stateError;
  }

  #clearInMemoryState(): void {
    this.#target.clear();
    this.#submittedTarget.clear();
    this.#touched.clear();
    this.#agentInputUntil.clear();
    this.#drivenTabs.clear();
  }

  async #hydrateSessionState(): Promise<void> {
    if (this.#sessionStorage) {
      const stored = await this.#sessionStorage.get(BROWSER_GATEWAY_SESSION_STATE_KEY);
      const rawState = stored[BROWSER_GATEWAY_SESSION_STATE_KEY];
      const state = parseGatewayState(rawState);
      if (rawState !== undefined && !state) throw new Error('Invalid browser session state');
      this.#clearInMemoryState();
      if (state) {
        this.#target = new Map(state.target);
        this.#submittedTarget = new Map(state.submittedTarget);
        this.#touched = new Map(
          state.touched.map(([threadId, tabIds]) => [threadId, new Set(tabIds)]),
        );
        this.#drivenTabs = new Map(
          state.drivenTabs.map(([threadId, tabIds]) => [threadId, new Set(tabIds)]),
        );
      }
    }
    for (const mutation of this.#pendingHydrationMutations) mutation();
    this.#pendingHydrationMutations = [];
    this.#hydrated = true;
  }

  #mutateState(mutation: () => void): void {
    mutation();
    this.#compactInMemoryState();
    if (!this.#hydrated) {
      this.#pendingHydrationMutations.push(() => {
        mutation();
        this.#compactInMemoryState();
      });
    }
    this.#schedulePersist();
  }

  #compactInMemoryState(): void {
    this.#target = new Map(boundedThreadTabMap(this.#target));
    this.#submittedTarget = new Map(boundedThreadNullableTabMap(this.#submittedTarget));
    this.#touched = new Map(
      boundedThreadTabSets(this.#touched).map(([threadId, tabIds]) => [threadId, new Set(tabIds)]),
    );
    this.#drivenTabs = new Map(
      boundedThreadTabSets(this.#drivenTabs).map(([threadId, tabIds]) => [
        threadId,
        new Set(tabIds),
      ]),
    );
  }

  #schedulePersist(): void {
    const sessionStorage = this.#sessionStorage;
    if (!sessionStorage) return;
    const operation = this.#mutationTail.then(async () => {
      await this.ready();
      const state: StoredBrowserGatewayState = {
        version: 1,
        target: boundedThreadTabMap(this.#target),
        submittedTarget: boundedThreadNullableTabMap(this.#submittedTarget),
        touched: boundedThreadTabSets(this.#touched),
        drivenTabs: boundedThreadTabSets(this.#drivenTabs),
      };
      await sessionStorage.set({ [BROWSER_GATEWAY_SESSION_STATE_KEY]: state });
    });
    this.#mutationTail = operation.catch((error: unknown) => {
      this.#stateError = new Error('Browser session state is unavailable', { cause: error });
    });
  }

  handleTabRemoved(tabId: number): void {
    const changedThreads: string[] = [];
    this.#mutateState(() => {
      for (const [threadId, set] of this.#touched) {
        if (set.delete(tabId)) {
          changedThreads.push(threadId);
          if (set.size === 0) this.#touched.delete(threadId);
        }
      }
      for (const [threadId, targetTabId] of this.#target) {
        if (targetTabId === tabId) this.#target.delete(threadId);
      }
      for (const [threadId, submittedTabId] of this.#submittedTarget) {
        if (submittedTabId === tabId) this.#submittedTarget.set(threadId, null);
      }
      for (const [threadId, set] of this.#drivenTabs) {
        if (set.delete(tabId) && set.size === 0) this.#drivenTabs.delete(threadId);
      }
      this.#agentInputUntil.delete(tabId);
      this.#tabQueues.delete(tabId);
    });
    for (const threadId of new Set(changedThreads)) this.onTabsChanged(threadId);
  }

  handleTabReplaced(addedTabId: number, removedTabId: number): void {
    const changedThreads: string[] = [];
    this.#mutateState(() => {
      for (const [threadId, targetTabId] of this.#target) {
        if (targetTabId === removedTabId) this.#target.set(threadId, addedTabId);
      }
      for (const [threadId, submittedTabId] of this.#submittedTarget) {
        if (submittedTabId === removedTabId) this.#submittedTarget.set(threadId, addedTabId);
      }
      for (const [threadId, set] of this.#touched) {
        if (set.delete(removedTabId)) {
          set.add(addedTabId);
          changedThreads.push(threadId);
        }
      }
      for (const set of this.#drivenTabs.values()) {
        if (set.delete(removedTabId)) set.add(addedTabId);
      }
      const agentInputDeadline = this.#agentInputUntil.get(removedTabId);
      if (agentInputDeadline !== undefined) {
        this.#agentInputUntil.delete(removedTabId);
        this.#agentInputUntil.set(
          addedTabId,
          Math.max(agentInputDeadline, this.#agentInputUntil.get(addedTabId) ?? 0),
        );
      }
      this.#tabQueues.delete(removedTabId);
    });
    for (const threadId of new Set(changedThreads)) this.onTabsChanged(threadId);
  }

  // ---- target & audit trail (docs/development/browser-tools.md §6) -------------------------------------

  /** Tabs the agent has operated on this thread (audit display, not permission). */
  touchedTabs(threadId: string): number[] {
    return [...(this.#touched.get(threadId) ?? [])];
  }

  touchedThreadIds(): string[] {
    return [...this.#touched.keys()];
  }

  clearThread(threadId: string): void {
    let touchedChanged = false;
    this.#mutateState(() => {
      this.#target.delete(threadId);
      this.#submittedTarget.delete(threadId);
      touchedChanged = this.#touched.delete(threadId) || touchedChanged;
      this.#drivenTabs.delete(threadId);
    });
    if (touchedChanged) this.onTabsChanged(threadId);
  }

  /**
   * The tab the USER is looking at (active tab of the last focused window).
   * Distinct from any explicit operation tab. Tool results compare visible
   * state against this tab so the model does not invent a foreground change.
   */
  async getUserActiveTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
  }

  /**
   * Declare that the agent is about to dispatch trusted (CDP) input on a tab:
   * manual-operation reports from that tab are suppressed for `durationMs`.
   * Call before dispatch because the report races the dispatch's completion.
   */
  markAgentInput(tabId: number, durationMs = 1500): void {
    const expiresAt = Date.now() + durationMs;
    this.#agentInputUntil.set(tabId, expiresAt);
  }

  /** Content-script manual-op report → drop the agent's own CDP input. */
  handleManualOperationReport(tabId: number): void {
    const until = this.#agentInputUntil.get(tabId) ?? 0;
    if (Date.now() < until) return;
    this.onManualOperation(tabId);
  }

  /** Record that the agent performed a WRITE on the tab this turn. */
  markDriven(threadId: string, tabId: number): void {
    this.#mutateState(() => {
      let set = this.#drivenTabs.get(threadId);
      if (!set) {
        set = new Set();
        this.#drivenTabs.set(threadId, set);
      }
      set.add(tabId);
    });
  }

  /** Has the agent written to this tab in the current turn? */
  droveThisTurn(threadId: string, tabId: number): boolean {
    return this.#drivenTabs.get(threadId)?.has(tabId) ?? false;
  }

  /** Drop the fallback target when it closes or becomes unusable. */
  clearTarget(threadId: string, tabId?: number): void {
    this.#mutateState(() => {
      const targetTabId = this.#target.get(threadId);
      if (targetTabId !== undefined && (tabId === undefined || targetTabId === tabId)) {
        this.#target.delete(threadId);
      }
    });
  }

  /**
   * Turn boundary hook: the fallback is released so the next call without an
   * explicit tabId follows the user again. Explicitly routed calls never write
   * this state. The driven-tab set also resets at the turn boundary.
   */
  releaseFloatingTarget(threadId: string): void {
    this.#mutateState(() => {
      this.#target.delete(threadId);
      this.#submittedTarget.delete(threadId);
      this.#drivenTabs.delete(threadId);
    });
  }

  /** Freeze omitted-tab tool calls to the identity captured when the user submitted. */
  bindTurnTarget(threadId: string, tabId?: number): void {
    this.#mutateState(() => {
      this.#target.delete(threadId);
      this.#submittedTarget.set(threadId, tabId ?? null);
      this.#drivenTabs.delete(threadId);
    });
  }

  async bindRecoveredTarget(
    threadId: string,
    target?: { tabId?: number; origin?: string },
  ): Promise<void> {
    await this.ready();
    if (target?.tabId === undefined) return;
    const tab = await chrome.tabs.get(target.tabId).catch(() => undefined);
    if (!tab?.url || !/^https?:/.test(tab.url)) {
      throw new Error(`The recovered target tab [${target.tabId}] is no longer open.`);
    }
    if (target.origin && new URL(tab.url).origin !== target.origin) {
      throw new Error('The recovered target tab navigated to a different origin.');
    }
    this.bindTurnTarget(threadId, target.tabId);
  }

  #markTouched(threadId: string, tabId: number): void {
    let changed = false;
    this.#mutateState(() => {
      let set = this.#touched.get(threadId);
      if (!set) {
        set = new Set();
        this.#touched.set(threadId, set);
      }
      if (!set.has(tabId)) {
        set.add(tabId);
        changed = true;
      }
    });
    if (changed) this.onTabsChanged(threadId);
  }

  async getTargetTab(threadId: string): Promise<number> {
    await this.ready();
    if (this.#submittedTarget.has(threadId)) {
      const submitted = this.#submittedTarget.get(threadId);
      if (submitted === null || submitted === undefined) {
        throw new Error('This turn has no captured web-page target. Submit again from a web page.');
      }
      let tab: chrome.tabs.Tab;
      try {
        tab = await chrome.tabs.get(submitted);
      } catch {
        throw new Error(`The submitted target tab [${submitted}] is no longer open.`);
      }
      if (!tab.url || !/^https?:/.test(tab.url)) {
        throw new Error(
          `The submitted target tab [${submitted}] is no longer an operable http(s) page.`,
        );
      }
      this.#markTouched(threadId, submitted);
      return submitted;
    }
    const existing = this.#target.get(threadId);
    if (existing !== undefined) {
      try {
        await chrome.tabs.get(existing);
        return existing;
      } catch {
        this.clearTarget(threadId, existing);
      }
    }
    // No target yet this turn → the tab the user is looking at. Only http(s)
    // pages qualify: when the conversation runs in the extension's own
    // full-page tab, THAT tab is the active one in the current window —
    // targeting it would hit the chrome-extension://* sensitive blacklist.
    // Look across windows for the most recently used active web page.
    const activeTabs = await chrome.tabs.query({ active: true });
    const webTabs = activeTabs
      .filter(
        (t): t is chrome.tabs.Tab & { id: number; url: string } =>
          t.id !== undefined && !!t.url && /^https?:/.test(t.url),
      )
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const tab = webTabs[0];
    if (!tab)
      throw new Error(
        '没有可操作的网页标签页，扩展自身页面不能作为操作目标。请先用 tab_open 打开页面，或激活一个网页标签页。',
      );
    // Unpinned: locked for this turn, released at turn end (see
    // releaseFloatingTarget) so the next turn follows the user again.
    this.#mutateState(() => this.#target.set(threadId, tab.id));
    this.#markTouched(threadId, tab.id);
    return tab.id;
  }

  /** Resolve an explicit per-call tab without changing the fallback target. */
  async getOperationTab(threadId: string, requestedTabId?: number): Promise<number> {
    await this.ready();
    if (requestedTabId === undefined) return this.getTargetTab(threadId);
    const tab = await chrome.tabs.get(requestedTabId);
    if (!tab.url || !/^https?:/.test(tab.url)) {
      throw new Error(`标签页 [${requestedTabId}] 不是可操作的 HTTP(S) 网页。`);
    }
    this.#markTouched(threadId, requestedTabId);
    return requestedTabId;
  }

  async getTabOrigin(threadId: string, requestedTabId?: number): Promise<string> {
    try {
      const tabId = await this.getOperationTab(threadId, requestedTabId);
      const tab = await chrome.tabs.get(tabId);
      return tab.url ? new URL(tab.url).origin : '';
    } catch {
      return '';
    }
  }

  // ---- L1 dispatch (docs/development/architecture.md §5) ----------------------------------------------

  /** L1 write tools: user input on the tab during these = a real conflict. */
  static #WRITE_CONTENT_TOOLS = new Set([
    'click',
    'type',
    'select_option',
    'press_key',
    'hover',
    'batch_actions',
    'upload',
  ]);

  static #MAY_OPEN_NEW_TAB = new Set([
    'click',
    'type',
    'select_option',
    'press_key',
    'batch_actions',
  ]);

  #withTabQueue<T>(
    tabId: number,
    signal: AbortSignal | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tabQueues.get(tabId) ?? Promise.resolve();
    let started = false;
    const run = previous.then(async () => {
      if (signal?.aborted) throw abortedAction('execute', { dispatched: false });
      started = true;
      return task();
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.#tabQueues.set(tabId, tail);
    void tail.finally(() => {
      if (this.#tabQueues.get(tabId) === tail) this.#tabQueues.delete(tabId);
    });
    if (!signal) return run;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        if (!started) finish(() => reject(abortedAction('execute', { dispatched: false })));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      void run.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  async callContentTool(
    threadId: string,
    tool: string,
    params: unknown,
    requestedTabId?: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool(tool, params),
  ): Promise<ExecuteResult> {
    const tabId = await this.getOperationTab(threadId, requestedTabId);
    const mayWrite = BrowserToolGateway.#WRITE_CONTENT_TOOLS.has(tool);
    return this.#withTabQueue(tabId, signal, async () => {
      new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
      await this.#ensureInjected(tabId, signal, deadlineAt);

      if (!mayWrite) {
        return this.#sendToTab(tabId, tool, params, signal, deadlineAt, false);
      }

      await this.#installDialogInterception(tabId, signal, deadlineAt);
      this.markDriven(threadId, tabId);

      let result: ExecuteResult | undefined;
      let executionCompleted = false;
      let executionError: unknown;
      try {
        result = await this.#sendToTab(tabId, tool, params, signal, deadlineAt, true, threadId);
        executionCompleted = true;
      } catch (error) {
        executionError = error;
      }

      try {
        await this.#restoreDialogInterception(tabId);
      } catch (restoreError) {
        if (!executionCompleted) {
          throw actionError(
            'safety_boundary_unavailable',
            '页面写操作失败，且无法确认对话框安全边界已恢复。请重新加载页面后再继续。',
            'recover',
            false,
            {
              stage: 'restore',
              tabId,
              dispatched: true,
              effectMayHaveOccurred: true,
              dialogInterceptionMayRemain: true,
              actionFailure:
                executionError instanceof ActionError
                  ? executionError.failure
                  : executionError instanceof Error
                    ? executionError.message
                    : String(executionError),
              restoreFailure:
                restoreError instanceof ActionError
                  ? restoreError.failure
                  : restoreError instanceof Error
                    ? restoreError.message
                    : String(restoreError),
            },
          );
        }
        throw restoreError;
      }

      if (!executionCompleted) throw executionError;
      if (!result) throw new Error('content script completed without a result');
      return result;
    });
  }

  async getElementRect(
    threadId: string,
    ref: string,
    requestedTabId?: number,
    coordinateSpace: 'document' | 'viewport' = 'document',
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('get_rect', { ref }),
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const result = await this.callContentTool(
      threadId,
      'get_rect',
      { ref, coordinateSpace },
      requestedTabId,
      signal,
      deadlineAt,
    );
    if (!result.rect) throw new Error(`Element ${ref} has no visible bounds`);
    return result.rect;
  }

  async #sendToTab(
    tabId: number,
    tool: string,
    params: unknown,
    signal: AbortSignal | undefined,
    deadlineAt: number,
    mayWrite: boolean,
    threadId?: string,
    existingNewTabWatch?: NewTabWatch,
    retried = false,
  ): Promise<ExecuteResult> {
    const newTabWatch =
      existingNewTabWatch ??
      (threadId && BrowserToolGateway.#MAY_OPEN_NEW_TAB.has(tool)
        ? await this.#beginNewTabWatch(tabId)
        : undefined);
    const op: ContentScriptExecuteOp = {
      protocol: CONTENT_SCRIPT_PROTOCOL,
      schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
      kind: 'execute',
      requestId: crypto.randomUUID(),
      tool,
      params,
      deadlineAt,
    };
    const urlBefore = await chrome.tabs
      .get(tabId)
      .then((t) => t.url)
      .catch(() => undefined);
    try {
      const result = await this.#sendContentRequest(tabId, op, signal, deadlineAt, mayWrite);
      if (!result) throw new Error('content script 无响应');
      if (result.requestId !== op.requestId)
        throw new ContentProtocolError('content script response requestId mismatch');
      // A response ARRIVED reporting failure (stale ref, element not found):
      // that's a genuine tool error, never navigation. Mark it so the catch
      // below doesn't reframe it as a successful page change.
      if (!result.ok) throw new ToolReportedError(result.error, result.failure);
      const createdTab = newTabWatch ? await this.#findCreatedChildTab(newTabWatch) : undefined;
      if (createdTab && threadId && newTabWatch) {
        return this.#createdTabResult(threadId, newTabWatch, createdTab, signal, deadlineAt);
      }
      if (typeof result.result === 'string') {
        throw new ContentProtocolError(
          `content script returned ${result.result} for an execute request`,
        );
      }
      return result.result;
    } catch (e) {
      if (e instanceof ToolReportedError) {
        if (e.failure) throw new ActionError(e.failure);
        throw new Error(e.message);
      }
      if (e instanceof ContentProtocolError) throw e;
      if (e instanceof ActionError) throw e;
      const message = (e as Error).message ?? String(e);
      const createdTab = newTabWatch ? await this.#findCreatedChildTab(newTabWatch) : undefined;
      if (createdTab && threadId && newTabWatch) {
        return this.#createdTabResult(threadId, newTabWatch, createdTab, signal, deadlineAt);
      }
      // No response arrived (timeout / torn-down channel). The action may have
      // navigated the page — the content script gets destroyed mid-call, so
      // the reply never comes. A real navigation succeeded; reporting it as an
      // error teaches the model to retry (double-submit). Confirmed only by an
      // actual URL change.
      const nav = await this.#detectNavigation(tabId, urlBefore, signal, deadlineAt);
      if (nav) return nav;
      const channelUnavailable = /Receiving end|Could not establish|message channel closed/i.test(
        message,
      );
      // Reads are safe to replay after reinjection. A write has already crossed the
      // message boundary, so a missing reply is ambiguous even when the URL stayed put.
      if (!mayWrite && !retried && channelUnavailable) {
        await this.#inject(tabId, signal, deadlineAt);
        return this.#sendToTab(
          tabId,
          tool,
          params,
          signal,
          deadlineAt,
          mayWrite,
          threadId,
          newTabWatch,
          true,
        );
      }
      if (mayWrite && channelUnavailable) {
        throw actionError(
          'navigation_uncertain',
          '页面写操作已派发，但内容脚本通道在回复前断开。操作可能已生效；请先检查当前页面，不要盲目重试。',
          'settle',
          false,
          { tabId, dispatched: true, effectMayHaveOccurred: true, channelUnavailable: true },
        );
      }
      throw e;
    }
  }

  async #beginNewTabWatch(sourceTabId: number): Promise<NewTabWatch> {
    const [tabs, source, userTab] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabs.get(sourceTabId).catch(() => undefined),
      this.getUserActiveTab().catch(() => undefined),
    ]);
    return {
      sourceTabId,
      sourceUrl: source?.url,
      existingTabIds: new Set(tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]))),
      userWasOnPanelotChat: isPanelotChatTab(userTab),
    };
  }

  async runWithNewTabCapture<T>(
    threadId: string,
    sourceTabId: number,
    action: () => Promise<T>,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('click', {}),
  ): Promise<{ value: T; createdTabResult?: ExecuteResult }> {
    return this.#withTabQueue(sourceTabId, signal, async () => {
      const watch = await this.#beginNewTabWatch(sourceTabId);
      const value = await action();
      const createdTab = await this.#findCreatedChildTab(watch);
      return {
        value,
        ...(createdTab
          ? {
              createdTabResult: await this.#createdTabResult(
                threadId,
                watch,
                createdTab,
                signal,
                deadlineAt,
              ),
            }
          : {}),
      };
    });
  }

  async #findCreatedChildTab(
    watch: NewTabWatch,
  ): Promise<(chrome.tabs.Tab & { id: number }) | undefined> {
    const tabs = await chrome.tabs.query({});
    return tabs
      .filter(
        (tab): tab is chrome.tabs.Tab & { id: number } =>
          tab.id !== undefined &&
          !watch.existingTabIds.has(tab.id) &&
          tab.openerTabId === watch.sourceTabId,
      )
      .sort((a, b) => Number(b.active) - Number(a.active) || b.id - a.id)[0];
  }

  async #createdTabResult(
    threadId: string,
    watch: NewTabWatch,
    createdTab: chrome.tabs.Tab & { id: number },
    signal: AbortSignal | undefined,
    deadlineAt: number,
  ): Promise<ExecuteResult> {
    const tabId = createdTab.id;
    let adoptedAsDefault = false;
    this.#mutateState(() => {
      if (this.#submittedTarget.get(threadId) === watch.sourceTabId) {
        this.#submittedTarget.set(threadId, tabId);
        adoptedAsDefault = true;
      }
      if (this.#target.get(threadId) === watch.sourceTabId) {
        this.#target.set(threadId, tabId);
        adoptedAsDefault = true;
      }
    });
    this.#markTouched(threadId, tabId);
    this.markDriven(threadId, tabId);

    let userViewFocused = false;
    if (watch.userWasOnPanelotChat) {
      try {
        await chrome.tabs.update(tabId, { active: true });
        if (createdTab.windowId !== undefined && chrome.windows?.update) {
          await chrome.windows.update(createdTab.windowId, { focused: true });
        }
        userViewFocused = true;
      } catch {
        // The tab may have been closed between creation and foreground handoff.
      }
    }

    if (createdTab.status === 'loading') {
      await waitForTabLoad(tabId, 5_000, signal, deadlineAt).catch(() => {});
    }
    const loaded = await chrome.tabs.get(tabId).catch(() => createdTab);
    let snapshot: string | undefined;
    try {
      await this.#ensureInjected(tabId, signal, deadlineAt);
      snapshot = (
        await this.#sendToTabRaw(tabId, 'read_page', { maxTokens: 1500 }, signal, deadlineAt)
      ).resultText;
    } catch {
      // The verified tab creation is still useful when the destination cannot be injected.
    }

    const destination = loaded.url ?? createdTab.pendingUrl ?? '目标页面';
    return {
      resultTabId: tabId,
      resultText: `链接已在新标签页打开：${destination}${loaded.title ? `（${loaded.title}）` : ''}。原标签页 [tabId=${watch.sourceTabId}] 保持不变；${adoptedAsDefault ? '后续未指定 tabId 的页面操作将接续当前新标签页。' : `后续操作该页面时请使用 tabId=${tabId}。`}${userViewFocused ? '已从 Panelot 对话页切换到该标签页。' : ''}`,
      snapshot,
      pageStabilized: loaded.status === 'complete',
      evidence: {
        attemptId: crypto.randomUUID(),
        urlBefore: watch.sourceUrl,
        urlAfter: loaded.url,
        attempts: [],
        effectState: 'verified',
        observedEffects: ['tab_created'],
        outcome: 'verified',
      },
    };
  }

  #sendContentRequest(
    tabId: number,
    op: Extract<ContentScriptOp, { kind: 'execute' }>,
    signal: AbortSignal | undefined,
    deadlineAt: number,
    mayWrite: boolean,
  ): Promise<ContentScriptResult> {
    return new Promise<ContentScriptResult>((resolve, reject) => {
      let settled = false;
      const cancel = () => {
        const cancelOp: ContentScriptOp = {
          protocol: CONTENT_SCRIPT_PROTOCOL,
          schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
          kind: 'cancel',
          requestId: crypto.randomUUID(),
          cancelRequestId: op.requestId,
        };
        void chrome.tabs.sendMessage(tabId, cancelOp).catch(() => {});
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        cancel();
        finish(() =>
          reject(
            abortedAction('execute', {
              dispatched: true,
              ...(mayWrite ? { effectMayHaveOccurred: true } : {}),
            }),
          ),
        );
      };
      const remaining = Math.max(0, deadlineAt - Date.now());
      const timer = setTimeout(() => {
        cancel();
        finish(() =>
          reject(
            actionError('timeout', '工具执行超时（超过总截止时间）。', 'settle', true, {
              dispatched: true,
              ...(mayWrite ? { effectMayHaveOccurred: true } : {}),
            }),
          ),
        );
      }, remaining);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      void (chrome.tabs.sendMessage(tabId, op) as Promise<unknown>).then(
        (raw) =>
          finish(() => {
            const parsed = parseContentScriptResult(raw);
            if (!parsed.ok) {
              reject(
                new ContentProtocolError(`Invalid content-script response: ${parsed.diagnostic}`),
              );
              return;
            }
            resolve(parsed.value);
          }),
        (error) => finish(() => reject(error)),
      );
    });
  }

  /**
   * Navigation is confirmed only by an actual URL change (a same-URL timeout
   * is a genuine failure, not a navigation). Waits for load, re-injects, and
   * returns a neutral success result with a fresh snapshot.
   */
  async #detectNavigation(
    tabId: number,
    urlBefore: string | undefined,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('navigate', {}),
  ): Promise<ExecuteResult | null> {
    if (urlBefore === undefined) return null;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null; // tab closed — let the original error propagate
    }
    if (tab.url === urlBefore) return null; // no URL change → not a navigation

    await waitForTabLoad(tabId, 15_000, signal, deadlineAt);
    const loaded = await chrome.tabs.get(tabId).catch(() => null);
    if (!loaded) return null;
    // Fresh page → fresh content script → fresh snapshot for the model.
    let snapshot: string | undefined;
    try {
      await this.#inject(tabId, signal, deadlineAt);
      const snap = await this.#sendToTabRaw(
        tabId,
        'read_page',
        { maxTokens: 1500 },
        signal,
        deadlineAt,
      );
      snapshot = snap.resultText;
    } catch {
      /* snapshot is best-effort; the navigation report alone is still true */
    }
    return {
      resultText: `页面已跳转到 ${loaded.url}${loaded.title ? `（${loaded.title}）` : ''}。旧 ref 已全部失效，需要交互时先 read_page。`,
      snapshot,
      pageStabilized: true,
      evidence: {
        attemptId: crypto.randomUUID(),
        urlBefore,
        urlAfter: loaded.url,
        attempts: [],
        effectState: 'verified',
        observedEffects: ['url_changed'],
        outcome: 'verified',
      },
    };
  }

  /** Single send without navigation detection (used inside detectNavigation). */
  async #sendToTabRaw(
    tabId: number,
    tool: string,
    params: unknown,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool(tool, params),
  ): Promise<ExecuteResult> {
    const op: ContentScriptExecuteOp = {
      protocol: CONTENT_SCRIPT_PROTOCOL,
      schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
      kind: 'execute',
      requestId: crypto.randomUUID(),
      tool,
      params,
      deadlineAt,
    };
    const result = await this.#sendContentRequest(tabId, op, signal, deadlineAt, false);
    if (!result.ok) throw new Error(result.error);
    if (typeof result.result === 'string') {
      throw new ContentProtocolError(
        `content script returned ${result.result} for an execute request`,
      );
    }
    return result.result;
  }

  async #ensureInjected(
    tabId: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('__ping', {}),
  ): Promise<void> {
    new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
    try {
      const ping: ContentScriptOp = {
        protocol: CONTENT_SCRIPT_PROTOCOL,
        schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
        kind: 'ping',
        requestId: 'ping',
      };
      const pong = parseContentScriptResult(await chrome.tabs.sendMessage(tabId, ping));
      if (pong.ok && pong.value.requestId === ping.requestId && pong.value.ok) return;
    } catch {
      /* not injected yet */
    }
    await this.#inject(tabId, signal, deadlineAt);
  }

  async #inject(
    tabId: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('__inject', {}),
  ): Promise<void> {
    new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
    // Host permission is requested per-origin when the user first targets a
    // site (docs/development/permissions.md); activeTab covers the current tab in most flows.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['page-executor.js'],
    });
    await waitWithContext(50, { signal, deadlineAt });
  }

  async #installDialogInterception(
    tabId: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('__dialog_install', {}),
  ): Promise<void> {
    new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: installDialogInterception,
      });
    } catch (error) {
      throw actionError(
        'safety_boundary_unavailable',
        '无法建立页面对话框安全边界，写操作未派发。',
        'precheck',
        false,
        {
          stage: 'install',
          tabId,
          dispatched: false,
          safetyControl: 'dialog_interception',
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async #restoreDialogInterception(tabId: number): Promise<void> {
    const restoreAttempts = 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= restoreAttempts; attempt++) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: restoreDialogInterception,
        });
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw actionError(
      'safety_boundary_unavailable',
      '页面写操作已结束，但无法确认对话框安全边界已恢复。请重新加载页面后再继续。',
      'recover',
      false,
      {
        stage: 'restore',
        tabId,
        restoreAttempts,
        dispatched: true,
        effectMayHaveOccurred: true,
        dialogInterceptionMayRemain: true,
        cause: lastError instanceof Error ? lastError.message : String(lastError),
      },
    );
  }
}
