import { actionError } from '../action/errors';
import { ActionDeadline } from '../action/deadline';

export type ActionabilityKind = 'click' | 'type' | 'select';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function disabled(el: Element): boolean {
  if (el.closest('[inert]')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  return 'disabled' in el && Boolean((el as HTMLButtonElement).disabled);
}

function visible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse'
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  // DOM test environments commonly have no layout. Connected elements with
  // no layout engine remain actionable; real Chrome always supplies rects.
  const layoutAvailable = document.documentElement.getBoundingClientRect().width > 0;
  return !layoutAvailable || (rect.width > 0 && rect.height > 0);
}

function editable(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return !el.readOnly && !el.disabled;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

function receivesEvents(el: Element): { ok: true } | { ok: false; blocker: Element } {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || typeof document.elementFromPoint !== 'function') {
    return { ok: true };
  }
  const points = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + Math.min(4, rect.width / 2), rect.top + Math.min(4, rect.height / 2)],
  ];
  let blocker: Element | null = null;
  for (const point of points) {
    const [x, y] = point;
    if (x === undefined || y === undefined) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return { ok: true };
    blocker ??= hit;
    const root = hit.getRootNode();
    if (root instanceof ShadowRoot && el.contains(root.host)) return { ok: true };
  }
  return blocker ? { ok: false, blocker } : { ok: true };
}

async function stable(el: Element, deadline: ActionDeadline): Promise<boolean> {
  const first = el.getBoundingClientRect();
  await sleep(Math.min(50, deadline.remaining()));
  deadline.throwIfDone();
  if (!el.isConnected) return false;
  const second = el.getBoundingClientRect();
  return (
    Math.abs(first.x - second.x) <= 1 &&
    Math.abs(first.y - second.y) <= 1 &&
    Math.abs(first.width - second.width) <= 1 &&
    Math.abs(first.height - second.height) <= 1
  );
}

export async function ensureActionable(
  el: Element,
  kind: ActionabilityKind,
  deadline = new ActionDeadline(1500),
): Promise<void> {
  if (!el.isConnected) throw actionError('detached', '目标元素已从页面移除。', 'precheck', true);
  if (!visible(el)) throw actionError('not_visible', '目标元素当前不可见。', 'precheck', true);
  if (disabled(el)) throw actionError('disabled', '目标元素已禁用。', 'precheck');
  if (kind === 'type' && !editable(el)) {
    throw actionError('not_editable', '目标元素不可编辑。', 'precheck');
  }
  if (kind === 'select' && !(el instanceof HTMLSelectElement)) {
    throw actionError('not_editable', '目标元素不是下拉选择框。', 'precheck');
  }
  if (!(await stable(el, deadline))) {
    throw actionError('not_stable', '目标元素仍在移动或已从页面移除。', 'precheck', true);
  }
  const hit = receivesEvents(el);
  if (!hit.ok) {
    const blocker = hit.blocker;
    throw actionError(
      'occluded',
      `目标元素被 <${blocker.tagName.toLowerCase()}${blocker.id ? ` id="${blocker.id}"` : ''}> 遮挡。`,
      'precheck',
      true,
    );
  }
}
