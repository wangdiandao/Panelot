/**
 * BrowserToolGateway (docs/01 §5): engine-side router for browser tools.
 * L0 → chrome.tabs API directly; L1 → content script messaging with idempotent
 * injection + one retry; per-thread target tab + touched-tab audit (docs/05 §6).
 */

import type { ContentScriptOp, ContentScriptResult } from '../messaging/protocol';
import type { ExecuteResult } from './content/executor';

const CS_TIMEOUT_MS = 15_000;

/** A response arrived reporting failure — a genuine tool error, not navigation. */
class ToolReportedError extends Error {}

/**
 * MAIN-world dialog patch (serialized by chrome.scripting — must be fully
 * self-contained). Auto-answers alert/confirm/prompt so they can't deadlock
 * the agent, and reports each via a CustomEvent the isolated-world executor
 * collects into the tool result (JSON-string detail crosses worlds in Chrome).
 */
function patchDialogs(): void {
  const w = window as Window & { __panelotDialogPatched?: boolean };
  if (w.__panelotDialogPatched) return;
  w.__panelotDialogPatched = true;
  const report = (kind: string, message: string, response: string) => {
    document.dispatchEvent(
      new CustomEvent('panelot:dialog', { detail: JSON.stringify({ kind, message, response }) }),
    );
  };
  const origAlert = window.alert.bind(window);
  const origConfirm = window.confirm.bind(window);
  const origPrompt = window.prompt.bind(window);
  void origAlert; void origConfirm; void origPrompt; // originals kept for potential restore
  window.alert = (message?: unknown) => {
    report('alert', String(message ?? ''), '已确认');
  };
  window.confirm = (message?: unknown) => {
    report('confirm', String(message ?? ''), '已自动确认(true)');
    return true;
  };
  window.prompt = (message?: unknown, _default?: string) => {
    report('prompt', String(message ?? ''), '已自动取消(null)');
    return null;
  };
}

