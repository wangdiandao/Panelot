/**
 * Content-script tool executor (docs/05 §2-5) — runs in the page's isolated
 * world. Receives ContentScriptOp messages from the BrowserToolGateway,
 * validates ref freshness, performs the action, waits for stabilization,
 * returns an incremental snapshot.
 *
 * Waiting strategy follows browser-use's battle-tested defaults:
 * minWait 250ms → mutation-idle 500ms → 5s cap (docs/05 §4).
 */

import { buildSnapshot, type SnapshotResult } from '../snapshot/engine';

// ---------------------------------------------------------------------------
// State (per tab, in-memory only — docs/02 §2.2 "not persisted")
// ---------------------------------------------------------------------------

let currentSnapshot: SnapshotResult | null = null;
let snapshotCounter = 0;

const WAIT_DEFAULTS = { minWaitMs: 250, networkIdleMs: 500, maxWaitMs: 5000, betweenActionsMs: 300 };

// ---------------------------------------------------------------------------
// Ref resolution — versioned, expiry-checked (docs/05 §1.1)
// ---------------------------------------------------------------------------

class StaleRefError extends Error {
  constructor(ref: string) {
    super(
      `快照已过期：ref "${ref}" 不属于当前快照 s${currentSnapshot?.snapshotId ?? 0}。请重新 read_page 获取新快照后用新 ref 重试。`,
    );
    this.name = 'StaleRefError';
  }
}

function resolveRef(ref: string): Element {
  if (!currentSnapshot) throw new StaleRefError(ref);
  const prefix = `s${currentSnapshot.snapshotId}_`;
  if (!ref.startsWith(prefix)) throw new StaleRefError(ref);
  const el = currentSnapshot.refMap.get(ref);
  if (!el || !el.isConnected) throw new StaleRefError(ref);
  return el;
}

// ---------------------------------------------------------------------------
// Stabilization (docs/05 §4)
// ---------------------------------------------------------------------------

