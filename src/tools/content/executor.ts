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
import {
  BADGE_BG,
  BADGE_BORDER,
  BADGE_FG,
  BRAND_PRIMARY,
  BRAND_PRIMARY_HALO,
} from '../../styles/brand';
import { actionError } from '../action/errors';
import { ActionDeadline } from '../action/deadline';
import { ensureActionable } from './actionability';
import type { ActionEvidence } from '../action/types';
import { diffSnapshotYaml } from '../snapshot/diff';

// ---------------------------------------------------------------------------
// State (per tab, in-memory only — docs/02 §2.2 "not persisted")
// ---------------------------------------------------------------------------

let currentSnapshot: SnapshotResult | null = null;
let snapshotCounter = 0;
const priorHints = new Map<string, import('../snapshot/engine').LocatorHint>();

const WAIT_DEFAULTS = {
  minWaitMs: 250,
  networkIdleMs: 500,
  maxWaitMs: 5000,
  betweenActionsMs: 300,
};

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
  if (!currentSnapshot) {
    throw actionError('stale_ref', new StaleRefError(ref).message, 'resolve', true);
  }
  const prefix = `s${currentSnapshot.snapshotId}_`;
  if (!ref.startsWith(prefix)) {
    throw actionError('stale_ref', new StaleRefError(ref).message, 'resolve', true);
  }
  const el = currentSnapshot.refMap.get(ref);
  if (!el || !el.isConnected) {
    throw actionError('stale_ref', new StaleRefError(ref).message, 'resolve', true);
  }
  return el;
}

function resolveRefWithRecovery(
  ref: string,
  allowRecovery = false,
): { element: Element; recoveredRef?: string } {
  try {
    return { element: resolveRef(ref) };
  } catch (error) {
    if (!allowRecovery) throw error;
    const hint = priorHints.get(ref);
    if (!hint || !currentSnapshot) throw error;
    const matches = [...currentSnapshot.hintMap.entries()].filter(
      ([, candidate]) =>
        candidate.role === hint.role &&
        candidate.name === hint.name &&
        candidate.tagName === hint.tagName &&
        candidate.inputType === hint.inputType &&
        candidate.label === hint.label &&
        candidate.placeholder === hint.placeholder,
    );
    if (matches.length !== 1) {
      throw actionError(
        'ambiguous_target',
        `旧 ref ${ref} 无法唯一恢复（候选 ${matches.length} 个），请重新 read_page。`,
        'recover',
      );
    }
    const [recoveredRef] = matches[0]!;
    return { element: currentSnapshot.refMap.get(recoveredRef)!, recoveredRef };
  }
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
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });

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
    overlayHost.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;pointer-events:none;';
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
    box.style.cssText = `position:fixed;left:${rect.left - 3}px;top:${rect.top - 3}px;width:${rect.width + 6}px;height:${rect.height + 6}px;border:2px solid ${BRAND_PRIMARY};border-radius:4px;pointer-events:none;transition:opacity 300ms;box-shadow:0 0 0 2px ${BRAND_PRIMARY_HALO};`;
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
    badge.style.cssText = `position:fixed;right:16px;bottom:16px;background:${BADGE_BG};color:${BADGE_FG};border:1px solid ${BADGE_BORDER};border-radius:999px;padding:6px 12px;font:12px Inter,system-ui;pointer-events:none;box-shadow:0 2px 12px rgba(0,0,0,.4);`;
    shadow.appendChild(badge);
  }
  badge.textContent = text;
}

export function hideIndicator(): void {
  overlayHost?.shadowRoot?.getElementById('indicator')?.remove();
}

function annotateRefs(): string {
  if (!currentSnapshot) takeSnapshot({});
  const shadow = getOverlay();
  shadow.getElementById('ref-annotations')?.remove();
  const layer = document.createElement('div');
  layer.id = 'ref-annotations';
  const legend: string[] = [];
  for (const [ref, element] of currentSnapshot!.refMap) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const badge = document.createElement('div');
    badge.textContent = ref;
    badge.style.cssText = `position:fixed;left:${Math.max(2, rect.left)}px;top:${Math.max(2, rect.top)}px;background:${BADGE_BG};color:${BADGE_FG};border:1px solid ${BADGE_BORDER};border-radius:4px;padding:1px 4px;font:10px ui-monospace,monospace;pointer-events:none;`;
    layer.appendChild(badge);
    legend.push(
      `${ref}: ${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 60) ?? ''}`.trim(),
    );
  }
  shadow.appendChild(layer);
  return legend.join('\n');
}

function clearRefAnnotations(): void {
  overlayHost?.shadowRoot?.getElementById('ref-annotations')?.remove();
}

