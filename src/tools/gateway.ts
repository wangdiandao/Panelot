/**
 * BrowserToolGateway (docs/01 §5): engine-side router for browser tools.
 * L0 → chrome.tabs API directly; L1 → content script messaging with idempotent
 * injection + one retry; controlled-tab set management (docs/05 §6).
 */

import type { ContentScriptOp, ContentScriptResult } from '../messaging/protocol';
import type { ExecuteResult } from './content/executor';

const CS_TIMEOUT_MS = 15_000;

export class BrowserToolGateway {
  /** Thread → controlled tab ids (agent-opened + user-attached). */
  private controlledTabs = new Map<string, Set<number>>();
  /** Thread → currently targeted tab. */
  private activeTab = new Map<string, number>();
  /** Called when the user manually operates a controlled page (auto-pause). */
  onManualOperation: (tabId: number) => void = () => {};
  /** Called after the controlled set of a thread changes (task panel display). */
  onTabsChanged: (threadId: string) => void = () => {};

  constructor() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
        if ((msg as { type?: string })?.type === 'panelot.manualOperation' && sender.tab?.id !== undefined) {
          this.onManualOperation(sender.tab.id);
        }
      });
      // Controlled tab closed by the user → drop from all sets (docs/05 §6).
      chrome.tabs?.onRemoved?.addListener((tabId) => {
        for (const [threadId, set] of this.controlledTabs) {
          if (set.delete(tabId)) this.onTabsChanged(threadId);
        }
      });
    }
  }

  // ---- controlled tab set (docs/05 §6) --------------------------------------

  controls(threadId: string): number[] {
    return [...(this.controlledTabs.get(threadId) ?? [])];
  }

  attachTab(threadId: string, tabId: number): void {
    let set = this.controlledTabs.get(threadId);
    if (!set) {
      set = new Set();
      this.controlledTabs.set(threadId, set);
    }
    set.add(tabId);
    this.activeTab.set(threadId, tabId);
    this.onTabsChanged(threadId);
  }

  detachTab(threadId: string, tabId: number): void {
    this.controlledTabs.get(threadId)?.delete(tabId);
    if (this.activeTab.get(threadId) === tabId) this.activeTab.delete(threadId);
    this.onTabsChanged(threadId);
  }

  async getTargetTab(threadId: string): Promise<number> {
    const active = this.activeTab.get(threadId);
    if (active !== undefined) {
      try {
        await chrome.tabs.get(active);
        return active;
      } catch {
        this.detachTab(threadId, active);
      }
    }
    // Fall back to the user's active tab and attach it. Only http(s) pages
    // qualify: when the conversation runs in the extension's own full-page
    // tab, THAT tab is the active one in the current window — targeting it
    // would hit the chrome-extension://* sensitive blacklist. Look across
    // windows for the most recently used active web page instead.
    const activeTabs = await chrome.tabs.query({ active: true });
    const webTabs = activeTabs
      .filter((t): t is chrome.tabs.Tab & { id: number; url: string } => t.id !== undefined && !!t.url && /^https?:/.test(t.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const tab = webTabs[0];
    if (!tab) throw new Error('没有可操作的网页标签页（扩展自身页面不能作为操作目标）。请先用 tab_open 打开页面或激活一个网页标签页。');
    this.attachTab(threadId, tab.id);
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
    try {
      const result = await Promise.race([
        chrome.tabs.sendMessage(tabId, op) as Promise<ContentScriptResult>,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`工具执行超时（${CS_TIMEOUT_MS / 1000}s）`)), CS_TIMEOUT_MS)),
      ]);
      if (!result) throw new Error('content script 无响应');
      if (!result.ok) throw new Error(result.error);
      return result.result as ExecuteResult;
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      // "Receiving end does not exist" → content script not injected; retry once.
      if (!retried && /Receiving end|Could not establish/i.test(message)) {
        await this.inject(tabId);
        return this.sendToTab(tabId, tool, params, true);
      }
      throw e;
    }
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
    await new Promise((r) => setTimeout(r, 50));
  }
}
