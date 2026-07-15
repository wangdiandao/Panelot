/**
 * ThreadSidebar — the full-page thread list column (docs/09 §3.1).
 *
 * Layout/interaction follows OpenWebUI's Sidebar with deliberate deltas:
 *  - user-resizable via a --sidebar-width CSS variable + drag strip
 *    (persisted, keyboard-resizable for a11y — OpenWebUI's handle is
 *    mouse-only), collapsible to a 48px icon rail;
 *  - rows show a time-ago label that yields to the ⋯ menu on hover AND
 *    :focus-within via a gradient overlay (no reflow);
 *  - inline rename (OpenWebUI ChatItem) with an IME guard for zh-CN;
 *  - active row = bg tint + left accent bar (LibreChat Convo — shape channel,
 *    not color-only); unread = dot + font-medium (two channels);
 *  - a status slot per row for agent activity (running / awaiting approval),
 *    lit by the activity map.
 * Settings/model controls intentionally live elsewhere (header), so this
 * column is exactly: new chat, search, list.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Ellipsis,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group';
import { Separator } from './ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import { handoffMenuCloseToApproval } from '../focusHandoff';
import type { ThreadMeta } from '../../db/types';
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_RAIL,
  SIDEBAR_WIDTH_VAR,
  clampSidebarWidth,
} from '../layoutTokens';

const ThreadDeleteDialog = lazy(() =>
  import('./ThreadDeleteDialog').then((module) => ({ default: module.ThreadDeleteDialog })),
);

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in tests/ui/threadSidebar.test.ts)
// ---------------------------------------------------------------------------

export interface ThreadGroup {
  id: 'pinned' | 'today' | 'yesterday' | 'week' | 'older';
  threads: ThreadMeta[];
}

/** Pinned first, then time buckets by updatedAt (OpenWebUI grouping). */
export function groupThreads(threads: ThreadMeta[], now = Date.now()): ThreadGroup[] {
  const dayMs = 86_400_000;
  const buckets: Record<ThreadGroup['id'], ThreadMeta[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  for (const th of threads) {
    if (th.pinned) {
      buckets.pinned.push(th);
      continue;
    }
    const age = now - th.updatedAt;
    if (age < dayMs) buckets.today.push(th);
    else if (age < 2 * dayMs) buckets.yesterday.push(th);
    else if (age < 7 * dayMs) buckets.week.push(th);
    else buckets.older.push(th);
  }
  return (Object.entries(buckets) as [ThreadGroup['id'], ThreadMeta[]][])
    .map(([id, threads]) => ({ id, threads }))
    .filter((g) => g.threads.length > 0);
}

/** Compact relative time (OpenWebUI ChatItem's 1m/3h/2d/1w). */
export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, now - ts) / 1000;
  if (s < 60) return t('time.now');
  if (s < 3600) return t('time.m', { n: Math.floor(s / 60) });
  if (s < 86_400) return t('time.h', { n: Math.floor(s / 3600) });
  if (s < 7 * 86_400) return t('time.d', { n: Math.floor(s / 86_400) });
  return t('time.w', { n: Math.floor(s / (7 * 86_400)) });
}

/** Unread = thread advanced since last seen, and it isn't the open thread. */
export function isUnread(
  thread: ThreadMeta,
  seen: Record<string, number>,
  activeThreadId: string | null,
): boolean {
  if (thread.id === activeThreadId) return false;
  const seenAt = seen[thread.id];
  return seenAt !== undefined && thread.updatedAt > seenAt;
}

// ---------------------------------------------------------------------------

/** Per-thread agent activity, from the engine client's activity store. */
export interface ThreadActivity {
  running: boolean;
  pendingApprovals: number;
}

interface SidebarDragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  lastWidth: number;
  target: HTMLElement;
  bodyUserSelect: string;
  bodyCursor: string;
}

