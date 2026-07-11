/**
 * Accessibility snapshot engine (docs/05 §1) — runs inside the content script.
 *
 * Output format follows Playwright MCP's ariaSnapshot (YAML indent tree of
 * `role "name" [attrs] [ref=sN_M]`), with Chrome DevTools MCP's versioned-uid
 * pattern for refs: refs embed the snapshot id, and execution rejects any ref
 * whose prefix isn't the tab's CURRENT snapshot — killing state divergence at
 * the protocol level (nanobrowser/browser-use's chronic bug).
 *
 * Interactive detection is recall-first (docs/05 §1.2, nanobrowser's
 * missed-element lesson): any of four rules grants a ref; nested clickable
 * chains collapse to the innermost hit target.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SnapshotNode {
  role: string;
  name: string;
  ref?: string;
  attrs: string[];
  children: SnapshotNode[];
  /** Plain text content for text nodes. */
  text?: string;
}

export interface SnapshotResult {
  snapshotId: number;
  url: string;
  title: string;
  yaml: string;
  /** ref → element, kept by the content script for execution. */
  refMap: Map<string, Element>;
  truncatedNodes: number;
}

// ---------------------------------------------------------------------------
// Interactive detection (docs/05 §1.2)
// ---------------------------------------------------------------------------

const INTERACTIVE_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'option',
]);
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'option',
  'switch',
  'combobox',
  'slider',
  'radio',
  'searchbox',
  'textbox',
  'spinbutton',
]);

export function isInteractive(el: Element, win: Window): boolean {
  const tag = el.tagName.toLowerCase();
  // Rule 1: semantic tag / explicit role.
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = el.getAttribute('role');
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  // Rule 2: tabindex >= 0 or contenteditable.
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // Rule 3: cursor:pointer on the innermost element (checked by caller for innermost-ness).
  try {
    // Use the element's own window — `win` is the top frame, which can't
    // compute styles for elements inside same-origin iframes.
    const view = el.ownerDocument.defaultView ?? win;
    if (view.getComputedStyle(el).cursor === 'pointer') return true;
  } catch {
    /* detached */
  }
  return false;
  // Rule 4 (L2 getEventListeners) is an L2-only enhancement, applied upstream.
}

/**
 * Innermost-hit-target folding: an element is the hit target if it is
 * interactive and none of its DESCENDANTS that would receive the click is a
 * better (more specific) target. Practically: skip a pointer-cursor container
 * when it contains an interactive descendant (including inside shadow roots).
 */
function isInnermostTarget(el: Element, win: Window): boolean {
  if (!isInteractive(el, win)) return false;
  const tag = el.tagName.toLowerCase();
  // Semantic controls always win, even when nested inside each other (rare/invalid).
  if (INTERACTIVE_TAGS.has(tag)) return true;
  // Container-ish hits (cursor/tabindex/role) yield to interactive descendants.
  return !hasInteractiveDescendant(el, win);
}

const INTERACTIVE_SELECTOR =
  'a,button,input,select,textarea,summary,[role],[tabindex],[contenteditable]';