// ---------------------------------------------------------------------------
// Manual-operation detection (docs/05 §5): trusted user events → auto-pause
// ---------------------------------------------------------------------------

let manualHandler: (() => void) | null = null;
let agentActing = false;

// ---------------------------------------------------------------------------
// Dialog reports from the MAIN-world patch (injected by the gateway):
// auto-answered alert/confirm/prompt land here and ride along in the next
// tool result so the model knows a dialog fired.
// ---------------------------------------------------------------------------

const pendingDialogs: { kind: string; message: string; response: string }[] = [];
if (typeof document !== 'undefined') {
  document.addEventListener('panelot:dialog', (e) => {
    try {
      const detail = JSON.parse((e as CustomEvent<string>).detail);
      pendingDialogs.push(detail);
    } catch {
      /* malformed — page interference, ignore */
    }
  });
}

function drainDialogReports(): string {
  if (pendingDialogs.length === 0) return '';
  const lines = pendingDialogs.map(
    (d) => `- ${d.kind}("${d.message.slice(0, 200)}") → ${d.response}`,
  );
  pendingDialogs.length = 0;
  return `\n[页面弹出了 ${lines.length} 个对话框，已自动处理:\n${lines.join('\n')}]`;
}

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
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  dispatchInputEvents(el);
}

async function doClick(params: {
  ref: string;
  button?: 'left' | 'right';
  doubleClick?: boolean;
  allowRecovery?: boolean;
}): Promise<string> {
  const { element: resolved, recoveredRef } = resolveRefWithRecovery(
    params.ref,
    params.allowRecovery,
  );
  const el = resolved as HTMLElement;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  await ensureActionable(el, 'click', new ActionDeadline(1500));
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
  return `已点击${recoveredRef ? `（目标已恢复为 ${recoveredRef}）` : ''}`;
}

async function doType(params: {
  ref: string;
  text: string;
  mode?: 'replace' | 'append';
  submit?: boolean;
  slowly?: boolean;
  allowRecovery?: boolean;
}): Promise<string> {
  const { element: resolved, recoveredRef } = resolveRefWithRecovery(
    params.ref,
    params.allowRecovery,
  );
  const el = resolved as HTMLElement;
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  await ensureActionable(el, 'type', new ActionDeadline(1500));
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
      throw actionError('l1_not_effective', '输入未生效（页面可能忽略合成事件）。', 'verify', true);
    }
  } else if (el.isContentEditable) {
    if (params.mode !== 'append') el.textContent = '';
    el.textContent += params.text;
    dispatchInputEvents(el);
  } else {
    throw new Error(`ref ${params.ref} 不是可输入元素（${el.tagName.toLowerCase()}）`);
  }

  if (params.submit) {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    (el.closest('form') as HTMLFormElement | null)?.requestSubmit?.();
  }
  return `已输入${params.submit ? '并提交' : ''}${recoveredRef ? `（目标已恢复为 ${recoveredRef}）` : ''}`;
}

