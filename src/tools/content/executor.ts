/**
 * Content-script tool executor (docs/05 §2-5) — runs in the page's isolated
 * world. Receives ContentScriptOp messages from the BrowserToolGateway,
 * validates ref freshness, performs the action, waits for stabilization,
 * returns an incremental snapshot.
 *
 * Waiting strategy follows browser-use's battle-tested defaults:
 * minWait 250ms → mutation-idle 500ms → 5s cap (docs/05 §4).
 */

import { buildSnapshot, type LocatorHint, type SnapshotResult } from '../snapshot/engine';
import {
  BADGE_BG,
  BADGE_BORDER,
  BADGE_FG,
  BRAND_PRIMARY,
  BRAND_PRIMARY_HALO,
} from '../../styles/brand';
import { actionError, ActionError } from '../action/errors';
import {
  ActionDeadline,
  deadlineForTool,
  type ActionExecutionContext,
  waitWithContext,
} from '../action/deadline';
import { ensureActionable } from './actionability';
import type { ActionEvidence } from '../action/types';
import { diffSnapshotYaml } from '../snapshot/diff';
import { parseContentToolCall, type BatchActionsParams, type ExecuteResult } from './protocol';

export type { ExecuteResult } from './protocol';

// ---------------------------------------------------------------------------
// State (per tab, in-memory only — docs/02 §2.2 "not persisted")
// ---------------------------------------------------------------------------

let currentSnapshot: SnapshotResult | null = null;
let snapshotCounter = 0;

interface RefDocumentIdentity {
  documentToken: string;
  rootDocument: Document;
  ownerDocument: Document;
  frameChain: {
    frame: HTMLIFrameElement;
    ownerDocument: Document;
    document: Document;
  }[];
}

interface PriorRefHint {
  hint: LocatorHint;
  identity: RefDocumentIdentity;
}

const priorHints = new Map<string, PriorRefHint>();

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
      `快照已过期：ref "${ref}" 不属于当前文档和快照。请重新 read_page 获取新快照后用新 ref 重试。`,
    );
    this.name = 'StaleRefError';
  }
}

function resolveRef(ref: string): Element {
  if (!currentSnapshot) {
    throw actionError('stale_ref', new StaleRefError(ref).message, 'resolve', true);
  }
  const prefix = `s${currentSnapshot.documentToken}_${currentSnapshot.snapshotId}_`;
  if (!ref.startsWith(prefix)) {
    throw actionError('stale_ref', new StaleRefError(ref).message, 'resolve', true);
  }
  const el = currentSnapshot.refMap.get(ref);
  if (!el || !el.isConnected) {
    throw actionError('stale_ref', new StaleRefError(ref).message, 'resolve', true);
  }
  const frameChain = currentSnapshot.frameMap.get(ref) ?? [];
  let expectedOwnerDocument = document;
  for (const { frame, document: frameDocument } of frameChain) {
    if (
      !frame.isConnected ||
      frame.ownerDocument !== expectedOwnerDocument ||
      frame.contentDocument !== frameDocument ||
      !frameDocument.defaultView
    ) {
      throw actionError('stale_ref', new StaleRefError(ref).message, 'resolve', true);
    }
    expectedOwnerDocument = frameDocument;
  }
  if (el.ownerDocument !== expectedOwnerDocument) {
    throw actionError('stale_ref', new StaleRefError(ref).message, 'resolve', true);
  }
  return el;
}

function refDocumentIdentity(
  snapshot: SnapshotResult,
  ref: string,
): RefDocumentIdentity | undefined {
  const element = snapshot.refMap.get(ref);
  const frameChain = snapshot.frameMap.get(ref);
  if (!element || !frameChain) return undefined;
  return {
    documentToken: snapshot.documentToken,
    rootDocument: frameChain[0]?.frame.ownerDocument ?? element.ownerDocument,
    ownerDocument: element.ownerDocument,
    frameChain: frameChain.map(({ frame, document: frameDocument }) => ({
      frame,
      ownerDocument: frame.ownerDocument,
      document: frameDocument,
    })),
  };
}