async function stabilize(opts = WAIT_DEFAULTS): Promise<{ timedOut: boolean }> {
  const start = Date.now();
  await sleep(opts.minWaitMs);

  return new Promise((resolve) => {
    let lastMutation = Date.now();
    const observer = new MutationObserver(() => {
      lastMutation = Date.now();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

    const check = () => {
      const now = Date.now();
      if (now - lastMutation >= opts.networkIdleMs) {
        observer.disconnect();
        resolve({ timedOut: false });
      } else if (now - start >= opts.maxWaitMs) {
        observer.disconnect();
        resolve({ timedOut: true });
      } else {
        setTimeout(check, 100);
      }
    };
    setTimeout(check, 100);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Visual feedback (docs/05 §5) — Shadow DOM isolated
// ---------------------------------------------------------------------------

let overlayHost: HTMLElement | null = null;

function getOverlay(): ShadowRoot {
  if (!overlayHost || !overlayHost.isConnected) {
    overlayHost = document.createElement('panelot-overlay');
    overlayHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(overlayHost);
    overlayHost.attachShadow({ mode: 'open' });
  }
  return overlayHost.shadowRoot!;
}

function highlight(el: Element): void {
  try {
    const rect = el.getBoundingClientRect();
    const shadow = getOverlay();
    const box = document.createElement('div');
    box.style.cssText = `position:fixed;left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;border:2px solid #f5a623;border-radius:4px;pointer-events:none;transition:opacity 300ms;box-shadow:0 0 0 2px rgba(245,166,35,.25);`;
    shadow.appendChild(box);
    setTimeout(() => {
      box.style.opacity = '0';
      setTimeout(() => box.remove(), 400);
    }, 700);
  } catch {
    /* highlight is best-effort */
  }
}

export function showIndicator(text: string): void {
  const shadow = getOverlay();
  let badge = shadow.getElementById('indicator');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'indicator';
    badge.style.cssText =
      'position:fixed;right:16px;bottom:16px;background:#18181d;color:#e8e8ed;border:1px solid #2a2a33;border-radius:999px;padding:6px 12px;font:12px Inter,system-ui;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.4);';
    shadow.appendChild(badge);
  }
  badge.textContent = text;
}

export function hideIndicator(): void {
  overlayHost?.shadowRoot?.getElementById('indicator')?.remove();
}

// ---------------------------------------------------------------------------
// Manual-operation detection (docs/05 §5): trusted user events → auto-pause
// ---------------------------------------------------------------------------

let manualHandler: (() => void) | null = null;
let agentActing = false;

export function watchManualOperation(onManual: () => void): void {
  manualHandler = onManual;
  for (const type of ['mousedown', 'keydown'] as const) {
    document.addEventListener(
      type,
      (e) => {
        if (e.isTrusted && !agentActing) manualHandler?.();
      },
      { capture: true, passive: true },
    );
  }
}

// ---------------------------------------------------------------------------
// Actions (docs/05 §3)
// ---------------------------------------------------------------------------

function dispatchInputEvents(el: HTMLElement): void {
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Set a native input value in a way React/Vue notice (native setter). */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  dispatchInputEvents(el);
}

async function doClick(params: { ref: string; button?: 'left' | 'right'; doubleClick?: boolean }): Promise<string> {
  const el = resolveRef(params.ref) as HTMLElement;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  highlight(el);
  const opts = { bubbles: true, cancelable: true, view: window };
  if (params.button === 'right') {
    el.dispatchEvent(new MouseEvent('contextmenu', opts));
  } else if (params.doubleClick) {
    el.dispatchEvent(new MouseEvent('dblclick', { ...opts, detail: 2 }));
  } else {
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }
  return `已点击`;
}

async function doType(params: { ref: string; text: string; mode?: 'replace' | 'append'; submit?: boolean; slowly?: boolean }): Promise<string> {
  const el = resolveRef(params.ref) as HTMLElement;
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  highlight(el);
  el.focus();

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const base = params.mode === 'append' ? el.value : '';
    if (params.slowly) {
      // Char-by-char with key events for pickier frameworks.
      let acc = base;
      for (const ch of params.text) {
        acc += ch;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        setNativeValue(el, acc);
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        await sleep(20);
      }
    } else {
      setNativeValue(el, base + params.text);
    }
    // Verify the value stuck (framework may have swallowed synthetic events).
    if (el.value !== base + params.text && !params.slowly) {
      throw new Error('输入未生效（框架可能吞掉了合成事件）。可尝试 slowly:true 或升级 L2。');
    }
  } else if (el.isContentEditable) {
    if (params.mode !== 'append') el.textContent = '';
    el.textContent += params.text;
    dispatchInputEvents(el);
  } else {
    throw new Error(`ref ${params.ref} 不是可输入元素（${el.tagName.toLowerCase()}）`);
  }

  if (params.submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    (el.closest('form') as HTMLFormElement | null)?.requestSubmit?.();
  }
  return `已输入${params.submit ? '并提交' : ''}`;
}

async function doSelect(params: { ref: string; values: string[] }): Promise<string> {
  const el = resolveRef(params.ref);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`ref ${params.ref} 不是 select 元素`);
  highlight(el);
  const matched: string[] = [];
  for (const option of el.options) {
    const hit = params.values.includes(option.value) || params.values.includes(option.textContent?.trim() ?? '');
    option.selected = hit;
    if (hit) matched.push(option.value);
  }
  if (matched.length === 0) {
    const available = [...el.options].map((o) => `"${o.textContent?.trim()}" (value=${o.value})`).join(', ');
    throw new Error(`未匹配到选项。可用选项：${available}`);
  }
  dispatchInputEvents(el);
  return `已选择 ${matched.join(', ')}`;
}

async function doPressKey(params: { key: string }): Promise<string> {
  // 'Control+a' style combos.
  const parts = params.key.split('+');
  const key = parts[parts.length - 1]!;
  const init: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    ctrlKey: parts.includes('Control') || parts.includes('Ctrl'),
    altKey: parts.includes('Alt'),
    shiftKey: parts.includes('Shift'),
    metaKey: parts.includes('Meta') || parts.includes('Cmd'),
  };
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return `已按键 ${params.key}`;
}

async function doScroll(params: { target?: string; direction: 'up' | 'down'; amount?: 'page' | 'end' | number }): Promise<string> {
  const container: Element | null = params.target ? resolveRef(params.target) : document.scrollingElement;
  const el = container ?? document.documentElement;
  const sign = params.direction === 'down' ? 1 : -1;
  if (params.amount === 'end') {
    el.scrollTo({ top: sign > 0 ? el.scrollHeight : 0, behavior: 'instant' as ScrollBehavior });
  } else {
    const px = typeof params.amount === 'number' ? params.amount : window.innerHeight * 0.85;
    el.scrollBy({ top: sign * px, behavior: 'instant' as ScrollBehavior });
  }
  await sleep(150);
  return `已滚动`;
}

async function doHover(params: { ref: string }): Promise<string> {
  const el = resolveRef(params.ref) as HTMLElement;
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  highlight(el);
  const opts = { bubbles: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window }));
  el.dispatchEvent(new MouseEvent('mousemove', opts));
  return `已悬停`;
}