async function doSelect(params: {
  ref: string;
  values: string[];
  allowRecovery?: boolean;
}): Promise<string> {
  const { element: el, recoveredRef } = resolveRefWithRecovery(params.ref, params.allowRecovery);
  await ensureActionable(el, 'select', new ActionDeadline(1500));
  if (!(el instanceof HTMLSelectElement)) {
    throw actionError('not_editable', `ref ${params.ref} 不是 select 元素`, 'precheck');
  }
  highlight(el);
  const matched: string[] = [];
  for (const option of el.options) {
    const hit =
      params.values.includes(option.value) ||
      params.values.includes(option.textContent?.trim() ?? '');
    option.selected = hit;
    if (hit) matched.push(option.value);
  }
  if (matched.length === 0) {
    const available = [...el.options]
      .map((o) => `"${o.textContent?.trim()}" (value=${o.value})`)
      .join(', ');
    throw new Error(`未匹配到选项。可用选项：${available}`);
  }
  dispatchInputEvents(el);
  return `已选择 ${matched.join(', ')}${recoveredRef ? `（目标已恢复为 ${recoveredRef}）` : ''}`;
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

async function doScroll(params: {
  target?: string;
  direction: 'up' | 'down';
  amount?: 'page' | 'end' | number;
}): Promise<string> {
  const container: Element | null = params.target
    ? resolveRef(params.target)
    : document.scrollingElement;
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

async function doWaitFor(params: {
  text?: string;
  textGone?: boolean | string;
  timeMs?: number;
}): Promise<string> {
  if (params.timeMs !== undefined) {
    await sleep(Math.min(params.timeMs, 30_000));
    return `已等待 ${params.timeMs}ms`;
  }
  const gone =
    typeof params.textGone === 'string'
      ? params.textGone
      : params.textGone
        ? params.text
        : undefined;
  const target = gone ?? params.text;
  if (!target) throw new Error('wait_for 需要 text / textGone / timeMs 之一');

  const deadline = Date.now() + 30_000;
  for (;;) {
    const present = (document.body?.innerText ?? '').includes(target);
    if (gone ? !present : present) return gone ? `"${target}" 已消失` : `"${target}" 已出现`;
    if (Date.now() > deadline) {
      throw new Error(`等待超时（30s）：${gone ? `"${target}" 未消失` : `"${target}" 未出现`}`);
    }
    await sleep(200);
  }
}

async function doUpload(params: {
  ref: string;
  filename: string;
  mime: string;
  base64: string;
}): Promise<string> {
  const el = resolveRef(params.ref);
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
    throw new Error(`ref ${params.ref} 不是文件输入框（<input type="file">）`);
  }
  highlight(el);
  // DataTransfer synthesis — the extension-compatible path (CDP's
  // DOM.setFileInputFiles needs local file paths extensions can't provide).
  const binary = atob(params.base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const file = new File([bytes], params.filename, { type: params.mime });
  const dt = new DataTransfer();
  dt.items.add(file);
  el.files = dt.files;
  dispatchInputEvents(el);
  if (el.files.length !== 1) throw new Error('文件设置未生效（页面可能重置了输入框）');
  return `已选择文件 ${params.filename}（${(bytes.length / 1024).toFixed(1)} KB）`;
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
  if (hits.length === 0)
    return `页面快照中未找到 "${params.query}"。可尝试滚动后重试，或用 read_page 查看完整快照。`;
  return `命中 ${hits.length} 行：\n${hits.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Snapshot ops
// ---------------------------------------------------------------------------

function takeSnapshot(params: { maxTokens?: number }): string {
  if (currentSnapshot) {
    for (const [ref, hint] of currentSnapshot.hintMap) priorHints.set(ref, hint);
    while (priorHints.size > 500) priorHints.delete(priorHints.keys().next().value!);
  }
  snapshotCounter++;
  currentSnapshot = buildSnapshot(window, {
    snapshotId: snapshotCounter,
    maxTokens: params.maxTokens ?? 3000,
  });
  if (currentSnapshot.refMap.size === 0 && (document.body?.innerText ?? '').trim() === '') {
    // Explicit failure so the gateway can trigger the L2/AXTree fallback chain
    // (docs/05 §1.4 — never return an empty tree silently).
    throw new Error('EMPTY_TREE: 页面 DOM 为空或不可见（可能是 Canvas 应用/跨域 frame）。');
  }
  return currentSnapshot.yaml;
}

const EXTRACT_MAX_CHARS = 12_000; // ≈3k tokens
const CHROME_SELECTOR = 'script,style,noscript,nav,footer,iframe,svg,header,aside';

function articleExtract(): string {
  const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body;
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(CHROME_SELECTOR).forEach((el) => el.remove());
  const text = (clone.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  return `# ${document.title}\nURL: ${location.href}\n\n${text.length > EXTRACT_MAX_CHARS ? `${text.slice(0, EXTRACT_MAX_CHARS)}\n[正文已截断]` : text}`;
}

/**
 * Safety cap on the FULL extraction — beyond this even the offloaded attachment
 * is truncated (pathological pages only; ~50k tokens). Windowing for the model's
 * context is done by the engine-side tool, not here.
 */
const EXTRACT_HARD_CAP = 200_000;

/**
 * extract (borrowed from browser-use's `extract` action + browsercluster's GNE
 * article extraction; output-size control from chrome-agent-skill's save_path):
 * page/subtree → clean Markdown that PRESERVES links and heading levels, so the
 * loop's model can structure it without a raw snapshot. scope limits to a ref'd
 * subtree. Returns the FULL markdown (up to a hard cap); the engine-side tool
 * windows it for context and offloads the full body to an attachment.
 */
function doExtract(params: { scope?: string }): string {
  const root = params.scope
    ? (resolveRef(params.scope) as HTMLElement)
    : ((document.querySelector('article') ??
        document.querySelector('main') ??
        document.body) as HTMLElement);
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll(CHROME_SELECTOR).forEach((el) => el.remove());

  const md = domToMarkdown(clone)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const header = `# ${document.title}\nURL: ${location.href}\n\n`;
  const body =
    md.length > EXTRACT_HARD_CAP
      ? `${md.slice(0, EXTRACT_HARD_CAP)}\n[正文超长，已在 ${EXTRACT_HARD_CAP} 字符截断]`
      : md;
  return header + body;
}

/** Minimal DOM→Markdown: headings, links, list items, paragraphs. Block-level
 *  elements emit newlines; <a href> becomes [text](absolute-url). */
function domToMarkdown(root: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent ?? '').replace(/\s+/g, ' ');
      if (t.trim()) parts.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    const h = /^h([1-6])$/.exec(tag);
    if (h) {
      parts.push(`\n\n${'#'.repeat(Number(h[1]))} ${(el.textContent ?? '').trim()}\n`);
      return; // heading text already captured
    }
    if (tag === 'a') {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const href = el.getAttribute('href');
      if (text && href && !href.startsWith('javascript:')) {
        let abs = href;
        try {
          abs = new URL(href, location.href).href;
        } catch {
          /* keep raw */
        }
        parts.push(`[${text}](${abs})`);
      } else if (text) {
        parts.push(text);
      }
      return; // don't double-walk link children
    }
    if (tag === 'li') {
      parts.push('\n- ');
      el.childNodes.forEach(walk);
      return;
    }
    if (tag === 'br') {
      parts.push('\n');
      return;
    }
    const isBlock = /^(p|div|section|article|ul|ol|table|tr|blockquote|pre|h[1-6])$/.test(tag);
    if (isBlock) parts.push('\n');
    el.childNodes.forEach(walk);
    if (isBlock) parts.push('\n');
  };
  walk(root);
  return parts.join('');
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
  rect?: { x: number; y: number; width: number; height: number };
  evidence?: ActionEvidence;
}

