/**
 * L2 CDP layer (docs/05 §2): on-demand chrome.debugger attach/detach at tab
 * granularity, single-target serialization, 30s idle auto-detach. Contrast
 * with nanobrowser's always-attached model — Panelot minimizes the "being
 * debugged" banner time (docs/01 §5).
 */

const IDLE_DETACH_MS = 30_000;
const CDP_VERSION = '1.3';

interface Attachment {
  tabId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class CdpManager {
  private attached: Attachment | null = null; // single-target constraint
  /** Serializes attach/switch so two turns can't fight over the debuggee. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Run `fn` with the debugger attached to `tabId`, switching if needed. */
  async withTab<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    // Chain onto the queue: only one CDP session active at a time.
    const run = this.queue.then(async () => {
      await this.ensureAttached(tabId);
      this.clearIdle();
      try {
        return await fn();
      } finally {
        this.scheduleIdleDetach();
      }
    });
    // Keep the chain alive even if this call rejects.
    this.queue = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  }

  private async ensureAttached(tabId: number): Promise<void> {
    if (this.attached?.tabId === tabId) return;
    if (this.attached) await this.detach();
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    this.attached = { tabId, idleTimer: null };
    // If the user closes DevTools / another client detaches, forget it.
    chrome.debugger.onDetach.addListener(this.onDetach);
  }

  private onDetach = (source: chrome.debugger.Debuggee): void => {
    if (this.attached && source.tabId === this.attached.tabId) {
      this.clearIdle();
      this.attached = null;
    }
  };

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.attached) throw new Error('CDP not attached');
    const result = await chrome.debugger.sendCommand({ tabId: this.attached.tabId }, method, params);
    return result as T;
  }

  private clearIdle(): void {
    if (this.attached?.idleTimer) {
      clearTimeout(this.attached.idleTimer);
      this.attached.idleTimer = null;
    }
  }

  private scheduleIdleDetach(): void {
    if (!this.attached) return;
    this.clearIdle();
    this.attached.idleTimer = setTimeout(() => void this.detach(), IDLE_DETACH_MS);
  }

  async detach(): Promise<void> {
    if (!this.attached) return;
    const tabId = this.attached.tabId;
    this.clearIdle();
    this.attached = null;
    chrome.debugger.onDetach.removeListener(this.onDetach);
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already gone */
    }
  }

  isAttached(tabId: number): boolean {
    return this.attached?.tabId === tabId;
  }

  /**
   * AXTree fallback (docs/05 §1.4): when the L1 DOM walk yields an empty tree,
   * pull the full accessibility tree via CDP as a coarse perception layer.
   */
  async getAxTreeText(tabId: number): Promise<string> {
    return this.withTab(tabId, async () => {
      const { nodes } = await this.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree');
      const lines: string[] = ['# Accessibility Tree (CDP fallback)'];
      for (const node of nodes) {
        const role = node.role?.value ?? '';
        const name = node.name?.value ?? '';
        if (!role || role === 'none' || role === 'generic') continue;
        if (!name && !INTERESTING_ROLES.has(role)) continue;
        lines.push(`- ${role}${name ? ` "${name}"` : ''}`);
      }
      if (lines.length === 1) throw new Error('AXTree 也为空（可能是纯 Canvas 页面）。可尝试 screenshot + vision。');
      return lines.slice(0, 400).join('\n');
    });
  }
}

const INTERESTING_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'heading', 'image', 'combobox']);

interface AxNode {
  role?: { value?: string };
  name?: { value?: string };
}
