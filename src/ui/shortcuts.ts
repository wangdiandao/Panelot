/**
 * Central shortcut registry (docs/development/ui.md §6) — one typed table consumed by the
 * ShortcutHelp overlay and (progressively) the actual handlers, so the cheat
 * sheet and the bindings can't drift apart (OpenWebUI src/lib/shortcuts.ts /
 * LobeChat HOTKEYS_REGISTRATION pattern).
 *
 * `reserved` entries are the approval-card safety contract: Y/S/A/N/Esc are
 * fixed for the lifetime of the product — assertReservedKeysFree() lets any
 * future binding code verify it isn't colliding.
 */

export type ShortcutScope = 'global' | 'page' | 'composer' | 'stream' | 'approval';

export interface ShortcutDef {
  id: string;
  /** Display form, e.g. 'Ctrl/Cmd+K'. */
  keys: string;
  /** i18n key for the action label. */
  labelKey: string;
  scope: ShortcutScope;
  /** Safety-contract binding — must never be rebound or shadowed. */
  reserved?: boolean;
}

export const SHORTCUT_REGISTRY: ShortcutDef[] = [
  // Global / extension pages
  { id: 'togglePanel', keys: 'Alt+P', labelKey: 'keys.togglePanel', scope: 'global' },
  { id: 'palette', keys: 'Ctrl/Cmd+K', labelKey: 'keys.palette', scope: 'page' },
  { id: 'newChat', keys: 'Ctrl/Cmd+N', labelKey: 'keys.newChat', scope: 'page' },
  { id: 'settings', keys: 'Ctrl/Cmd+,', labelKey: 'keys.settings', scope: 'page' },
  { id: 'expand', keys: 'Ctrl/Cmd+E', labelKey: 'keys.expand', scope: 'page' },
  { id: 'toggleSidebar', keys: 'Ctrl/Cmd+Shift+S', labelKey: 'keys.toggleSidebar', scope: 'page' },
  { id: 'help', keys: '?', labelKey: 'keys.help', scope: 'page' },
  // Composer
  { id: 'send', keys: 'Enter', labelKey: 'keys.send', scope: 'composer' },
  { id: 'newline', keys: 'Shift+Enter', labelKey: 'keys.newline', scope: 'composer' },
  { id: 'steer', keys: 'Enter', labelKey: 'keys.steer', scope: 'composer' },
  { id: 'enqueue', keys: 'Shift+Alt+Enter', labelKey: 'keys.enqueue', scope: 'composer' },
  { id: 'stop', keys: 'Esc', labelKey: 'keys.stop', scope: 'composer' },
  { id: 'recallLast', keys: '↑', labelKey: 'keys.recallLast', scope: 'composer' },
  { id: 'triggers', keys: '@ / / / {{', labelKey: 'keys.triggers', scope: 'composer' },
  // Stream
  { id: 'branch', keys: 'Ctrl/Cmd+↑↓', labelKey: 'keys.branch', scope: 'stream' },
  { id: 'copyLast', keys: 'Ctrl/Cmd+Shift+C', labelKey: 'keys.copyLast', scope: 'stream' },
  { id: 'focusComposer', keys: 'Shift+Esc', labelKey: 'keys.focusComposer', scope: 'stream' },
  // Approval card — the fixed safety contract (docs/development/permissions.md §4).
  { id: 'approveOnce', keys: 'Y', labelKey: 'keys.approveOnce', scope: 'approval', reserved: true },
  {
    id: 'approveSession',
    keys: 'S',
    labelKey: 'keys.approveSession',
    scope: 'approval',
    reserved: true,
  },
  { id: 'approveSite', keys: 'A', labelKey: 'keys.approveSite', scope: 'approval', reserved: true },
  { id: 'decline', keys: 'N', labelKey: 'keys.decline', scope: 'approval', reserved: true },
  {
    id: 'declineStop',
    keys: 'Esc',
    labelKey: 'keys.declineStop',
    scope: 'approval',
    reserved: true,
  },
];

const RESERVED_KEYS = new Set(
  SHORTCUT_REGISTRY.filter((s) => s.reserved).map((s) => s.keys.toLowerCase()),
);

/**
 * Guard for future binding code: throws if a proposed single-key binding
 * would shadow the approval-card contract while an approval is focused.
 */
export function assertReservedKeysFree(key: string, scope: ShortcutScope): void {
  if (scope === 'approval' && RESERVED_KEYS.has(key.toLowerCase())) {
    throw new Error(`key "${key}" is reserved by the approval-card safety contract`);
  }
}

export function shortcutsByScope(): Map<ShortcutScope, ShortcutDef[]> {
  const map = new Map<ShortcutScope, ShortcutDef[]>();
  for (const s of SHORTCUT_REGISTRY) {
    const list = map.get(s.scope) ?? [];
    list.push(s);
    map.set(s.scope, list);
  }
  return map;
}