function hasInteractiveDescendant(el: Element, win: Window): boolean {
  for (const child of el.querySelectorAll(INTERACTIVE_SELECTOR)) {
    if (isInteractive(child, win)) return true;
  }
  if (el.shadowRoot) {
    for (const child of el.shadowRoot.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (isInteractive(child, win)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Role & accessible-name computation (pragmatic subset of ARIA spec)
// ---------------------------------------------------------------------------

const TAG_ROLE: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  summary: 'button',
  option: 'option',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  nav: 'navigation',
  main: 'main',
  form: 'form',
  table: 'table',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  dialog: 'dialog',
  label: 'label',
};

const INPUT_TYPE_ROLE: Record<string, string> = {
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
  button: 'button',
  submit: 'button',
  reset: 'button',
  file: 'button',
};

export function computeRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return INPUT_TYPE_ROLE[type] ?? 'textbox';
  }
  return TAG_ROLE[tag] ?? 'generic';
}

export function computeName(el: Element, win: Window): string {
  // ID lookups must use the element's own root — document.getElementById
  // can't see into shadow roots or same-origin iframes.
  const root = el.getRootNode() as Document | ShadowRoot;
  void win;
  // aria-labelledby > aria-label > <label for> > placeholder/alt/title > text content
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map(
        (id) =>
          root.getElementById?.(id)?.textContent?.trim() ??
          root.querySelector?.(`#${CSS.escape(id)}`)?.textContent?.trim() ??
          '',
      )
      .filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel?.trim()) return ariaLabel.trim();

  if (el.id) {
    const label = root.querySelector?.(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.textContent?.trim()) return label.textContent.trim();
  }
  const closestLabel = el.closest('label');
  if (closestLabel) {
    const text = [...closestLabel.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent?.trim())
      .join(' ')
      .trim();
    if (text) return text;
  }

  for (const attr of ['placeholder', 'alt', 'title']) {
    const v = el.getAttribute(attr);
    if (v?.trim()) return v.trim();
  }
  if (el.tagName.toLowerCase() === 'input') {
    const value = (el as HTMLInputElement).value;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if ((type === 'submit' || type === 'button') && value) return value;
  }

  const text = el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** ARIA state attributes rendered in brackets (docs/05 §1.1). */
export function computeAttrs(el: Element): string[] {
  const attrs: string[] = [];
  const tag = el.tagName.toLowerCase();

  if (tag === 'heading' || /^h[1-6]$/.test(tag)) attrs.push(`level=${tag[1]}`);

  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const input = el as HTMLInputElement;
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    // Role already conveys checkbox/radio/search etc. — only surface types the
    // role doesn't (password, email, date…).
    if (type && type !== 'text' && !(type in INPUT_TYPE_ROLE)) attrs.push(`type=${type}`);
    if (type === 'checkbox' || type === 'radio') {
      if (input.checked) attrs.push('checked');
    } else if (input.value) {
      attrs.push(
        `value="${input.value.length > 40 ? `${input.value.slice(0, 37)}…` : input.value}"`,
      );
    }
  }
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true')
    attrs.push('disabled');
  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) attrs.push(expanded === 'true' ? 'expanded' : 'collapsed');
  if (el.getAttribute('aria-selected') === 'true' || (el as HTMLOptionElement).selected === true)
    attrs.push('selected');
  if (el.getAttribute('aria-checked') === 'true') attrs.push('checked');
  if (el.getAttribute('aria-invalid') === 'true') attrs.push('invalid');
  if (el.getAttribute('aria-current')) attrs.push('current');
  return attrs;
}

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'meta',
  'link',
  'head',
  'svg',
  'path',
]);

/** Structural roles kept even when non-interactive (context for the model). */
const STRUCTURAL_ROLES = new Set([
  'heading',
  'navigation',
  'main',
  'form',
  'table',
  'list',
  'listitem',
  'dialog',
  'img',
]);

function isHidden(el: Element, win: Window): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if ((el as HTMLElement).hidden) return true;
  try {
    const view = el.ownerDocument.defaultView ?? win;
    const style = view.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  } catch {
    return false;
  }
}

export interface BuildOptions {
  snapshotId: number;
  maxTokens?: number;
}

const MAX_IFRAME_DEPTH = 4;