interface Props {
  variant?: 'desktop' | 'mobile';
  threads: ThreadMeta[];
  activeThreadId: string | null;
  seen: Record<string, number>;
  activity?: ReadonlyMap<string, ThreadActivity>;
  collapsed: boolean;
  width: number;
  onWidthChange: (px: number) => void;
  onWidthCommit: (px: number) => void;
  onToggleCollapsed: () => void;
  onOpenThread: (id: string) => void;
  onNewThread: () => void;
  onTogglePin: (thread: ThreadMeta) => void;
  onRename: (thread: ThreadMeta, title: string) => void;
  onDelete: (thread: ThreadMeta) => void;
  /** Collapsed time-group ids (persisted in settings). */
  collapsedGroups?: string[];
  onToggleGroup?: (groupId: string) => void;
  /** Settings entry lives at the sidebar bottom (owner decision 2026-07-05). */
  onOpenSettings?: () => void;
  /** Focus the search input (also bound to the palette elsewhere). */
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

export function ThreadSidebar({
  variant = 'desktop',
  threads,
  activeThreadId,
  seen,
  activity,
  collapsed,
  width,
  onWidthChange,
  onWidthCommit,
  onToggleCollapsed,
  onOpenThread,
  onNewThread,
  onTogglePin,
  onRename,
  onDelete,
  collapsedGroups = [],
  onToggleGroup,
  onOpenSettings,
  searchInputRef,
}: Props) {
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ThreadMeta | null>(null);
  const drag = useRef<SidebarDragState | null>(null);
  const currentWidth = useRef(width);
  const currentCollapsed = useRef(collapsed);
  const widthCallbacks = useRef({ onWidthChange, onWidthCommit });
  currentWidth.current = width;
  currentCollapsed.current = collapsed;
  widthCallbacks.current = { onWidthChange, onWidthCommit };

  // Live width rides a CSS variable on <html> so drag is a single style write
  // (OpenWebUI's trick) — React state only commits on release.
  useEffect(() => {
    document.documentElement.style.setProperty(
      SIDEBAR_WIDTH_VAR,
      `${collapsed ? SIDEBAR_RAIL : clampSidebarWidth(width || SIDEBAR_DEFAULT)}px`,
    );
  }, [width, collapsed]);

  const finishDrag = useCallback((commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    document.body.style.userSelect = active.bodyUserSelect;
    document.body.style.cursor = active.bodyCursor;
    if (active.target.hasPointerCapture(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId);
    }
    if (commit) {
      widthCallbacks.current.onWidthChange(active.lastWidth);
      widthCallbacks.current.onWidthCommit(active.lastWidth);
    } else {
      document.documentElement.style.setProperty(
        SIDEBAR_WIDTH_VAR,
        `${currentCollapsed.current ? SIDEBAR_RAIL : clampSidebarWidth(currentWidth.current || SIDEBAR_DEFAULT)}px`,
      );
    }
  }, []);

  useEffect(() => {
    const onWindowBlur = () => finishDrag(false);
    window.addEventListener('blur', onWindowBlur);
    return () => {
      window.removeEventListener('blur', onWindowBlur);
      finishDrag(false);
    };
  }, [finishDrag]);

  useEffect(() => {
    if (collapsed) finishDrag(false);
  }, [collapsed, finishDrag]);

  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    e.preventDefault();
    finishDrag(false);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startWidth = clampSidebarWidth(width || SIDEBAR_DEFAULT);
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startWidth,
      lastWidth: startWidth,
      target,
      bodyUserSelect: document.body.style.userSelect,
      bodyCursor: document.body.style.cursor,
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== e.pointerId) return;
    active.lastWidth = clampSidebarWidth(active.startWidth + (e.clientX - active.startX));
    document.documentElement.style.setProperty(SIDEBAR_WIDTH_VAR, `${active.lastWidth}px`);
  };

  const filtered = search.trim()
    ? threads.filter((th) => (th.title || '').toLowerCase().includes(search.trim().toLowerCase()))
    : threads;
  const groups = groupThreads(filtered);

  if (collapsed && variant === 'desktop') {
    return (
      <aside className="hidden w-[var(--sidebar-width)] shrink-0 flex-col items-center gap-1 border-r border-border-soft bg-card py-3 lg:flex">
        {railButton(t('app.expandSidebar'), PanelLeftOpen, onToggleCollapsed)}
        {railButton(t('app.newChat'), Plus, onNewThread)}
        {railButton(t('app.searchThreads'), Search, () => {
          onToggleCollapsed();
          requestAnimationFrame(() => searchInputRef?.current?.focus());
        })}
        {onOpenSettings && (
          <div className="mt-auto">{railButton(t('app.settings'), Settings, onOpenSettings)}</div>
        )}
      </aside>
    );
  }

  return (
    <aside
      className={cn(
        'relative min-h-0 shrink-0 flex-col bg-card',
        variant === 'mobile'
          ? 'flex h-full w-full'
          : 'hidden w-[var(--sidebar-width)] border-r border-border-soft lg:flex',
      )}
    >
      <div className="flex items-center gap-1.5 p-3 pb-0">
        <Button
          variant="outline"
          className="h-8 min-w-0 flex-1 justify-start gap-2 text-[13px] font-medium"
          onClick={onNewThread}
        >
          <Plus data-icon="inline-start" /> {t('app.newChat')}
        </Button>
        {variant === 'desktop' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={t('app.collapseSidebar')}
                onClick={onToggleCollapsed}
              >
                <PanelLeftClose />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('app.collapseSidebar')}</TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="p-3 pb-1">
        <InputGroup className="h-8 border-transparent bg-muted shadow-none">
          <InputGroupAddon>
            <Search aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('app.searchThreads')}
            aria-label={t('app.searchThreads')}
            className="text-[13px]"
          />
        </InputGroup>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map((g) => {
          // Collapse only applies while browsing; search always shows hits.
          const collapsed = !search.trim() && collapsedGroups.includes(g.id);
          return (
            <div key={g.id} className="mb-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onToggleGroup?.(g.id)}
                aria-expanded={!collapsed}
                className="h-auto w-full justify-start"
              >
                {t(`group.${g.id}`)}
                {onToggleGroup && (
                  <ChevronDown
                    className={cn(
                      'size-3 opacity-60 transition-transform',
                      collapsed && '-rotate-90',
                    )}
                  />
                )}
                {collapsed && <span className="ml-auto normal-case">{g.threads.length}</span>}
              </Button>
              {!collapsed &&
                g.threads.map((th) => (
                  <ThreadRow
                    key={th.id}
                    thread={th}
                    active={th.id === activeThreadId}
                    unread={isUnread(th, seen, activeThreadId)}
                    activity={activity?.get(th.id)}
                    renaming={renamingId === th.id}
                    onOpen={() => onOpenThread(th.id)}
                    onTogglePin={() => onTogglePin(th)}
                    onStartRename={() => setRenamingId(th.id)}
                    onCommitRename={(title) => {
                      setRenamingId(null);
                      if (title.trim() && title !== th.title) onRename(th, title.trim());
                    }}
                    onCancelRename={() => setRenamingId(null)}
                    onDelete={() => setDeleting(th)}
                  />
                ))}
            </div>
          );
        })}
        {groups.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-faint-foreground">
            {search.trim() ? t('app.noMatchingThreads') : t('app.noThreads')}
          </div>
        )}
      </div>

      {onOpenSettings && (
        <div>
          <Separator />
          <div className="p-2">
            <Button
              variant="ghost"
              className="w-full justify-start gap-2 text-[13px] text-muted-foreground"
              onClick={onOpenSettings}
            >
              <Settings data-icon="inline-start" /> {t('app.settings')}
            </Button>
          </div>
        </div>
      )}

      {variant === 'desktop' && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('app.resizeSidebar')}
          tabIndex={0}
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => {
            if (drag.current?.pointerId === event.pointerId) finishDrag(true);
          }}
          onPointerCancel={(event) => {
            if (drag.current?.pointerId === event.pointerId) finishDrag(false);
          }}
          onLostPointerCapture={(event) => {
            if (drag.current?.pointerId === event.pointerId) finishDrag(false);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            const next = clampSidebarWidth(
              (width || SIDEBAR_DEFAULT) + (e.key === 'ArrowRight' ? 16 : -16),
            );
            onWidthChange(next);
            onWidthCommit(next);
          }}
          className="absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent hover:after:bg-primary/30 focus-visible:after:bg-primary/50"
        />
      )}

      {deleting && (
        <Suspense fallback={null}>
          <ThreadDeleteDialog
            thread={deleting}
            onClose={() => setDeleting(null)}
            onDelete={onDelete}
          />
        </Suspense>
      )}
    </aside>
  );
}

