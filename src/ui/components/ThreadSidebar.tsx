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

import { useEffect, useRef, useState } from 'react';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import type { ThreadMeta } from '../../db/types';
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_RAIL,
  SIDEBAR_WIDTH_VAR,
  clampSidebarWidth,
} from '../layoutTokens';

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
    pinned: [], today: [], yesterday: [], week: [], older: [],
  };
  for (const th of threads) {
    if (th.pinned) { buckets.pinned.push(th); continue; }
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
export function isUnread(thread: ThreadMeta, seen: Record<string, number>, activeThreadId: string | null): boolean {
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

interface Props {
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
  const dragging = useRef(false);

  // Live width rides a CSS variable on <html> so drag is a single style write
  // (OpenWebUI's trick) — React state only commits on release.
  useEffect(() => {
    document.documentElement.style.setProperty(
      SIDEBAR_WIDTH_VAR,
      `${collapsed ? SIDEBAR_RAIL : clampSidebarWidth(width || SIDEBAR_DEFAULT)}px`,
    );
  }, [width, collapsed]);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = clampSidebarWidth(width || SIDEBAR_DEFAULT);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    let lastW = startW;
    const onMove = (ev: PointerEvent) => {
      lastW = clampSidebarWidth(startW + (ev.clientX - startX));
      document.documentElement.style.setProperty(SIDEBAR_WIDTH_VAR, `${lastW}px`);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      onWidthChange(lastW);
      onWidthCommit(lastW);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const filtered = search.trim()
    ? threads.filter((th) => (th.title || '').toLowerCase().includes(search.trim().toLowerCase()))
    : threads;
  const groups = groupThreads(filtered);

  if (collapsed) {
    return (
      <aside className="flex w-[var(--sidebar-width)] shrink-0 flex-col items-center gap-1 border-r border-border-soft bg-card py-3">
        {railButton(t('app.expandSidebar'), PanelLeftOpen, onToggleCollapsed)}
        {railButton(t('app.newChat'), Plus, onNewThread)}
        {railButton(t('app.searchThreads'), Search, () => {
          onToggleCollapsed();
          requestAnimationFrame(() => searchInputRef?.current?.focus());
        })}
        {onOpenSettings && <div className="mt-auto">{railButton(t('app.settings'), Settings, onOpenSettings)}</div>}
      </aside>
    );
  }

  return (
    <aside className="relative flex w-[var(--sidebar-width)] shrink-0 flex-col border-r border-border-soft bg-card">
      <div className="flex items-center gap-1.5 p-3 pb-0">
        <Button
          variant="outline"
          className="h-8 min-w-0 flex-1 justify-start gap-2 text-[13px] font-medium"
          onClick={onNewThread}
        >
          <Plus className="size-4" /> {t('app.newChat')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground"
              aria-label={t('app.collapseSidebar')}
              onClick={onToggleCollapsed}
            >
              <PanelLeftClose className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t('app.collapseSidebar')}</TooltipContent>
        </Tooltip>
      </div>
      <div className="p-3 pb-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
          <Input
            ref={searchInputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('app.searchThreads')}
            className="h-8 border-transparent bg-muted pl-8 text-[13px] shadow-none"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.map((g) => {
          // Collapse only applies while browsing; search always shows hits.
          const collapsed = !search.trim() && collapsedGroups.includes(g.id);
          return (
          <div key={g.id} className="mb-3">
            <button
              type="button"
              onClick={() => onToggleGroup?.(g.id)}
              aria-expanded={!collapsed}
              className="flex w-full items-center gap-1 rounded px-2 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-faint-foreground hover:text-muted-foreground"
            >
              {t(`group.${g.id}`)}
              {onToggleGroup && (
                <ChevronDown className={cn('size-3 opacity-60 transition-transform', collapsed && '-rotate-90')} />
              )}
              {collapsed && <span className="ml-auto normal-case">{g.threads.length}</span>}
            </button>
            {!collapsed && g.threads.map((th) => (
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
        <div className="border-t border-border-soft p-2">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-[13px] text-muted-foreground"
            onClick={onOpenSettings}
          >
            <Settings className="size-4 opacity-70" /> {t('app.settings')}
          </Button>
        </div>
      )}

      {/* Resize strip: 12px hit area straddling the border; keyboard-resizable. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('app.resizeSidebar')}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const next = clampSidebarWidth((width || SIDEBAR_DEFAULT) + (e.key === 'ArrowRight' ? 16 : -16));
          onWidthChange(next);
          onWidthCommit(next);
        }}
        className="absolute -right-1.5 top-0 z-10 h-full w-3 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] after:-translate-x-1/2 after:bg-transparent hover:after:bg-primary/30 focus-visible:after:bg-primary/50"
      />

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('app.deleteConfirmTitle')} <b>{deleting?.title || t('app.untitled')}</b>
            </AlertDialogTitle>
            <AlertDialogDescription>{t('app.deleteConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('app.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) onDelete(deleting);
                setDeleting(null);
              }}
            >
              {t('app.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

function railButton(label: string, Icon: typeof Plus, onClick: () => void) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className="size-9 text-muted-foreground" aria-label={label} onClick={onClick}>
          <Icon className="size-4" />
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
  thread, active, unread, activity, renaming,
  onOpen, onTogglePin, onStartRename, onCommitRename, onCancelRename, onDelete,
}: RowProps) {
  const [draft, setDraft] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement>(null);

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
    <span className="size-1.5 shrink-0 rounded-full bg-primary" role="img" aria-label={t('app.unread')} />
  ) : null;

  if (renaming) {
    return (
      <div className="rounded-lg bg-muted px-2.5 py-1">
        <input
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
          className="w-full bg-transparent py-1 text-[13px] outline-none"
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
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-2 text-left text-[13px]',
          unread && 'font-medium',
        )}
      >
        {statusGlyph}
        {thread.pinned && <Pin className="size-3 shrink-0 text-faint-foreground" />}
        <span className="truncate">{thread.title || t('app.untitled')}</span>
      </button>

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
        )}
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-faint-foreground data-[state=open]:visible"
              aria-label={t('app.threadMenu', { title: thread.title || t('app.untitled') })}
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-36">
            <DropdownMenuItem onClick={onTogglePin}>
              {thread.pinned ? <PinOff /> : <Pin />}
              {thread.pinned ? t('app.unpin') : t('app.pin')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onStartRename}>
              <Pencil /> {t('app.rename')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 /> {t('app.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