async function doWaitFor(params: { text?: string; textGone?: boolean | string; timeMs?: number }): Promise<string> {
  if (params.timeMs !== undefined) {
    await sleep(Math.min(params.timeMs, 30_000));
    return `已等待 ${params.timeMs}ms`;
  }
  const gone = typeof params.textGone === 'string' ? params.textGone : params.textGone ? params.text : undefined;
  const target = gone ?? params.text;
  if (!target) throw new Error('wait_for 需要 text / textGone / timeMs 之一');

  const deadline = Date.now() + 10_000;
  for (;;) {
    const present = (document.body?.innerText ?? '').includes(target);
    if (gone ? !present : present) return gone ? `"${target}" 已消失` : `"${target}" 已出现`;
    if (Date.now() > deadline) {
      throw new Error(`等待超时（10s）：${gone ? `"${target}" 未消失` : `"${target}" 未出现`}`);
    }
    await sleep(200);
  }
}

function doGetSelection(): string {
  const sel = window.getSelection()?.toString() ?? '';
  if (!sel.trim()) return '（当前无选中文本）';
  return sel;
}

function doFindInPage(params: { query: string }): string {
  if (!currentSnapshot) {
    takeSnapshot({});
  }
  const q = params.query.toLowerCase();
  const hits = currentSnapshot!.yaml
    .split('\n')
    .filter((line) => line.toLowerCase().includes(q))
    .slice(0, 20);
  if (hits.length === 0) return `页面快照中未找到 "${params.query}"。可尝试滚动后重试，或用 read_page 查看完整快照。`;
  return `命中 ${hits.length} 行：\n${hits.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Snapshot ops
// ---------------------------------------------------------------------------

function takeSnapshot(params: { maxTokens?: number }): string {
  snapshotCounter++;
  currentSnapshot = buildSnapshot(window, { snapshotId: snapshotCounter, maxTokens: params.maxTokens ?? 3000 });
  if (currentSnapshot.refMap.size === 0 && (document.body?.innerText ?? '').trim() === '') {
    // Explicit failure so the gateway can trigger the L2/AXTree fallback chain
    // (docs/05 §1.4 — never return an empty tree silently).
    throw new Error('EMPTY_TREE: 页面 DOM 为空或不可见（可能是 Canvas 应用/跨域 frame）。');
  }
  return currentSnapshot.yaml;
}

function articleExtract(): string {
  const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('script,style,noscript,nav,footer,iframe,svg,header,aside').forEach((el) => el.remove());
  const text = (clone.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  const max = 12_000; // ≈3k tokens
  return `# ${document.title}\nURL: ${location.href}\n\n${text.length > max ? `${text.slice(0, max)}\n[正文已截断]` : text}`;
}