function sameRefDocumentIdentity(
  previous: RefDocumentIdentity,
  candidate: RefDocumentIdentity,
): boolean {
  if (
    previous.documentToken !== candidate.documentToken ||
    previous.rootDocument !== candidate.rootDocument ||
    previous.ownerDocument !== candidate.ownerDocument ||
    previous.frameChain.length !== candidate.frameChain.length
  ) {
    return false;
  }
  return previous.frameChain.every((frame, index) => {
    const candidateFrame = candidate.frameChain[index];
    return (
      candidateFrame?.frame === frame.frame &&
      candidateFrame.ownerDocument === frame.ownerDocument &&
      candidateFrame.document === frame.document
    );
  });
}

function resolveRefWithRecovery(
  ref: string,
  allowRecovery = false,
): { element: Element; recoveredRef?: string } {
  try {
    return { element: resolveRef(ref) };
  } catch (error) {
    if (!allowRecovery) throw error;
    if (!currentSnapshot || !ref.startsWith(`s${currentSnapshot.documentToken}_`)) throw error;
    const previous = priorHints.get(ref);
    if (!previous || !currentSnapshot) throw error;
    const hintMatches = [...currentSnapshot.hintMap.entries()].filter(
      ([, candidate]) =>
        candidate.role === previous.hint.role &&
        candidate.name === previous.hint.name &&
        candidate.tagName === previous.hint.tagName &&
        candidate.inputType === previous.hint.inputType &&
        candidate.label === previous.hint.label &&
        candidate.placeholder === previous.hint.placeholder,
    );
    const snapshot = currentSnapshot;
    const matches = hintMatches.filter(([candidateRef]) => {
      const identity = refDocumentIdentity(snapshot, candidateRef);
      return identity !== undefined && sameRefDocumentIdentity(previous.identity, identity);
    });
    if (matches.length === 0 && hintMatches.length > 0) throw error;
    if (matches.length !== 1) {
      throw actionError(
        'ambiguous_target',
        `旧 ref ${ref} 无法唯一恢复（候选 ${matches.length} 个），请重新 read_page。`,
        'recover',
      );
    }
    const match = matches[0];
    if (!match) throw error;
    const [recoveredRef] = match;
    return { element: resolveRef(recoveredRef), recoveredRef };
  }
}

interface RefRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function unsupportedFrameGeometry(reason: string): ActionError {
  return actionError(
    'unsupported_frame',
    '该 iframe 的几何变换无法安全映射到顶层视口；请使用 read_page_deep 获取新 ref。',
    'resolve',
    true,
    { reason },
  );
}

function assertAxisAlignedFrame(frame: HTMLIFrameElement): void {
  const view = frame.ownerDocument.defaultView;
  if (!view)
    throw actionError('stale_ref', 'iframe 文档已失效；请重新 read_page。', 'resolve', true);
  for (let element: Element | null = frame; element; element = element.parentElement) {
    const style = view.getComputedStyle(element);
    if (element === frame) {
      const padding = [
        style.paddingLeft,
        style.paddingTop,
        style.paddingRight,
        style.paddingBottom,
      ].map(Number.parseFloat);
      if (padding.some((value) => Number.isFinite(value) && Math.abs(value) > 0.01)) {
        throw unsupportedFrameGeometry('iframe_padding');
      }
    }
    if (!style.transform || style.transform === 'none') continue;
    const Matrix = view.DOMMatrixReadOnly;
    if (!Matrix) throw unsupportedFrameGeometry('transform_matrix_unavailable');
    let matrix: DOMMatrixReadOnly;
    try {
      matrix = new Matrix(style.transform);
    } catch {
      throw unsupportedFrameGeometry('unparseable_transform');
    }
    if (
      !matrix.is2D ||
      Math.abs(matrix.b) > 0.0001 ||
      Math.abs(matrix.c) > 0.0001 ||
      matrix.a <= 0 ||
      matrix.d <= 0
    ) {
      throw unsupportedFrameGeometry('non_axis_aligned_transform');
    }
  }
}

