/**
 * TriggerMenu (docs/09 §5): unified @ / slash / {{variable}} suggestion menu
 * anchored above the composer. Interaction follows ChatGPT's slash menu: the
 * trigger fires at line start or after whitespace; ↑↓ selects, Enter/Tab
 * confirms, Esc closes without disturbing the input. Focus STAYS in the
 * textarea — the menu is a controlled floating panel (cmdk in controlled
 * mode), not a focus-stealing Popover.
 *
 * Keyboard arbitration with PromptInput's state machine: while the menu is
 * open, PromptInput must route ArrowUp/ArrowDown/Enter/Tab/Esc here first
 * (via TriggerMenuHandle.handleKeyDown returning true = consumed).
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { AppWindow, AtSign, Braces, Camera, FileText, Slash, TextCursor } from 'lucide-react';
import { t } from '../i18n';
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from './ui/command';
import { Popover, PopoverAnchor, PopoverContent } from './ui/popover';

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

export type TriggerKind = '@' | '/' | '{{';

export interface TriggerState {
  kind: TriggerKind;
  /** Index in the text where the trigger starts. */
  start: number;
  /** Query typed after the trigger so far. */
  query: string;
}

/**
 * Detect an active trigger ending at the caret. `@` and `/` must sit at line
 * start or after whitespace (ChatGPT rule); `{{` may appear anywhere.
 */
export function detectTrigger(text: string, caret: number): TriggerState | null {
  const before = text.slice(0, caret);

  const brace = /\{\{([A-Za-z_]*)$/.exec(before);
  if (brace) return { kind: '{{', start: caret - brace[0].length, query: brace[1] ?? '' };

  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { kind: '@', start: caret - (at[2]?.length ?? 0) - 1, query: at[2] ?? '' };

  const slash = /(^|\s)\/([a-z0-9:_.-]*)$/i.exec(before);
  if (slash)
    return { kind: '/', start: caret - (slash[2]?.length ?? 0) - 1, query: slash[2] ?? '' };

  return null;
}

// ---------------------------------------------------------------------------
// Item model — callers supply the entries per trigger kind
// ---------------------------------------------------------------------------

export interface TriggerItem {
  id: string;
  kind: TriggerKind;
  /** Grouping header, e.g. "上下文" / "命令" / "变量". */
  group: string;
  label: string;
  hint?: string;
  icon?: 'page' | 'selection' | 'screenshot' | 'tab' | 'command' | 'variable';
  /** What happens on confirm. */
  action: () => void | Promise<void>;
}

const ICONS = {
  page: FileText,
  selection: TextCursor,
  screenshot: Camera,
  tab: AppWindow,
  command: Slash,
  variable: Braces,
} as const;

export interface TriggerMenuHandle {
  /** Returns true when the key was consumed by the menu. */
  handleKeyDown(e: React.KeyboardEvent): boolean;
}

interface Props {
  open: boolean;
  items: TriggerItem[];
  query: string;
  onClose: () => void;
}

/**
 * Controlled cmdk listbox floating above the composer. Selection state lives
 * in cmdk; we drive it with forwarded keyboard events so the textarea keeps
 * focus (pattern borrowed from cmdk's controlled examples).
 */
export const TriggerMenu = forwardRef<TriggerMenuHandle, Props>(function TriggerMenu(
  { open, items, query, onClose },
  ref,
) {
  const [selected, setSelected] = useState('');

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return items.filter(
      (i) => !q || i.label.toLowerCase().includes(q) || i.id.toLowerCase().includes(q),
    );
  }, [items, query]);

  // Keep the selection on a visible item as the query narrows.
  useEffect(() => {
    const firstFiltered = filtered[0];
    if (!firstFiltered) return;
    if (!filtered.some((i) => i.id === selected)) setSelected(firstFiltered.id);
  }, [filtered, selected]);

  useImperativeHandle(
    ref,
    () => ({
      handleKeyDown(e: React.KeyboardEvent): boolean {
        if (!open) return false;
        if (e.key === 'Escape') {
          onClose();
          return true;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const idx = filtered.findIndex((i) => i.id === selected);
          const next =
            e.key === 'ArrowDown' ? Math.min(idx + 1, filtered.length - 1) : Math.max(idx - 1, 0);
          if (filtered[next]) setSelected(filtered[next].id);
          return true;
        }
        if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
          const item = filtered.find((i) => i.id === selected) ?? filtered[0];
          if (item) {
            void item.action();
            onClose();
            return true;
          }
          onClose();
          return false; // nothing to confirm — let Enter send
        }
        return false;
      },
    }),
    [open, filtered, selected, onClose],
  );

  const groups = new Map<string, TriggerItem[]>();
  for (const item of filtered) {
    const g = groups.get(item.group) ?? [];
    g.push(item);
    groups.set(item.group, g);
  }

  return (
    <Popover open={open} onOpenChange={(next) => !next && onClose()}>
      <PopoverAnchor asChild>
        <span className="pointer-events-none absolute inset-x-0 bottom-0" />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <Command shouldFilter={false} value={selected} onValueChange={setSelected}>
          <CommandList className="max-h-56">
            <CommandEmpty>{t('palette.noResults')}</CommandEmpty>
            {[...groups.entries()].map(([group, groupItems]) => (
              <CommandGroup key={group} heading={group}>
                {groupItems.map((item) => {
                  const Icon = item.icon ? ICONS[item.icon] : AtSign;
                  return (
                    <CommandItem
                      key={item.id}
                      value={item.id}
                      onSelect={() => {
                        void item.action();
                        onClose();
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                    >
                      <Icon />
                      <span className="truncate">{item.label}</span>
                      {item.hint && (
                        <span className="ml-auto truncate text-xs text-muted-foreground">
                          {item.hint}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
});