export function buildSnapshot(win: Window, opts: BuildOptions): SnapshotResult {
  const doc = win.document;
  const refMap = new Map<string, Element>();
  let refIndex = 0;
  let iframeDepth = 0;
  const sid = opts.snapshotId;

  /** Children in composed-tree order: open shadow root replaces light children. */
  function childrenOf(el: Element): SnapshotNode[] {
    // Open shadow DOM: walk the shadow tree (the rendered content). Slotted
    // light-DOM children are reached through their <slot>'s assignedElements.
    if (el.shadowRoot) {
      const results: SnapshotNode[] = [];
      for (const child of el.shadowRoot.children) results.push(...walk(child));
      return results;
    }
    if (el.tagName.toLowerCase() === 'slot') {
      const assigned = (el as HTMLSlotElement).assignedElements();
      if (assigned.length > 0) {
        const results: SnapshotNode[] = [];
        for (const child of assigned) results.push(...walk(child));
        return results;
      }
    }
    const results: SnapshotNode[] = [];
    for (const child of el.children) results.push(...walk(child));
    return results;
  }

  function walkIframe(el: HTMLIFrameElement): SnapshotNode[] {
    // Same-origin frames are walked recursively (login/payment forms live in
    // iframes); cross-origin frames are announced as a blind spot so the
    // model knows content exists that it cannot see.
    let frameBody: Element | null = null;
    try {
      frameBody = el.contentDocument?.body ?? null;
    } catch {
      frameBody = null;
    }
    const label = el.title || el.getAttribute('aria-label') || el.src || '';
    if (!frameBody) {
      return [{ role: 'iframe', name: label, attrs: ['跨域不可见'], children: [] }];
    }
    // Depth guard: a same-origin self-embedding frame (dev harness, or a
    // hostile page nesting frames to DoS the perception layer) would recurse
    // unbounded and crash the whole snapshot.
    if (iframeDepth >= MAX_IFRAME_DEPTH) {
      return [{ role: 'iframe', name: label, attrs: ['递归深度超限'], children: [] }];
    }
    const node: SnapshotNode = { role: 'iframe', name: label, attrs: [], children: [] };
    iframeDepth++;
    try {
      for (const child of frameBody.children) node.children.push(...walk(child));
    } finally {
      iframeDepth--;
    }
    return [node];
  }

  function walk(el: Element): SnapshotNode[] {
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag) || isHidden(el, win)) return [];
    if (tag === 'iframe') return walkIframe(el as HTMLIFrameElement);

    const interactive = isInnermostTarget(el, win);
    const role = computeRole(el);
    const structural = STRUCTURAL_ROLES.has(role);

    if (interactive || structural) {
      const node: SnapshotNode = {
        role,
        name: computeName(el, win),
        attrs: computeAttrs(el),
        children: [],
      };
      if (interactive) {
        refIndex++;
        node.ref = `s${sid}_${refIndex}`;
        refMap.set(node.ref, el);
      }
      // Interactive leaf: don't descend (name already summarizes content).
      // Structural/containers: descend for children. A shadow host that is
      // ALSO interactive (custom element with role=button) must still descend
      // into its shadow root — its label/content lives there, not in light DOM.
      if (
        !interactive ||
        el.shadowRoot ||
        ['form', 'combobox', 'list', 'table', 'dialog', 'navigation'].includes(role)
      ) {
        node.children.push(...childrenOf(el));
      }
      return [node];
    }

    // Web component hosts / slots without their own role: splice through.
    if (el.shadowRoot || tag === 'slot') return childrenOf(el);

    // Generic containers: splice children up; capture standalone text.
    const results: SnapshotNode[] = [];
    let textBuf = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        textBuf += child.textContent ?? '';
      } else if (child.nodeType === 1) {
        const flushed = textBuf.replace(/\s+/g, ' ').trim();
        if (flushed) {
          results.push({ role: 'text', name: '', attrs: [], children: [], text: flushed });
          textBuf = '';
        }
        results.push(...walk(child as Element));
      }
    }
    const flushed = textBuf.replace(/\s+/g, ' ').trim();
    if (flushed) results.push({ role: 'text', name: '', attrs: [], children: [], text: flushed });
    return results;
  }

  const roots = walk(doc.body ?? doc.documentElement);

  // Serialize with token cap (docs/05 §1.3): drop non-interactive text first.
  const { yaml, truncated } = serialize(roots, opts.maxTokens ?? 3000);

  const header = `# Page Snapshot (s${sid})\nURL: ${win.location.href}\nTitle: ${doc.title}\n\n`;
  return {
    snapshotId: sid,
    url: win.location.href,
    title: doc.title,
    yaml: header + yaml + (truncated > 0 ? `\n[已截断: ${truncated} 个节点]` : ''),
    refMap,
    truncatedNodes: truncated,
  };
}

// ---------------------------------------------------------------------------
// Serialization with budget (never silently truncate — docs/05 §1.3)
// ---------------------------------------------------------------------------

function serialize(roots: SnapshotNode[], maxTokens: number): { yaml: string; truncated: number } {
  const maxChars = maxTokens * 4;
  const lines: string[] = [];
  let truncated = 0;
  let budget = maxChars;

  function emit(node: SnapshotNode, depth: number): void {
    let line: string;
    if (node.role === 'text') {
      const text = node.text ?? '';
      line = `${'  '.repeat(depth)}- text: "${text.length > 120 ? `${text.slice(0, 117)}…` : text}"`;
      if (budget - line.length < 0) {
        truncated++;
        return; // text is the first casualty
      }
    } else {
      const parts = [`${'  '.repeat(depth)}- ${node.role}`];
      if (node.name) parts.push(`"${node.name}"`);
      for (const attr of node.attrs) parts.push(`[${attr}]`);
      if (node.ref) parts.push(`[ref=${node.ref}]`);
      line = parts.join(' ');
      if (budget - line.length < 0 && !node.ref) {
        truncated++;
        return; // non-interactive structure dropped under pressure; refs always kept
      }
    }
    lines.push(line);
    budget -= line.length + 1;
    for (const child of node.children) emit(child, depth + 1);
  }

  for (const root of roots) emit(root, 0);
  return { yaml: lines.join('\n'), truncated };
}