function mapRectToParentViewport(rect: RefRect, frame: HTMLIFrameElement): RefRect {
  assertAxisAlignedFrame(frame);
  const frameRect = frame.getBoundingClientRect();
  const childView = frame.contentWindow;
  if (!childView || frame.offsetWidth <= 0 || frame.offsetHeight <= 0) {
    throw actionError('stale_ref', 'iframe 已脱离页面；请重新 read_page。', 'resolve', true);
  }
  const outerScaleX = frameRect.width / frame.offsetWidth;
  const outerScaleY = frameRect.height / frame.offsetHeight;
  const viewportWidth = childView.innerWidth;
  const viewportHeight = childView.innerHeight;
  const contentScaleX = (frame.clientWidth * outerScaleX) / viewportWidth;
  const contentScaleY = (frame.clientHeight * outerScaleY) / viewportHeight;
  if (
    ![outerScaleX, outerScaleY, contentScaleX, contentScaleY].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    throw unsupportedFrameGeometry('invalid_frame_dimensions');
  }
  return {
    left: frameRect.left + frame.clientLeft * outerScaleX + rect.left * contentScaleX,
    top: frameRect.top + frame.clientTop * outerScaleY + rect.top * contentScaleY,
    width: rect.width * contentScaleX,
    height: rect.height * contentScaleY,
  };
}

function getRefViewportRect(ref: string): RefRect {
  const element = resolveRef(ref);
  const source = element.getBoundingClientRect();
  let rect: RefRect = {
    left: source.left,
    top: source.top,
    width: source.width,
    height: source.height,
  };
  const snapshot = currentSnapshot;
  if (!snapshot)
    throw actionError('stale_ref', '当前没有可用页面快照；请重新 read_page。', 'resolve', true);
  const frameChain = snapshot.frameMap.get(ref) ?? [];
  for (let index = frameChain.length - 1; index >= 0; index--) {
    const frameContext = frameChain[index];
    if (!frameContext) throw unsupportedFrameGeometry('missing_frame_context');
    rect = mapRectToParentViewport(rect, frameContext.frame);
  }
  return rect;
}

// ---------------------------------------------------------------------------
// Stabilization (docs/05 §4)
// ---------------------------------------------------------------------------

