/**
 * L2 CDP layer (docs/05 §2): on-demand chrome.debugger attach/detach at tab
 * granularity, single-target serialization, 30s idle auto-detach. Contrast
 * with nanobrowser's always-attached model — Panelot minimizes the "being
 * debugged" banner time (docs/01 §5).
 */

import { keyEventSequence, parseKeyCombo } from './keycodes';

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
  private deepGeneration = new Map<number, number>();
  private deepRefs = new Map<number, Map<string, DeepNodeRef>>();

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
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
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
    const result = await chrome.debugger.sendCommand(
      { tabId: this.attached.tabId },
      method,
      params,
    );
    return result as T;
  }

  private async sendToSession<T = unknown>(
    sessionId: string | undefined,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.attached) throw new Error('CDP not attached');
    const result = await chrome.debugger.sendCommand(
      { tabId: this.attached.tabId, ...(sessionId ? { sessionId } : {}) },
      method,
      params,
    );
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
   * Trusted key press (docs/05 §3): synthetic KeyboardEvents can't trigger
   * native behavior (Enter-submit, Tab-focus, Escape-dismiss); CDP input can.
   * Accepts 'Enter', 'Control+a', 'Shift+Tab' style combos.
   */
  async dispatchKey(tabId: number, combo: string): Promise<void> {
    const payload = parseKeyCombo(combo);
    await this.withTab(tabId, async () => {
      for (const ev of keyEventSequence(payload)) {
        await this.send(ev.type, ev.params);
      }
    });
  }

  async withNetworkSettled<T>(
    tabId: number,
    action: () => Promise<T>,
    idleMs = 500,
    maxWaitMs = 5000,
  ): Promise<{ value: T; settled: boolean }> {
    return this.withTab(tabId, () =>
      this.networkSettledInCurrentSession(tabId, undefined, action, idleMs, maxWaitMs),
    );
  }

  private async networkSettledInCurrentSession<T>(
    tabId: number,
    sessionId: string | undefined,
    action: () => Promise<T>,
    idleMs: number,
    maxWaitMs: number,
  ): Promise<{ value: T; settled: boolean }> {
    await this.sendToSession(sessionId, 'Network.enable');
    const pending = new Set<string>();
    let lastActivity = Date.now();
    const onEvent = (source: chrome.debugger.DebuggerSession, method: string, params?: object) => {
      if (source.tabId !== tabId || source.sessionId !== sessionId) return;
      const values = params as { requestId?: unknown } | undefined;
      const requestId = typeof values?.requestId === 'string' ? values.requestId : undefined;
      if (method === 'Network.requestWillBeSent' && requestId) pending.add(requestId);
      if (
        (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') &&
        requestId
      ) {
        pending.delete(requestId);
      }
      if (method.startsWith('Network.')) lastActivity = Date.now();
    };
    chrome.debugger.onEvent.addListener(onEvent);
    try {
      const value = await action();
      const deadline = Date.now() + maxWaitMs;
      while (Date.now() < deadline) {
        if (pending.size === 0 && Date.now() - lastActivity >= idleMs) {
          return { value, settled: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { value, settled: false };
    } finally {
      chrome.debugger.onEvent.removeListener(onEvent);
      await this.sendToSession(sessionId, 'Network.disable').catch(() => {});
    }
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
      if (lines.length === 1)
        throw new Error('AXTree 也为空（可能是纯 Canvas 页面）。可尝试 screenshot + vision。');
      return lines.slice(0, 400).join('\n');
    });
  }

  /**
   * Deep accessibility snapshot for targets the content script cannot pierce
   * (cross-origin frames and closed shadow roots). Refs are scoped to the
   * latest CDP generation for the tab and resolve to backend DOM node ids.
   */
  async getDeepAxTree(tabId: number): Promise<string> {
    return this.withTab(tabId, async () => {
      const childSessions = await this.attachChildFrames(tabId);
      const generation = (this.deepGeneration.get(tabId) ?? 0) + 1;
      this.deepGeneration.set(tabId, generation);
      const refs = new Map<string, DeepNodeRef>();
      const lines = [`# Deep Accessibility Snapshot (c${generation})`];
      let index = 0;
      const seenBackendNodes = new Set<number>();
      for (const sessionId of [undefined, ...childSessions]) {
        await this.sendToSession(sessionId, 'DOM.enable');
        await this.sendToSession(sessionId, 'Accessibility.enable');
        const { nodes } = await this.sendToSession<{ nodes: AxNode[] }>(
          sessionId,
          'Accessibility.getFullAXTree',
        );
        for (const node of nodes) {
          const role = node.role?.value ?? '';
          const name = node.name?.value ?? '';
          if (!role || role === 'none' || role === 'generic') continue;
          if (!name && !INTERESTING_ROLES.has(role)) continue;
          let ref = '';
          if (node.backendDOMNodeId && DEEP_INTERACTIVE_ROLES.has(role)) {
            ref = `c${generation}_${++index}`;
            refs.set(ref, { backendNodeId: node.backendDOMNodeId, sessionId });
            if (!sessionId) seenBackendNodes.add(node.backendDOMNodeId);
          }
          lines.push(
            `- ${role}${name ? ` "${name.replace(/\s+/g, ' ').slice(0, 120)}"` : ''}${sessionId ? ' [frame=cross-origin]' : ''}${ref ? ` [ref=${ref}]` : ''}`,
          );
        }
      }
      // AXTree misses div/span controls wired only through addEventListener.
      // Deep mode may inspect a bounded number of pierced DOM nodes so this
      // enhancement cannot turn a hostile page into unbounded CDP work.
      try {
        const { nodes: domNodes } = await this.send<{ nodes: DomNode[] }>(
          'DOM.getFlattenedDocument',
          { depth: -1, pierce: true },
        );
        const candidates = domNodes
          .filter(
            (node) =>
              node.nodeType === 1 &&
              node.backendNodeId &&
              !seenBackendNodes.has(node.backendNodeId),
          )
          .slice(0, 120);
        for (const node of candidates) {
          const { object } = await this.send<{ object?: { objectId?: string } }>(
            'DOM.resolveNode',
            {
              backendNodeId: node.backendNodeId,
            },
          );
          if (!object?.objectId) continue;
          const { listeners } = await this.send<{ listeners?: { type: string }[] }>(
            'DOMDebugger.getEventListeners',
            { objectId: object.objectId, depth: 1, pierce: true },
          );
          const eventTypes = [
            ...new Set(
              (listeners ?? [])
                .map((listener) => listener.type)
                .filter((type) => DEEP_INTERACTION_EVENTS.has(type)),
            ),
          ];
          if (eventTypes.length === 0) continue;
          const ref = `c${generation}_${++index}`;
          refs.set(ref, { backendNodeId: node.backendNodeId });
          const attrs = attributeMap(node.attributes);
          const name =
            attrs['aria-label'] ?? attrs.title ?? attrs.id ?? node.nodeName.toLowerCase();
          lines.push(
            `- event-target "${name.replace(/\s+/g, ' ').slice(0, 120)}" [events=${eventTypes.join(',')}] [ref=${ref}]`,
          );
        }
      } catch {
        // Event-listener discovery is an enhancement; the AXTree remains valid.
      }
      this.deepRefs.set(tabId, refs);
      if (lines.length === 1) throw new Error('Deep AXTree 为空；可尝试 screenshot + vision。');
      return lines.slice(0, 500).join('\n');
    });
  }

  private async attachChildFrames(tabId: number): Promise<string[]> {
    const sessions = new Set<string>();
    const onEvent = async (
      source: chrome.debugger.DebuggerSession,
      method: string,
      params?: object,
    ) => {
      if (source.tabId !== tabId || method !== 'Target.attachedToTarget') return;
      const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof sessionId !== 'string' || sessions.has(sessionId)) return;
      sessions.add(sessionId);
      await this.sendToSession(sessionId, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'iframe', exclude: false }],
      }).catch(() => {});
    };
    chrome.debugger.onEvent.addListener(onEvent);
    try {
      await this.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: 'iframe', exclude: false }],
      });
      await Promise.resolve();
      return [...sessions];
    } finally {
      chrome.debugger.onEvent.removeListener(onEvent);
    }
  }

  async getDeepRefCenter(tabId: number, ref: string): Promise<{ x: number; y: number }> {
    return this.withTab(tabId, () => this.deepRefCenter(tabId, ref));
  }

  private async deepRefCenter(tabId: number, ref: string): Promise<{ x: number; y: number }> {
    const target = this.resolveDeepRef(tabId, ref);
    const { model } = await this.sendToSession<{
      model: { content?: number[]; border?: number[] };
    }>(target.sessionId, 'DOM.getBoxModel', { backendNodeId: target.backendNodeId });
    const quad = model.content ?? model.border;
    if (!quad || quad.length < 8) throw new Error(`Deep ref ${ref} 没有可操作区域。`);
    return {
      x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  }

  async clickDeepRef(tabId: number, ref: string): Promise<{ settled: boolean }> {
    return this.withTab(tabId, async () => {
      const target = this.resolveDeepRef(tabId, ref);
      const point = await this.deepRefCenter(tabId, ref);
      const result = await this.networkSettledInCurrentSession(
        tabId,
        target.sessionId,
        async () => {
          const base = { ...point, button: 'left', clickCount: 1 };
          await this.sendToSession(target.sessionId, 'Input.dispatchMouseEvent', {
            type: 'mousePressed',
            ...base,
          });
          await this.sendToSession(target.sessionId, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            ...base,
          });
        },
        500,
        5000,
      );
      return { settled: result.settled };
    });
  }

  async focusDeepRef(tabId: number, ref: string): Promise<void> {
    await this.withTab(tabId, async () => {
      const target = this.resolveDeepRef(tabId, ref);
      await this.sendToSession(target.sessionId, 'DOM.focus', {
        backendNodeId: target.backendNodeId,
      });
    });
  }

  async typeDeepRef(tabId: number, ref: string, text: string): Promise<{ settled: boolean }> {
    return this.withTab(tabId, async () => {
      const target = this.resolveDeepRef(tabId, ref);
      const result = await this.networkSettledInCurrentSession(
        tabId,
        target.sessionId,
        async () => {
          await this.sendToSession(target.sessionId, 'DOM.focus', {
            backendNodeId: target.backendNodeId,
          });
          await this.sendToSession(target.sessionId, 'Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            modifiers: 2,
          });
          await this.sendToSession(target.sessionId, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'a',
            code: 'KeyA',
            modifiers: 2,
          });
          await this.sendToSession(target.sessionId, 'Input.insertText', { text });
        },
        500,
        5000,
      );
      return { settled: result.settled };
    });
  }

  private resolveDeepRef(tabId: number, ref: string): DeepNodeRef {
    const generation = this.deepGeneration.get(tabId);
    if (!generation || !ref.startsWith(`c${generation}_`)) {
      throw new Error(`Deep ref ${ref} 已过期，请重新调用 read_page_deep。`);
    }
    const target = this.deepRefs.get(tabId)?.get(ref);
    if (!target) throw new Error(`Deep ref ${ref} 不存在，请重新调用 read_page_deep。`);
    return target;
  }
}

const INTERESTING_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'heading',
  'image',
  'combobox',
]);

interface AxNode {
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
}

interface DomNode {
  nodeType: number;
  nodeName: string;
  backendNodeId: number;
  attributes?: string[];
}

interface DeepNodeRef {
  backendNodeId: number;
  sessionId?: string;
}

function attributeMap(values: string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < (values?.length ?? 0); index += 2) {
    result[values![index]!] = values![index + 1] ?? '';
  }
  return result;
}

const DEEP_INTERACTION_EVENTS = new Set(['click', 'mousedown', 'pointerdown', 'keydown']);

const DEEP_INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'menuitem',
  'tab',
  'option',
]);
