/**
 * L2 CDP layer (docs/05 §2): on-demand chrome.debugger attach/detach at tab
 * granularity, single-target serialization, 30s idle auto-detach. Contrast
 * with nanobrowser's always-attached model — Panelot minimizes the "being
 * debugged" banner time (docs/01 §5).
 */

import { keyEventSequence, parseKeyCombo } from './keycodes';
import {
  ActionDeadline,
  abortedAction,
  deadlineForTool,
  waitWithContext,
} from '../action/deadline';
import { actionError, ActionError } from '../action/errors';

const IDLE_DETACH_MS = 30_000;
const CDP_VERSION = '1.3';
const CHILD_SESSION_STABLE_MS = 100;
const CHILD_SESSION_DISCOVERY_TIMEOUT_MS = 2_000;
const CHILD_SESSION_POLL_MS = 10;

interface Attachment {
  tabId: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class CdpManager {
  private attached: Attachment | null = null; // single-target constraint
  /** Serializes attach/switch so two turns can't fight over the debuggee. */
  private queue: Promise<void> = Promise.resolve();
  private deepGeneration = new Map<number, number>();
  private deepRefs = new Map<number, Map<string, DeepNodeRef>>();
  private readonly managerEpoch = randomRefToken();
  private tabEpoch = new Map<number, number>();
  private childSessionStates = new Map<number, ChildSessionState>();

  constructor() {
    chrome.debugger.onEvent.addListener(this.onLifecycleEvent);
    chrome.tabs?.onRemoved?.addListener(this.onTabRemoved);
    chrome.tabs?.onReplaced?.addListener(this.onTabReplaced);
    chrome.tabs?.onUpdated?.addListener(this.onTabUpdated);
  }

  private currentTabEpoch(tabId: number): number {
    const existing = this.tabEpoch.get(tabId);
    if (existing !== undefined) return existing;
    this.tabEpoch.set(tabId, 1);
    return 1;
  }

  private invalidateTab(tabId: number): void {
    this.tabEpoch.set(tabId, this.currentTabEpoch(tabId) + 1);
    this.deepGeneration.delete(tabId);
    this.deepRefs.delete(tabId);
  }

  private onLifecycleEvent = (
    source: chrome.debugger.DebuggerSession,
    method: string,
    params?: object,
  ): void => {
    if (source.tabId === undefined) return;
    if (method === 'Target.attachedToTarget' || method === 'Target.detachedFromTarget') {
      this.updateChildSessionState(source, method, params);
    }
    if (
      method === 'Page.frameStartedNavigating' ||
      method === 'Page.frameNavigated' ||
      method === 'Page.frameDetached' ||
      method === 'Target.attachedToTarget' ||
      method === 'Target.detachedFromTarget'
    ) {
      this.invalidateTab(source.tabId);
    }
  };

  private onTabRemoved = (tabId: number): void => {
    this.invalidateTab(tabId);
    this.childSessionStates.delete(tabId);
  };

  private onTabReplaced = (addedTabId: number, removedTabId: number): void => {
    this.invalidateTab(removedTabId);
    this.invalidateTab(addedTabId);
    this.childSessionStates.delete(removedTabId);
    this.childSessionStates.delete(addedTabId);
  };

  private onTabUpdated = (tabId: number, changeInfo: { status?: string }): void => {
    if (changeInfo.status === 'loading') this.invalidateTab(tabId);
  };

  /** Run `fn` with the debugger attached to `tabId`, switching if needed. */
  async withTab<T>(
    tabId: number,
    fn: () => Promise<T>,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('cdp', {}),
    effectMayHaveOccurredAfterRun = false,
  ): Promise<T> {
    // Chain onto the queue: only one CDP session active at a time.
    let started = false;
    const run = this.queue.then(async () => {
      new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
      started = true;
      await this.ensureAttached(tabId);
      new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
      this.clearIdle();
      try {
        const value = await fn();
        try {
          new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
        } catch (error) {
          if (
            effectMayHaveOccurredAfterRun &&
            error instanceof ActionError &&
            (error.failure.code === 'aborted' || error.failure.code === 'timeout')
          ) {
            throw new ActionError({
              ...error.failure,
              details: {
                ...error.failure.details,
                dispatched: true,
                effectMayHaveOccurred: true,
              },
            });
          }
          throw error;
        }
        return value;
      } finally {
        this.scheduleIdleDetach();
      }
    });
    // Keep the chain alive even if this call rejects.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    if (!signal) return run as Promise<T>;
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
        (value) => finish(() => resolve(value as T)),
        (error) => finish(() => reject(error)),
      );
    });
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
      this.invalidateTab(source.tabId);
      this.childSessionStates.delete(source.tabId);
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
    this.invalidateTab(tabId);
    this.childSessionStates.delete(tabId);
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
  async dispatchKey(
    tabId: number,
    combo: string,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('press_key', {}),
    onDispatch?: () => void,
  ): Promise<void> {
    const payload = parseKeyCombo(combo);
    await this.withTab(
      tabId,
      async () => {
        new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
        onDispatch?.();
        for (const ev of keyEventSequence(payload)) {
          await this.send(ev.type, ev.params);
        }
        if (signal?.aborted) {
          throw abortedAction('execute', { dispatched: true, effectMayHaveOccurred: true });
        }
      },
      signal,
      deadlineAt,
      true,
    );
  }

  async withNetworkSettled<T>(
    tabId: number,
    action: () => Promise<T>,
    idleMs = 500,
    maxWaitMs = 5000,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('cdp_network', {}),
  ): Promise<{ value: T; settled: boolean }> {
    return this.withTab(
      tabId,
      () =>
        this.networkSettledInCurrentSession(
          tabId,
          undefined,
          action,
          idleMs,
          maxWaitMs,
          signal,
          deadlineAt,
        ),
      signal,
      deadlineAt,
      true,
    );
  }

  private async networkSettledInCurrentSession<T>(
    tabId: number,
    sessionId: string | undefined,
    action: () => Promise<T>,
    idleMs: number,
    maxWaitMs: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('cdp_network', {}),
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
        await waitWithContext(50, { signal, deadlineAt });
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
  async getAxTreeText(
    tabId: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('read_page', {}),
  ): Promise<string> {
    return this.withTab(
      tabId,
      async () => {
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
      },
      signal,
      deadlineAt,
    );
  }

  /**
   * Deep accessibility snapshot for targets the content script cannot pierce
   * (cross-origin frames and closed shadow roots). Refs are scoped to the
   * latest CDP generation for the tab and resolve to backend DOM node ids.
   */
  async getDeepAxTree(
    tabId: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('read_page_deep', {}),
  ): Promise<string> {
    return this.withTab(
      tabId,
      async () => {
        const childSessions = await this.attachChildFrames(tabId, signal, deadlineAt);
        const sessionContexts = new Map<string | undefined, SessionDocumentContext>();
        for (const sessionId of [undefined, ...childSessions]) {
          sessionContexts.set(sessionId, await this.captureSessionContext(sessionId));
        }
        const tabEpoch = this.currentTabEpoch(tabId);
        const generation = (this.deepGeneration.get(tabId) ?? 0) + 1;
        const refs = new Map<string, DeepNodeRef>();
        const refPrefix = `c${this.managerEpoch}_${tabEpoch}_${generation}`;
        const lines = [`# Deep Accessibility Snapshot (${refPrefix})`];
        let index = 0;
        const seenBackendNodes = new Set<number>();
        for (const sessionId of [undefined, ...childSessions]) {
          const sessionContext = sessionContexts.get(sessionId)!;
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
              const frame = this.frameIdentityForNode(sessionContext, node.frameId);
              ref = `${refPrefix}_${++index}`;
              refs.set(ref, {
                backendNodeId: node.backendDOMNodeId,
                sessionId,
                managerEpoch: this.managerEpoch,
                tabId,
                tabEpoch,
                generation,
                frameId: frame.frameId,
                loaderId: frame.loaderId,
                documentBackendNodeId: sessionContext.documentBackendNodeId,
              });
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
            const sessionContext = sessionContexts.get(undefined)!;
            const frame = this.frameIdentityForNode(sessionContext, node.frameId);
            const ref = `${refPrefix}_${++index}`;
            refs.set(ref, {
              backendNodeId: node.backendNodeId,
              managerEpoch: this.managerEpoch,
              tabId,
              tabEpoch,
              generation,
              frameId: frame.frameId,
              loaderId: frame.loaderId,
              documentBackendNodeId: sessionContext.documentBackendNodeId,
            });
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
        if (this.currentTabEpoch(tabId) !== tabEpoch) {
          throw this.staleDeepRef(refPrefix, 'snapshot_invalidated_during_capture');
        }
        this.deepGeneration.set(tabId, generation);
        this.deepRefs.set(tabId, refs);
        if (lines.length === 1) throw new Error('Deep AXTree 为空；可尝试 screenshot + vision。');
        return lines.slice(0, 500).join('\n');
      },
      signal,
      deadlineAt,
    );
  }

  private async attachChildFrames(
    tabId: number,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('read_page_deep', {}),
  ): Promise<string[]> {
    const autoAttach = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    };
    let state = this.childSessionStates.get(tabId);
    if (!state) {
      state = createChildSessionState();
      this.childSessionStates.set(tabId, state);
    }
    state.lastActivity = Date.now();
    try {
      await this.send('Target.setAutoAttach', autoAttach);
      state.lastActivity = Date.now();
      for (const sessionId of state.sessions.keys()) {
        this.enableRecursiveChildAttach(tabId, state, sessionId);
      }
      const discoveryDeadline = Math.min(
        deadlineAt,
        Date.now() + CHILD_SESSION_DISCOVERY_TIMEOUT_MS,
      );
      while (true) {
        new ActionDeadline(Number.POSITIVE_INFINITY, signal, discoveryDeadline).throwIfDone();
        const failedSession = [...state.failures.keys()].find((sessionId) =>
          state.sessions.has(sessionId),
        );
        if (failedSession && state.pending.size === 0) {
          throw actionError(
            'stale_ref',
            '跨 frame 调试会话在递归注册期间失效；请重新调用 read_page_deep。',
            'resolve',
            true,
            { reason: 'child_session_attach_failed', sessionId: failedSession },
          );
        }
        const allConfigured = [...state.sessions.keys()].every((sessionId) =>
          state.configured.has(sessionId),
        );
        const quietFor = Date.now() - state.lastActivity;
        if (state.pending.size === 0 && allConfigured && quietFor >= CHILD_SESSION_STABLE_MS) {
          return [...state.sessions.keys()];
        }
        await waitWithContext(
          Math.min(CHILD_SESSION_POLL_MS, Math.max(1, CHILD_SESSION_STABLE_MS - quietFor)),
          { signal, deadlineAt: discoveryDeadline },
        );
      }
    } catch (error) {
      // Chrome promises are not cancelable. Forget only the current attempt
      // tokens so a later read can retry registration without a stale promise
      // keeping the discovery barrier open.
      state.pending.clear();
      throw error;
    }
  }

  private updateChildSessionState(
    source: chrome.debugger.DebuggerSession,
    method: string,
    params?: object,
  ): void {
    const tabId = source.tabId;
    if (tabId === undefined) return;
    const state = this.childSessionStates.get(tabId);
    if (!state) return;
    const values = params as { sessionId?: unknown; targetInfo?: { type?: unknown } } | undefined;
    const sessionId = values?.sessionId;
    if (typeof sessionId !== 'string') return;
    if (method === 'Target.detachedFromTarget') {
      this.removeChildSessionTree(state, sessionId);
      return;
    }
    if (method !== 'Target.attachedToTarget' || values?.targetInfo?.type !== 'iframe') return;
    if (source.sessionId && !state.sessions.has(source.sessionId)) return;
    if (!state.sessions.has(sessionId)) {
      state.sessions.set(sessionId, {
        ...(source.sessionId ? { parentSessionId: source.sessionId } : {}),
      });
      state.lastActivity = Date.now();
    }
    this.enableRecursiveChildAttach(tabId, state, sessionId);
  }

  private enableRecursiveChildAttach(
    tabId: number,
    state: ChildSessionState,
    sessionId: string,
  ): void {
    if (
      this.childSessionStates.get(tabId) !== state ||
      this.attached?.tabId !== tabId ||
      !state.sessions.has(sessionId) ||
      state.configured.has(sessionId) ||
      state.pending.has(sessionId)
    ) {
      return;
    }
    const autoAttach = {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: 'iframe', exclude: false }],
    };
    const token = Symbol(sessionId);
    state.pending.set(sessionId, token);
    void this.sendToSession<void>(sessionId, 'Target.setAutoAttach', autoAttach).then(
      () => {
        if (
          this.childSessionStates.get(tabId) !== state ||
          state.pending.get(sessionId) !== token ||
          !state.sessions.has(sessionId)
        ) {
          return;
        }
        state.pending.delete(sessionId);
        state.failures.delete(sessionId);
        state.configured.add(sessionId);
        state.lastActivity = Date.now();
      },
      (error: unknown) => {
        if (
          this.childSessionStates.get(tabId) !== state ||
          state.pending.get(sessionId) !== token ||
          !state.sessions.has(sessionId)
        ) {
          return;
        }
        state.pending.delete(sessionId);
        state.failures.set(sessionId, error);
        state.lastActivity = Date.now();
      },
    );
  }

  private removeChildSessionTree(state: ChildSessionState, sessionId: string): void {
    const queue = [sessionId];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const [candidate, context] of state.sessions) {
        if (context.parentSessionId === current) queue.push(candidate);
      }
      state.sessions.delete(current);
      state.configured.delete(current);
      state.pending.delete(current);
      state.failures.delete(current);
    }
    state.lastActivity = Date.now();
  }

  private async captureSessionContext(
    sessionId: string | undefined,
    enableDomains = true,
  ): Promise<SessionDocumentContext> {
    if (enableDomains) {
      await this.sendToSession(sessionId, 'Page.enable');
      await this.sendToSession(sessionId, 'DOM.enable');
      await this.sendToSession(sessionId, 'Accessibility.enable');
    }
    const { frameTree } = await this.sendToSession<{ frameTree?: PageFrameTree }>(
      sessionId,
      'Page.getFrameTree',
    );
    const { root } = await this.sendToSession<{ root?: { backendNodeId?: number } }>(
      sessionId,
      'DOM.getDocument',
      { depth: 0, pierce: false },
    );
    if (!frameTree?.frame.id || !frameTree.frame.loaderId || !root?.backendNodeId) {
      throw actionError(
        'stale_ref',
        '无法确认页面文档身份；请重新 read_page_deep。',
        'resolve',
        true,
        { reason: 'document_identity_unavailable' },
      );
    }
    const frames = new Map<string, FrameDocumentIdentity>();
    const visit = (tree: PageFrameTree): void => {
      frames.set(tree.frame.id, {
        frameId: tree.frame.id,
        loaderId: tree.frame.loaderId,
      });
      tree.childFrames?.forEach(visit);
    };
    visit(frameTree);
    return {
      rootFrameId: frameTree.frame.id,
      documentBackendNodeId: root.backendNodeId,
      frames,
    };
  }

  private frameIdentityForNode(
    context: SessionDocumentContext,
    frameId: string | undefined,
  ): FrameDocumentIdentity {
    const identity = context.frames.get(frameId ?? context.rootFrameId);
    if (!identity) {
      throw actionError(
        'stale_ref',
        '无法确认 deep ref 所属 frame；请重新 read_page_deep。',
        'resolve',
        true,
        { reason: 'frame_identity_unavailable', frameId },
      );
    }
    return identity;
  }

  async getDeepRefCenter(
    tabId: number,
    ref: string,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('deep_ref', {}),
  ): Promise<{ x: number; y: number }> {
    return this.withTab(
      tabId,
      async () => this.deepRefCenter(await this.validateDeepRef(tabId, ref), ref),
      signal,
      deadlineAt,
    );
  }

  private async deepRefCenter(target: DeepNodeRef, ref: string): Promise<{ x: number; y: number }> {
    this.assertDeepRefCurrent(target, ref);
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

  async clickDeepRef(
    tabId: number,
    ref: string,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('click_trusted', {}),
    onDispatch?: () => void,
  ): Promise<{ settled: boolean }> {
    return this.withTab(
      tabId,
      async () => {
        const lifecycleEpoch = this.currentTabEpoch(tabId);
        const target = await this.validateDeepRef(tabId, ref);
        const point = await this.deepRefCenter(target, ref);
        let dispatched = false;
        try {
          this.assertDeepRefCurrent(target, ref);
          const result = await this.networkSettledInCurrentSession(
            tabId,
            target.sessionId,
            async () => {
              new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
              await this.assertDeepRefReadyForWrite(tabId, ref, target, lifecycleEpoch);
              onDispatch?.();
              dispatched = true;
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
            signal,
            deadlineAt,
          );
          return { settled: result.settled };
        } catch (error) {
          if (
            !dispatched &&
            this.currentTabEpoch(tabId) !== lifecycleEpoch &&
            !(error instanceof ActionError && error.failure.code === 'stale_ref')
          ) {
            throw this.staleDeepRef(ref, 'lifecycle_changed_during_preparation');
          }
          if (
            dispatched &&
            error instanceof ActionError &&
            (error.failure.code === 'aborted' || error.failure.code === 'timeout')
          ) {
            throw new ActionError({
              ...error.failure,
              details: { ...error.failure.details, effectMayHaveOccurred: true },
            });
          }
          throw error;
        }
      },
      signal,
      deadlineAt,
      true,
    );
  }

  async focusDeepRef(
    tabId: number,
    ref: string,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('focus_deep', {}),
  ): Promise<void> {
    await this.withTab(
      tabId,
      async () => {
        const lifecycleEpoch = this.currentTabEpoch(tabId);
        const target = await this.validateDeepRef(tabId, ref);
        await this.assertDeepRefReadyForWrite(tabId, ref, target, lifecycleEpoch);
        await this.sendToSession(target.sessionId, 'DOM.focus', {
          backendNodeId: target.backendNodeId,
        });
      },
      signal,
      deadlineAt,
      true,
    );
  }

  async typeDeepRef(
    tabId: number,
    ref: string,
    text: string,
    signal?: AbortSignal,
    deadlineAt = deadlineForTool('type_trusted', {}),
    onDispatch?: () => void,
  ): Promise<{ settled: boolean }> {
    return this.withTab(
      tabId,
      async () => {
        const lifecycleEpoch = this.currentTabEpoch(tabId);
        const target = await this.validateDeepRef(tabId, ref);
        let dispatched = false;
        try {
          this.assertDeepRefCurrent(target, ref);
          const result = await this.networkSettledInCurrentSession(
            tabId,
            target.sessionId,
            async () => {
              new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
              await this.assertDeepRefReadyForWrite(tabId, ref, target, lifecycleEpoch);
              onDispatch?.();
              dispatched = true;
              await this.sendToSession(target.sessionId, 'DOM.focus', {
                backendNodeId: target.backendNodeId,
              });
              await this.assertDeepRefReadyForWrite(tabId, ref, target, lifecycleEpoch);
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
            signal,
            deadlineAt,
          );
          return { settled: result.settled };
        } catch (error) {
          if (
            !dispatched &&
            this.currentTabEpoch(tabId) !== lifecycleEpoch &&
            !(error instanceof ActionError && error.failure.code === 'stale_ref')
          ) {
            throw this.staleDeepRef(ref, 'lifecycle_changed_during_preparation');
          }
          if (
            dispatched &&
            error instanceof ActionError &&
            (error.failure.code === 'aborted' || error.failure.code === 'timeout')
          ) {
            throw new ActionError({
              ...error.failure,
              details: { ...error.failure.details, effectMayHaveOccurred: true },
            });
          }
          throw error;
        }
      },
      signal,
      deadlineAt,
      true,
    );
  }

  private resolveDeepRef(tabId: number, ref: string): DeepNodeRef {
    const generation = this.deepGeneration.get(tabId);
    const tabEpoch = this.currentTabEpoch(tabId);
    const prefix = `c${this.managerEpoch}_${tabEpoch}_${generation ?? 0}_`;
    if (!generation || !ref.startsWith(prefix)) throw this.staleDeepRef(ref, 'ref_epoch_mismatch');
    const target = this.deepRefs.get(tabId)?.get(ref);
    if (!target) throw this.staleDeepRef(ref, 'ref_not_found');
    this.assertDeepRefCurrent(target, ref);
    return target;
  }

  private async validateDeepRef(tabId: number, ref: string): Promise<DeepNodeRef> {
    const target = this.resolveDeepRef(tabId, ref);
    let context: SessionDocumentContext;
    try {
      context = await this.captureSessionContext(target.sessionId, false);
    } catch (error) {
      if (error instanceof ActionError) throw error;
      throw this.staleDeepRef(ref, 'document_identity_check_failed');
    }
    this.assertDeepRefCurrent(target, ref);
    const frame = context.frames.get(target.frameId);
    if (
      !frame ||
      frame.loaderId !== target.loaderId ||
      context.documentBackendNodeId !== target.documentBackendNodeId
    ) {
      this.invalidateTab(tabId);
      throw this.staleDeepRef(ref, 'document_identity_changed');
    }
    return target;
  }

  private async assertDeepRefReadyForWrite(
    tabId: number,
    ref: string,
    target: DeepNodeRef,
    lifecycleEpoch: number,
  ): Promise<void> {
    if (this.currentTabEpoch(tabId) !== lifecycleEpoch) {
      throw this.staleDeepRef(ref, 'lifecycle_changed_during_preparation');
    }
    const refreshed = await this.validateDeepRef(tabId, ref);
    if (
      refreshed !== target ||
      this.currentTabEpoch(tabId) !== lifecycleEpoch ||
      refreshed.sessionId !== target.sessionId
    ) {
      throw this.staleDeepRef(ref, 'document_identity_changed_during_preparation');
    }
  }

  private assertDeepRefCurrent(target: DeepNodeRef, ref: string): void {
    if (
      target.managerEpoch !== this.managerEpoch ||
      target.tabEpoch !== this.currentTabEpoch(target.tabId) ||
      target.generation !== this.deepGeneration.get(target.tabId) ||
      this.deepRefs.get(target.tabId)?.get(ref) !== target
    ) {
      throw this.staleDeepRef(ref, 'ref_invalidated');
    }
  }

  private staleDeepRef(ref: string, reason: string): ActionError {
    return actionError(
      'stale_ref',
      `Deep ref ${ref} 已过期或无法确认身份，请重新调用 read_page_deep。`,
      'resolve',
      true,
      { reason },
    );
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
  frameId?: string;
}

interface DomNode {
  nodeType: number;
  nodeName: string;
  backendNodeId: number;
  attributes?: string[];
  frameId?: string;
}

interface DeepNodeRef {
  backendNodeId: number;
  sessionId?: string;
  managerEpoch: string;
  tabId: number;
  tabEpoch: number;
  generation: number;
  frameId: string;
  loaderId: string;
  documentBackendNodeId: number;
}

interface PageFrameTree {
  frame: { id: string; loaderId: string };
  childFrames?: PageFrameTree[];
}

interface FrameDocumentIdentity {
  frameId: string;
  loaderId: string;
}

interface SessionDocumentContext {
  rootFrameId: string;
  documentBackendNodeId: number;
  frames: Map<string, FrameDocumentIdentity>;
}

interface ChildSessionState {
  sessions: Map<string, { parentSessionId?: string }>;
  configured: Set<string>;
  pending: Map<string, symbol>;
  failures: Map<string, unknown>;
  lastActivity: number;
}

function createChildSessionState(): ChildSessionState {
  return {
    sessions: new Map(),
    configured: new Set(),
    pending: new Map(),
    failures: new Map(),
    lastActivity: Date.now(),
  };
}

function randomRefToken(): string {
  const values = new Uint32Array(2);
  crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(36)).join('');
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