function railButton(label: string, Icon: typeof Plus, onClick: () => void) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} onClick={onClick}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------

interface RowProps {
  thread: ThreadMeta;
  active: boolean;
  unread: boolean;
  activity?: ThreadActivity;
  renaming: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}

function ThreadRow({
  thread,
  active,
  unread,
  activity,
  renaming,
  onOpen,
  onTogglePin,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: RowProps) {
  const [draft, setDraft] = useState(thread.title);
  const [menuFocusVisible, setMenuFocusVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (renaming) {
      setDraft(thread.title);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [renaming, thread.title]);

  const statusGlyph = activity?.pendingApprovals ? (
    <TriangleAlert className="size-3 shrink-0 text-warning" aria-label={t('app.needsApproval')} />
  ) : activity?.running ? (
    <Loader2 className="size-3 shrink-0 animate-spin text-info" aria-label={t('app.running')} />
  ) : unread ? (
    <span
      className="size-1.5 shrink-0 rounded-full bg-primary"
      role="img"
      aria-label={t('app.unread')}
    />
  ) : null;

  if (renaming) {
    return (
      <div className="rounded-lg bg-muted px-2.5 py-1">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // IME guard: composition-confirm Enter must not commit (zh-CN).
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') onCommitRename(draft);
            else if (e.key === 'Escape') onCancelRename();
          }}
          onBlur={() => onCommitRename(draft)}
          className="h-8 border-0 bg-transparent shadow-none focus-visible:ring-0"
          aria-label={t('app.rename')}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative flex items-center rounded-lg transition-colors',
        active
          ? 'bg-muted before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary'
          : 'hover:bg-muted/60',
      )}
    >
      <Button
        variant="ghost"
        onClick={onOpen}
        className={cn(
          'h-auto min-w-0 flex-1 justify-start rounded-lg px-2.5 py-2',
          unread && 'font-medium',
        )}
      >
        {statusGlyph}
        {thread.pinned && <Pin className="size-3 shrink-0 text-faint-foreground" />}
        <span className="truncate">{thread.title || t('app.untitled')}</span>
      </Button>

      {/* Right edge: time-ago at rest; the ⋯ menu fades in OVER it on
          hover/focus-within with a gradient so the row never reflows. */}
      <span
        aria-hidden
        className="pointer-events-none pr-2 text-[10px] text-faint-foreground group-focus-within:invisible group-hover:invisible"
      >
        {timeAgo(thread.updatedAt)}
      </span>
      <div
        className={cn(
          'absolute right-0 top-0 flex h-full items-center rounded-r-lg pl-6 pr-1',
          'bg-linear-to-l from-80% to-transparent',
          active ? 'from-muted' : 'from-card group-hover:from-muted/60',
          'invisible group-focus-within:visible group-hover:visible',
          menuFocusVisible && 'visible',
        )}
      >
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) setMenuFocusVisible(true);
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              ref={menuTriggerRef}
              variant="ghost"
              size="icon-xs"
              className="data-[state=open]:visible"
              aria-label={t('app.threadMenu', { title: thread.title || t('app.untitled') })}
            >
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-36"
            onCloseAutoFocus={(event) => {
              if (!handoffMenuCloseToApproval(event)) {
                event.preventDefault();
                menuTriggerRef.current?.focus({ preventScroll: true });
              }
              setMenuFocusVisible(false);
            }}
          >
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onTogglePin}>
                {thread.pinned ? <PinOff /> : <Pin />}
                {thread.pinned ? t('app.unpin') : t('app.pin')}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onStartRename}>
                <Pencil /> {t('app.rename')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" onClick={onDelete}>
                <Trash2 /> {t('app.delete')}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