const WRITE_ACTIONS = new Set([
  'click',
  'type',
  'select_option',
  'press_key',
  'hover',
  'batch_actions',
  'upload',
]);

export async function executeContentTool(tool: string, params: unknown): Promise<ExecuteResult> {
  agentActing = true;
  try {
    // Params were zod-validated at the AgentTool layer before dispatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (params ?? {}) as any;
    let resultText: string;
    const actionStart = Date.now();
    const actionGeneration = currentSnapshot?.snapshotId;

    switch (tool) {
      case 'read_page': {
        const mode = (p as { mode?: string }).mode ?? 'snapshot';
        resultText = mode === 'article' ? articleExtract() : takeSnapshot(p);
        return { resultText };
      }
      case 'find_in_page':
        return { resultText: doFindInPage(p) };
      case 'extract':
        return { resultText: doExtract(p) };
      case 'get_selection':
        return { resultText: doGetSelection() };
      case 'get_rect': {
        const element = resolveRef(p.ref);
        const rect = element.getBoundingClientRect();
        const documentCoordinates = p.coordinateSpace !== 'viewport';
        return {
          resultText: `Bounds for ${p.ref}`,
          rect: {
            x: rect.left + (documentCoordinates ? window.scrollX : 0),
            y: rect.top + (documentCoordinates ? window.scrollY : 0),
            width: rect.width,
            height: rect.height,
          },
        };
      }
      case 'annotate_refs':
        return { resultText: annotateRefs() };
      case 'clear_annotations':
        clearRefAnnotations();
        return { resultText: 'annotations cleared' };
      case 'click':
        resultText = await doClick(p);
        break;
      case 'type':
        resultText = await doType(p);
        break;
      case 'select_option':
        resultText = await doSelect(p);
        break;
      case 'focus': {
        // Focus for the CDP press_key path: bring the element into view and
        // give it keyboard focus so the trusted key lands on it.
        const el = resolveRef(p.ref) as HTMLElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        el.focus();
        return { resultText: '已聚焦' };
      }
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
      case 'upload':
        resultText = await doUpload(p);
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
    const previousSnapshot = currentSnapshot?.yaml;
    const fullSnapshot = takeSnapshot({ maxTokens: 1500 });
    const snapshot = diffSnapshotYaml(previousSnapshot, fullSnapshot).text;
    const evidence: ActionEvidence | undefined = WRITE_ACTIONS.has(tool)
      ? {
          attemptId: crypto.randomUUID(),
          generationBefore: actionGeneration,
          generationAfter: currentSnapshot?.snapshotId,
          attempts: [
            {
              phase: 'execute',
              strategy: 'l1',
              startedAt: actionStart,
              durationMs: Date.now() - actionStart,
            },
          ],
          observedEffects:
            currentSnapshot?.snapshotId !== actionGeneration ? ['snapshot_changed'] : [],
          outcome: 'verified',
        }
      : undefined;
    return {
      resultText: resultText + drainDialogReports() + (stabilized ? '' : '\n[页面可能未完全加载]'),
      snapshot,
      pageStabilized: stabilized,
      ...(evidence ? { evidence } : {}),
    };
  } finally {
    agentActing = false;
  }
}