// ---------------------------------------------------------------------------
// batch_actions — sequential with change-interruption (docs/05 §3, browser-use)
// ---------------------------------------------------------------------------

interface BatchAction {
  kind: 'click' | 'type' | 'select_option';
  params: Record<string, unknown>;
}

async function doBatch(params: { actions: BatchAction[] }): Promise<string> {
  if (params.actions.length > 4) throw new Error('batch_actions 最多 4 个动作');
  const executed: string[] = [];
  const refCountBefore = currentSnapshot?.refMap.size ?? 0;

  for (const [i, action] of params.actions.entries()) {
    if (i > 0) await sleep(WAIT_DEFAULTS.betweenActionsMs);
    let result: string;
    switch (action.kind) {
      case 'click':
        result = await doClick(action.params as never);
        break;
      case 'type':
        result = await doType(action.params as never);
        break;
      case 'select_option':
        result = await doSelect(action.params as never);
        break;
    }
    executed.push(`${i + 1}. ${action.kind}: ${result}`);

    // Change-interruption: if the DOM shifted significantly, remaining refs
    // are unreliable — stop and force a fresh snapshot.
    if (i < params.actions.length - 1) {
      const probe = buildSnapshot(window, { snapshotId: snapshotCounter, maxTokens: 500 });
      if (Math.abs(probe.refMap.size - refCountBefore) > Math.max(3, refCountBefore * 0.2)) {
        executed.push(`[页面发生显著变化，中断剩余 ${params.actions.length - i - 1} 个动作]`);
        break;
      }
    }
  }
  return executed.join('\n');
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface ExecuteResult {
  resultText: string;
  /** New incremental snapshot after write actions. */
  snapshot?: string;
  pageStabilized?: boolean;
}

const WRITE_ACTIONS = new Set(['click', 'type', 'select_option', 'press_key', 'hover', 'batch_actions']);

export async function executeContentTool(tool: string, params: unknown): Promise<ExecuteResult> {
  agentActing = true;
  try {
    // Params were zod-validated at the AgentTool layer before dispatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (params ?? {}) as any;
    let resultText: string;

    switch (tool) {
      case 'read_page': {
        const mode = (p as { mode?: string }).mode ?? 'snapshot';
        resultText = mode === 'article' ? articleExtract() : takeSnapshot(p);
        return { resultText };
      }
      case 'find_in_page':
        return { resultText: doFindInPage(p) };
      case 'get_selection':
        return { resultText: doGetSelection() };
      case 'click':
        resultText = await doClick(p);
        break;
      case 'type':
        resultText = await doType(p);
        break;
      case 'select_option':
        resultText = await doSelect(p);
        break;
      case 'press_key':
        resultText = await doPressKey(p);
        break;
      case 'scroll':
        resultText = await doScroll(p);
        break;
      case 'hover':
        resultText = await doHover(p);
        break;
      case 'wait_for':
        return { resultText: await doWaitFor(p) };
      case 'batch_actions':
        resultText = await doBatch(p);
        break;
      default:
        throw new Error(`content script 不支持工具: ${tool}`);
    }

    // Write actions: stabilize, then return a fresh snapshot (docs/05 §1.3).
    let stabilized = true;
    if (WRITE_ACTIONS.has(tool)) {
      const { timedOut } = await stabilize();
      stabilized = !timedOut;
    }
    const snapshot = takeSnapshot({ maxTokens: 1500 });
    return {
      resultText: resultText + (stabilized ? '' : '\n[页面可能未完全加载]'),
      snapshot,
      pageStabilized: stabilized,
    };
  } finally {
    agentActing = false;
  }
}