/** Poll until the tab finishes loading (shared by navigation tools & gateway). */
export async function waitForTabLoad(tabId: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return;
    } catch {
      return; // tab gone
    }
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export class BrowserToolGateway {
  /**
   * Browser-level control model (2026-07-06): the agent may target ANY tab —
   * the safety gates are write approvals + the sensitive-origin blacklist
   * (docs/06), not tab membership. Per thread we keep:
   *  - target: the tab page tools operate on. `pinned` when the agent chose
   *    it explicitly (tab_open/tab_activate); unpinned targets follow the
   *    user's current tab BETWEEN turns but stay fixed DURING a turn (so a
   *    mid-task user tab-switch never redirects clicks to the wrong page).
   *  - touched: audit trail of tabs the agent has operated on — drives the
   *    task-panel display, never a permission boundary.
   */
  private target = new Map<string, { tabId: number; pinned: boolean }>();
  private touched = new Map<string, Set<number>>();
  /** Called when the user manually operates a page the agent is driving. */
  onManualOperation: (tabId: number) => void = () => {};
  /** Called after a thread's touched set changes (task panel display). */
  onTabsChanged: (threadId: string) => void = () => {};

  constructor() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
        if ((msg as { type?: string })?.type === 'panelot.manualOperation' && sender.tab?.id !== undefined) {
          this.onManualOperation(sender.tab.id);
        }
      });
      // Tab closed (by user or agent) → drop it everywhere.
      chrome.tabs?.onRemoved?.addListener((tabId) => {
        for (const [threadId, set] of this.touched) {
          if (set.delete(tabId)) this.onTabsChanged(threadId);
        }
        for (const [threadId, t] of this.target) {
          if (t.tabId === tabId) this.target.delete(threadId);
        }
      });
    }
  }

  // ---- target & audit trail (docs/05 §6) -------------------------------------

  /** Tabs the agent has operated on this thread (audit display, not permission). */
  touchedTabs(threadId: string): number[] {
    return [...(this.touched.get(threadId) ?? [])];
  }

  /** The thread's current target tab id, if any (no discovery). */
  currentTarget(threadId: string): number | undefined {
    return this.target.get(threadId)?.tabId;
  }

  /**
   * The tab the USER is looking at (active tab of the last focused window).
   * Distinct from the agent's target tab — tool results report view-state
   * changes against THIS, so the model never conflates "my working tab
   * changed" with "the user's screen changed".
   */
  async getUserActiveTab(): Promise<chrome.tabs.Tab | undefined> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab;
  }

  /** Explicit target choice (tab_open / tab_activate): survives across turns. */
  pinTarget(threadId: string, tabId: number): void {
    this.target.set(threadId, { tabId, pinned: true });
    this.markTouched(threadId, tabId);
  }

  /** Drop the target (closed / navigated to a dead end). */
  clearTarget(threadId: string, tabId?: number): void {
    const t = this.target.get(threadId);
    if (t && (tabId === undefined || t.tabId === tabId)) this.target.delete(threadId);
  }

  /**
   * Turn boundary hook: an auto-discovered (unpinned) target is released when
   * the turn ends, so the NEXT turn follows the tab the user is looking at by
   * then. Pinned targets persist — the agent chose them deliberately.
   */
  releaseFloatingTarget(threadId: string): void {
    if (this.target.get(threadId)?.pinned === false) this.target.delete(threadId);
  }

  private markTouched(threadId: string, tabId: number): void {
    let set = this.touched.get(threadId);
    if (!set) {
      set = new Set();
      this.touched.set(threadId, set);
    }
    if (!set.has(tabId)) {
      set.add(tabId);
      this.onTabsChanged(threadId);
    }
  }

  async getTargetTab(threadId: string): Promise<number> {
    const existing = this.target.get(threadId);
    if (existing !== undefined) {
      try {
        await chrome.tabs.get(existing.tabId);
        return existing.tabId;
      } catch {
        this.target.delete(threadId);
      }
    }
    // No target yet this turn → the tab the user is looking at. Only http(s)
    // pages qualify: when the conversation runs in the extension's own
    // full-page tab, THAT tab is the active one in the current window —
    // targeting it would hit the chrome-extension://* sensitive blacklist.
    // Look across windows for the most recently used active web page.
    const activeTabs = await chrome.tabs.query({ active: true });
    const webTabs = activeTabs
      .filter((t): t is chrome.tabs.Tab & { id: number; url: string } => t.id !== undefined && !!t.url && /^https?:/.test(t.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const tab = webTabs[0];
    if (!tab) throw new Error('没有可操作的网页标签页（扩展自身页面不能作为操作目标）。请先用 tab_open 打开页面或激活一个网页标签页。');
    // Unpinned: locked for this turn, released at turn end (see
    // releaseFloatingTarget) so the next turn follows the user again.
    this.target.set(threadId, { tabId: tab.id, pinned: false });
    this.markTouched(threadId, tab.id);
    return tab.id;
  }

  async getTabOrigin(threadId: string): Promise<string> {
    try {
      const tabId = await this.getTargetTab(threadId);
      const tab = await chrome.tabs.get(tabId);
      return tab.url ? new URL(tab.url).origin : '';
    } catch {
      return '';
    }
  }

  // ---- L1 dispatch (docs/01 §5) ----------------------------------------------

  async callContentTool(threadId: string, tool: string, params: unknown): Promise<ExecuteResult> {
    const tabId = await this.getTargetTab(threadId);
    await this.ensureInjected(tabId);
    return this.sendToTab(tabId, tool, params);
  }

  private async sendToTab(tabId: number, tool: string, params: unknown, retried = false): Promise<ExecuteResult> {
    const op: ContentScriptOp = { requestId: crypto.randomUUID(), tool, params };
    const urlBefore = await chrome.tabs.get(tabId).then((t) => t.url).catch(() => undefined);
    try {
      const result = await Promise.race([
        chrome.tabs.sendMessage(tabId, op) as Promise<ContentScriptResult>,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`工具执行超时（${CS_TIMEOUT_MS / 1000}s）`)), CS_TIMEOUT_MS)),
      ]);
      if (!result) throw new Error('content script 无响应');
      // A response ARRIVED reporting failure (stale ref, element not found):
      // that's a genuine tool error, never navigation. Mark it so the catch
      // below doesn't reframe it as a successful page change.
      if (!result.ok) throw new ToolReportedError(result.error);
      return result.result as ExecuteResult;
    } catch (e) {
      if (e instanceof ToolReportedError) throw new Error(e.message);
      const message = (e as Error).message ?? String(e);
      // No response arrived (timeout / torn-down channel). The action may have
      // navigated the page — the content script gets destroyed mid-call, so
      // the reply never comes. A real navigation SUCCEEDED; reporting it as an
      // error teaches the model to retry (double-submit). Confirmed only by an
      // actual URL change.
      const nav = await this.detectNavigation(tabId, urlBefore);
      if (nav) return nav;
      // "Receiving end does not exist" → content script not injected; retry once.
      if (!retried && /Receiving end|Could not establish|message channel closed/i.test(message)) {
        await this.inject(tabId);
        return this.sendToTab(tabId, tool, params, true);
      }
      throw e;
    }
  }

  /**
   * Navigation is confirmed ONLY by an actual URL change (a same-URL timeout
   * is a genuine failure, not a navigation). Waits for load, re-injects, and
   * returns a neutral success result with a fresh snapshot.
   */
  private async detectNavigation(tabId: number, urlBefore: string | undefined): Promise<ExecuteResult | null> {
    if (urlBefore === undefined) return null;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return null; // tab closed — let the original error propagate
    }
    if (tab.url === urlBefore) return null; // no URL change → not a navigation

    await waitForTabLoad(tabId);
    const loaded = await chrome.tabs.get(tabId).catch(() => null);
    if (!loaded) return null;
    // Fresh page → fresh content script → fresh snapshot for the model.
    let snapshot: string | undefined;
    try {
      await this.inject(tabId);
      const snap = await this.sendToTabRaw(tabId, 'read_page', { maxTokens: 1500 });
      snapshot = snap.resultText;
    } catch {
      /* snapshot is best-effort; the navigation report alone is still true */
    }
    return {
      resultText: `页面已跳转到 ${loaded.url}${loaded.title ? `（${loaded.title}）` : ''}。旧 ref 已全部失效，需要交互时先 read_page。`,
      snapshot,
      pageStabilized: true,
    };
  }

  /** Single send without navigation detection (used inside detectNavigation). */
  private async sendToTabRaw(tabId: number, tool: string, params: unknown): Promise<ExecuteResult> {
    const op: ContentScriptOp = { requestId: crypto.randomUUID(), tool, params };
    const result = await Promise.race([
      chrome.tabs.sendMessage(tabId, op) as Promise<ContentScriptResult>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('snapshot timeout')), CS_TIMEOUT_MS)),
    ]);
    if (!result?.ok) throw new Error(result ? (result as { error: string }).error : 'no response');
    return result.result as ExecuteResult;
  }

  private async ensureInjected(tabId: number): Promise<void> {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { requestId: 'ping', tool: '__ping', params: {} });
      if (pong) return;
    } catch {
      /* not injected yet */
    }
    await this.inject(tabId);
  }

  private async inject(tabId: number): Promise<void> {
    // Host permission is requested per-origin when the user first targets a
    // site (docs/06); activeTab covers the current tab in most flows.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    });
    // Dialog patch in the MAIN world: window.confirm/alert/prompt block the
    // page AND our tool call (15s timeout). Auto-answer and report instead.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: patchDialogs,
    }).catch(() => {/* some pages forbid MAIN-world injection; degrade gracefully */});
    await new Promise((r) => setTimeout(r, 50));
  }
}