async function stabilize(
  context: ActionExecutionContext,
  opts = WAIT_DEFAULTS,
): Promise<{ timedOut: boolean }> {
  const start = Date.now();
  await waitWithContext(opts.minWaitMs, context);

  let lastMutation = Date.now();
  const observer = new MutationObserver(() => {
    lastMutation = Date.now();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  try {
    for (;;) {
      const now = Date.now();
      if (now - lastMutation >= opts.networkIdleMs) return { timedOut: false };
      if (now - start >= opts.maxWaitMs) return { timedOut: true };
      await waitWithContext(100, context);
    }
  } finally {
    observer.disconnect();
  }
}

const sleep = (ms: number, context: ActionExecutionContext = {}) =>
  waitWithContext(ms, context, 'execute');

// ---------------------------------------------------------------------------
// Visual feedback (docs/05 §5) — Shadow DOM isolated
// ---------------------------------------------------------------------------

let overlayHost: HTMLElement | null = null;
let indicatorOwner: string | null = null;

function getOverlay(): ShadowRoot {
  if (!overlayHost || !overlayHost.isConnected) {
    overlayHost = document.createElement('panelot-overlay');
    overlayHost.style.cssText =
      'all:initial;position:fixed;z-index:2147483647;pointer-events:none;';
    document.documentElement.appendChild(overlayHost);
    return overlayHost.attachShadow({ mode: 'open' });
  }
  return overlayHost.shadowRoot ?? overlayHost.attachShadow({ mode: 'open' });
}

function highlight(ref: string): void {
  try {
    const rect = getRefViewportRect(ref);
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

export function showIndicator(requestId: string, text: string): void {
  indicatorOwner = requestId;
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

export function hideIndicator(requestId: string): void {
  if (indicatorOwner !== requestId) return;
  indicatorOwner = null;
  overlayHost?.shadowRoot?.getElementById('indicator')?.remove();
}

function annotateRefs(): string {
  if (!currentSnapshot) takeSnapshot({});
  const snapshot = currentSnapshot;
  if (!snapshot) throw new Error('页面快照不可用');
  const shadow = getOverlay();
  shadow.getElementById('ref-annotations')?.remove();
  const layer = document.createElement('div');
  layer.id = 'ref-annotations';
  const legend: string[] = [];
  for (const [ref, element] of snapshot.refMap) {
    const rect = getRefViewportRect(ref);
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
const activeAgentRequests = new Set<string>();

// ---------------------------------------------------------------------------
// Dialog reports from the MAIN-world write-tool patch (injected by the gateway)
// ride along in the result so the model knows the dialog was dismissed.
// ---------------------------------------------------------------------------

const pendingDialogs = new Map<string, { kind: string; message: string; response: string }[]>();
let activeDialogRequestId: string | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('panelot:dialog', (e) => {
    try {
      const detail = JSON.parse((e as CustomEvent<string>).detail);
      if (!activeDialogRequestId) return;
      const reports = pendingDialogs.get(activeDialogRequestId) ?? [];
      reports.push(detail);
      pendingDialogs.set(activeDialogRequestId, reports);
    } catch {
      /* malformed — page interference, ignore */
    }
  });
}

function drainDialogReports(requestId: string): string {
  const reports = pendingDialogs.get(requestId) ?? [];
  pendingDialogs.delete(requestId);
  if (reports.length === 0) return '';
  const lines = reports.map((d) => `- ${d.kind}("${d.message.slice(0, 200)}") → ${d.response}`);
  return `\n[页面弹出了 ${lines.length} 个对话框，已按安全默认处理:\n${lines.join('\n')}]`;
}

export function watchManualOperation(onManual: () => void): void {
  manualHandler = onManual;
  for (const type of ['mousedown', 'keydown'] as const) {
    document.addEventListener(
      type,
      (e) => {
        if (e.isTrusted && activeAgentRequests.size === 0) manualHandler?.();
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

interface ActionVerification {
  verified: boolean;
  effects: string[];
}

interface ExecutedAction {
  text: string;
  verify?: () => ActionVerification;
  verificationRequired?: boolean;
  opensNewBrowsingContext?: boolean;
}

function elementEffectState(element: Element): string {
  const input = element instanceof HTMLInputElement ? element : null;
  const select = element instanceof HTMLSelectElement ? element : null;
  return JSON.stringify({
    text: element.textContent,
    value:
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.value
        : undefined,
    checked: input?.checked,
    selected: select ? [...select.selectedOptions].map((option) => option.value) : undefined,
    expanded: element.getAttribute('aria-expanded'),
    pressed: element.getAttribute('aria-pressed'),
    ariaChecked: element.getAttribute('aria-checked'),
    hidden: element.getAttribute('hidden'),
    open: element instanceof HTMLDetailsElement ? element.open : undefined,
  });
}

function isPanelotNode(node: Node): boolean {
  if (node === overlayHost) return true;
  if (!(node instanceof Element)) return false;
  return node.matches('panelot-overlay') || node.closest('panelot-overlay') !== null;
}

function observePageEffects(): { stop: () => string[] } {
  const beforeUrl = location.href;
  let mutationCount = 0;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (isPanelotNode(record.target)) continue;
      const changedNodes = [...record.addedNodes, ...record.removedNodes];
      if (changedNodes.length > 0 && changedNodes.every(isPanelotNode)) continue;
      mutationCount++;
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });
  return {
    stop: () => {
      observer.disconnect();
      const effects: string[] = [];
      if (location.href !== beforeUrl) effects.push('url_changed');
      if (mutationCount > 0) effects.push('dom_changed');
      return effects;
    },
  };
}

async function doClick(
  params: {
    ref: string;
    button?: 'left' | 'right';
    doubleClick?: boolean;
    allowRecovery?: boolean;
  },
  context: ActionExecutionContext,
): Promise<ExecutedAction> {
  const { element: resolved, recoveredRef } = resolveRefWithRecovery(
    params.ref,
    params.allowRecovery,
  );
  const el = resolved as HTMLElement;
  const baseTarget = document.querySelector('base[target]')?.getAttribute('target')?.toLowerCase();
  const link = el.closest('a[href]');
  const linkTarget = link ? (link.getAttribute('target')?.toLowerCase() ?? baseTarget) : undefined;
  const submitter = el.closest('button, input');
  const submitsForm =
    (submitter instanceof HTMLButtonElement && submitter.type === 'submit') ||
    (submitter instanceof HTMLInputElement && ['submit', 'image'].includes(submitter.type));
  const form = submitsForm ? submitter.form : null;
  const formTarget = form ? (form.getAttribute('target')?.toLowerCase() ?? baseTarget) : undefined;
  const opensNewBrowsingContext = [linkTarget, formTarget].some(
    (target) => !!target && !['_self', '_top', '_parent'].includes(target),
  );
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  await ensureActionable(el, 'click', new ActionDeadline(1500, context.signal, context.deadlineAt));
  const beforeState = elementEffectState(el);
  const beforeFocus = document.activeElement;
  highlight(recoveredRef ?? params.ref);
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
  return {
    text: `已点击${recoveredRef ? `（目标已恢复为 ${recoveredRef}）` : ''}`,
    opensNewBrowsingContext,
    verify: () => {
      const effects: string[] = [];
      if (el.isConnected && elementEffectState(el) !== beforeState)
        effects.push('target_state_changed');
      if (document.activeElement !== beforeFocus) effects.push('focus_changed');
      return { verified: false, effects };
    },
  };
}

async function doType(
  params: {
    ref: string;
    text: string;
    mode?: 'replace' | 'append';
    submit?: boolean;
    slowly?: boolean;
    allowRecovery?: boolean;
  },
  context: ActionExecutionContext,
): Promise<ExecutedAction> {
  const { element: resolved, recoveredRef } = resolveRefWithRecovery(
    params.ref,
    params.allowRecovery,
  );
  const el = resolved as HTMLElement;
  const form = params.submit ? (el.closest('form') as HTMLFormElement | null) : null;
  const baseTarget = document.querySelector('base[target]')?.getAttribute('target')?.toLowerCase();
  const formTarget = form ? (form.getAttribute('target')?.toLowerCase() ?? baseTarget) : undefined;
  const opensNewBrowsingContext =
    !!formTarget && !['_self', '_top', '_parent'].includes(formTarget);
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
  await ensureActionable(el, 'type', new ActionDeadline(1500, context.signal, context.deadlineAt));
  highlight(recoveredRef ?? params.ref);
  el.focus();

  const beforeValue =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : (el.textContent ?? '');
  const desiredValue = (params.mode === 'append' ? beforeValue : '') + params.text;

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (params.slowly) {
      // Char-by-char with key events for pickier frameworks.
      let acc = params.mode === 'append' ? beforeValue : '';
      for (const ch of params.text) {
        acc += ch;
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        setNativeValue(el, acc);
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
        await sleep(20, context);
      }
    } else {
      setNativeValue(el, desiredValue);
    }
    // Verify the value stuck (framework may have swallowed synthetic events).
    if (el.value !== desiredValue && !params.slowly) {
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
    form?.requestSubmit?.();
  }
  const changed = desiredValue !== beforeValue;
  return {
    text: `${changed ? '已输入' : '字段原本已是目标值，已派发输入事件但未观察到值变化'}${params.submit ? '并提交' : ''}${recoveredRef ? `（目标已恢复为 ${recoveredRef}）` : ''}`,
    verify: () => {
      const value =
        el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
          ? el.value
          : (el.textContent ?? '');
      const verified = changed && el.isConnected && value === desiredValue;
      return { verified, effects: verified ? ['value_set'] : [] };
    },
    verificationRequired: changed,
    opensNewBrowsingContext,
  };
}

async function doSelect(
  params: {
    ref: string;
    values: string[];
    allowRecovery?: boolean;
  },
  context: ActionExecutionContext,
): Promise<ExecutedAction> {
  const { element: el, recoveredRef } = resolveRefWithRecovery(params.ref, params.allowRecovery);
  await ensureActionable(
    el,
    'select',
    new ActionDeadline(1500, context.signal, context.deadlineAt),
  );
  if (!(el instanceof HTMLSelectElement)) {
    throw actionError('not_editable', `ref ${params.ref} 不是 select 元素`, 'precheck');
  }
  highlight(recoveredRef ?? params.ref);
  const selectedValues = () =>
    el.multiple
      ? [...el.options]
          .filter((option) => option.selected)
          .map((option) => option.value)
          .sort()
      : el.value
        ? [el.value]
        : [];
  const beforeSelection = selectedValues();
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
  const desiredSelection = selectedValues();
  const changed = JSON.stringify(beforeSelection) !== JSON.stringify(desiredSelection);
  dispatchInputEvents(el);
  return {
    text: `${changed ? `已选择 ${matched.join(', ')}` : `下拉框原本已选择 ${matched.join(', ')}，已派发选择事件但未观察到值变化`}${recoveredRef ? `（目标已恢复为 ${recoveredRef}）` : ''}`,
    verify: () => {
      const verified =
        changed &&
        el.isConnected &&
        JSON.stringify(selectedValues()) === JSON.stringify(desiredSelection);
      return { verified, effects: verified ? ['selection_set'] : [] };
    },
    verificationRequired: changed,
  };
}

async function doPressKey(params: { key: string }): Promise<string> {
  // 'Control+a' style combos.
  const parts = params.key.split('+');
  const key = parts.at(-1);
  if (!key) throw new Error('press_key 需要非空按键');
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
  highlight(params.ref);
  const opts = { bubbles: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, view: window }));
  el.dispatchEvent(new MouseEvent('mousemove', opts));
  return `已悬停`;
}

async function doWaitFor(
  params: {
    text?: string;
    textGone?: boolean | string;
    timeMs?: number;
  },
  context: ActionExecutionContext,
): Promise<string> {
  if (params.timeMs !== undefined) {
    await sleep(Math.min(params.timeMs, 30_000), context);
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
    await sleep(200, context);
  }
}

async function doUpload(params: {
  ref: string;
  filename: string;
  mime: string;
  base64: string;
}): Promise<ExecutedAction> {
  const el = resolveRef(params.ref);
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
    throw new Error(`ref ${params.ref} 不是文件输入框（<input type="file">）`);
  }
  highlight(params.ref);
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
  return {
    text: `已选择文件 ${params.filename}（${(bytes.length / 1024).toFixed(1)} KB）`,
    verify: () => ({
      verified: el.isConnected && el.files?.length === 1 && el.files[0]?.name === params.filename,
      effects: ['file_set'],
    }),
    verificationRequired: true,
  };
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
  const snapshot = currentSnapshot;
  if (!snapshot) throw new Error('页面快照不可用');
  const q = params.query.toLowerCase();
  const hits = snapshot.yaml
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
    for (const [ref, hint] of currentSnapshot.hintMap) {
      const identity = refDocumentIdentity(currentSnapshot, ref);
      if (identity) priorHints.set(ref, { hint, identity });
    }
    while (priorHints.size > 500) {
      const oldest = priorHints.keys().next();
      if (oldest.done) break;
      priorHints.delete(oldest.value);
    }
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

async function doBatch(
  params: BatchActionsParams,
  context: ActionExecutionContext,
): Promise<ExecutedAction> {
  if (params.actions.length > 4) throw new Error('batch_actions 最多 4 个动作');
  const executed: string[] = [];
  const verifications: { verify: () => ActionVerification; required: boolean }[] = [];
  const refCountBefore = currentSnapshot?.refMap.size ?? 0;

  for (const [i, action] of params.actions.entries()) {
    new ActionDeadline(Number.POSITIVE_INFINITY, context.signal, context.deadlineAt).throwIfDone();
    if (i > 0) await sleep(WAIT_DEFAULTS.betweenActionsMs, context);
    let result: ExecutedAction;
    switch (action.kind) {
      case 'click':
        result = await doClick(action.params as never, context);
        break;
      case 'type':
        result = await doType(action.params as never, context);
        break;
      case 'select_option':
        result = await doSelect(action.params as never, context);
        break;
    }
    executed.push(`${i + 1}. ${action.kind}: ${result.text}`);
    if (result.verify) {
      verifications.push({ verify: result.verify, required: result.verificationRequired === true });
    }

    if (result.opensNewBrowsingContext && i < params.actions.length - 1) {
      executed.push(
        `[动作目标可能打开新的浏览上下文，中断剩余 ${params.actions.length - i - 1} 个动作]`,
      );
      break;
    }

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
  return {
    text: executed.join('\n'),
    verify: () => {
      const results = verifications.map(({ verify, required }) => ({ ...verify(), required }));
      return {
        verified: results.filter((result) => result.required).every((result) => result.verified),
        effects: [...new Set(results.flatMap((result) => result.effects))],
      };
    },
    verificationRequired: verifications.some((verification) => verification.required),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const WRITE_ACTIONS = new Set([
  'click',
  'type',
  'select_option',
  'press_key',
  'hover',
  'batch_actions',
  'upload',
]);

export async function executeContentTool(
  tool: string,
  params: unknown,
  providedContext: ActionExecutionContext = {},
): Promise<ExecuteResult> {
  const requestId = providedContext.requestId ?? crypto.randomUUID();
  const context: ActionExecutionContext = {
    ...providedContext,
    requestId,
    deadlineAt: providedContext.deadlineAt ?? deadlineForTool(tool, params),
  };
  const deadline = new ActionDeadline(Number.POSITIVE_INFINITY, context.signal, context.deadlineAt);
  deadline.throwIfDone();
  activeAgentRequests.add(requestId);
  activeDialogRequestId = requestId;
  const effectObserver = WRITE_ACTIONS.has(tool) ? observePageEffects() : undefined;
  let effectsStopped = false;
  let actionDispatched = false;
  try {
    const parsedCall = parseContentToolCall(tool, params);
    if (!parsedCall.ok) throw new Error(`content script 参数无效：${parsedCall.diagnostic}`);
    const call = parsedCall.value;
    let resultText: string;
    let executedAction: ExecutedAction | undefined;
    const actionStart = Date.now();
    const actionGeneration = currentSnapshot?.snapshotId;

    switch (call.tool) {
      case 'read_page': {
        const mode = call.params.mode ?? 'snapshot';
        resultText = mode === 'article' ? articleExtract() : takeSnapshot(call.params);
        return { resultText };
      }
      case 'find_in_page':
        return { resultText: doFindInPage(call.params) };
      case 'extract':
        return { resultText: doExtract(call.params) };
      case 'get_selection':
        return { resultText: doGetSelection() };
      case 'get_rect': {
        const rect = getRefViewportRect(call.params.ref);
        const documentCoordinates = call.params.coordinateSpace !== 'viewport';
        return {
          resultText: `Bounds for ${call.params.ref}`,
          rect: {
            x: rect.left + (documentCoordinates ? window.scrollX : 0),
            y: rect.top + (documentCoordinates ? window.scrollY : 0),
            width: rect.width,
            height: rect.height,
          },
        };
      }
      case 'validate_ref':
        resolveRef(call.params.ref);
        return { resultText: 'ref valid' };
      case 'annotate_refs':
        return { resultText: annotateRefs() };
      case 'clear_annotations':
        clearRefAnnotations();
        return { resultText: 'annotations cleared' };
      case 'click':
        actionDispatched = true;
        executedAction = await doClick(call.params, context);
        resultText = executedAction.text;
        break;
      case 'type':
        actionDispatched = true;
        executedAction = await doType(call.params, context);
        resultText = executedAction.text;
        break;
      case 'select_option':
        actionDispatched = true;
        executedAction = await doSelect(call.params, context);
        resultText = executedAction.text;
        break;
      case 'focus': {
        // Focus for the CDP press_key path: bring the element into view and
        // give it keyboard focus so the trusted key lands on it.
        const el = resolveRef(call.params.ref) as HTMLElement;
        el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        el.focus();
        return { resultText: '已聚焦' };
      }
      case 'press_key':
        actionDispatched = true;
        resultText = await doPressKey(call.params);
        break;
      case 'scroll':
        resultText = await doScroll(call.params);
        break;
      case 'hover':
        actionDispatched = true;
        resultText = await doHover(call.params);
        break;
      case 'wait_for':
        return { resultText: await doWaitFor(call.params, context) };
      case 'batch_actions':
        actionDispatched = true;
        executedAction = await doBatch(call.params, context);
        resultText = executedAction.text;
        break;
      case 'upload':
        actionDispatched = true;
        executedAction = await doUpload(call.params);
        resultText = executedAction.text;
        break;
      default:
        throw new Error('content script 不支持未知工具');
    }

    // Write actions: stabilize, then return a fresh snapshot (docs/05 §1.3).
    let stabilized = true;
    if (WRITE_ACTIONS.has(tool)) {
      const { timedOut } = await stabilize(context);
      stabilized = !timedOut;
    }
    deadline.throwIfDone();
    const observedEffects = effectObserver?.stop() ?? [];
    effectsStopped = true;
    const verification = executedAction?.verify?.();
    if (executedAction?.verificationRequired && !verification?.verified) {
      throw actionError(
        'l1_not_effective',
        '动作派发后目标状态未能保持，页面可能回滚了该操作。',
        'verify',
        true,
        { effectState: observedEffects.length > 0 ? 'observed' : 'dispatched' },
      );
    }
    const allEffects = [...new Set([...observedEffects, ...(verification?.effects ?? [])])];
    const effectState: ActionEvidence['effectState'] = verification?.verified
      ? 'verified'
      : allEffects.length > 0
        ? 'observed'
        : 'dispatched';
    const outcome: ActionEvidence['outcome'] =
      effectState === 'verified' ? 'verified' : 'uncertain';
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
          effectState,
          observedEffects: allEffects,
          outcome,
        }
      : undefined;
    const effectNotice =
      effectState === 'dispatched'
        ? '\n[动作已派发，但未观察到可确认的页面效果。]'
        : effectState === 'observed'
          ? '\n[已观察到页面变化，但无法确认是否达到预期效果。]'
          : '';
    return {
      resultText:
        resultText +
        effectNotice +
        drainDialogReports(requestId) +
        (stabilized ? '' : '\n[页面可能未完全加载]'),
      snapshot,
      pageStabilized: stabilized,
      ...(evidence ? { evidence } : {}),
    };
  } catch (error) {
    if (
      error instanceof ActionError &&
      actionDispatched &&
      (error.failure.code === 'aborted' || error.failure.code === 'timeout')
    ) {
      throw new ActionError({
        ...error.failure,
        details: { ...error.failure.details, effectMayHaveOccurred: true },
      });
    }
    throw error;
  } finally {
    if (!effectsStopped) effectObserver?.stop();
    activeAgentRequests.delete(requestId);
    if (activeDialogRequestId === requestId) activeDialogRequestId = null;
    pendingDialogs.delete(requestId);
  }
}
