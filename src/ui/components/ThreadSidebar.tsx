import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  CircleHelp,
  Ellipsis,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from './ui/sidebar';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import { handoffMenuCloseToApproval } from '../focusHandoff';
import type { ThreadMeta } from '../../db/types';
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, clampSidebarWidth } from '../layoutTokens';

const ThreadDeleteDialog = lazy(() =>
  import('./ThreadDeleteDialog').then((module) => ({ default: module.ThreadDeleteDialog })),
);

export interface ThreadGroup {
  id: 'pinned' | 'today' | 'yesterday' | 'week' | 'older';
  threads: ThreadMeta[];
}

export function groupThreads(threads: ThreadMeta[], now = Date.now()): ThreadGroup[] {
  const dayMs = 86_400_000;
  const buckets: Record<ThreadGroup['id'], ThreadMeta[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    older: [],
  };
  for (const thread of threads) {
    if (thread.pinned) {
      buckets.pinned.push(thread);
      continue;
    }
    const age = now - thread.updatedAt;
    if (age < dayMs) buckets.today.push(thread);
    else if (age < 2 * dayMs) buckets.yesterday.push(thread);
    else if (age < 7 * dayMs) buckets.week.push(thread);
    else buckets.older.push(thread);
  }
  return (Object.entries(buckets) as [ThreadGroup['id'], ThreadMeta[]][])
    .map(([id, groupedThreads]) => ({ id, threads: groupedThreads }))
    .filter((group) => group.threads.length > 0);
}

export function timeAgo(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, now - timestamp) / 1000;
  if (seconds < 60) return t('time.now');
  if (seconds < 3600) return t('time.m', { n: Math.floor(seconds / 60) });
  if (seconds < 86_400) return t('time.h', { n: Math.floor(seconds / 3600) });
  if (seconds < 7 * 86_400) return t('time.d', { n: Math.floor(seconds / 86_400) });
  return t('time.w', { n: Math.floor(seconds / (7 * 86_400)) });
}

export function isUnread(
  thread: ThreadMeta,
  seen: Record<string, number>,
  activeThreadId: string | null,
): boolean {
  if (thread.id === activeThreadId) return false;
  const seenAt = seen[thread.id];
  return seenAt !== undefined && thread.updatedAt > seenAt;
}

export interface ThreadActivity {
  running: boolean;
  pendingApprovals: number;
  pendingInteractions?: number;
}

interface Props {
  threads: ThreadMeta[];
  activeThreadId: string | null;
  seen: Record<string, number>;
  activity?: ReadonlyMap<string, ThreadActivity>;
  collapsed: boolean;
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  onToggleCollapsed?: () => void;
  onOpenThread: (id: string) => void;
  onNewThread: () => void;
  onTogglePin: (thread: ThreadMeta) => void;
  onRename: (thread: ThreadMeta, title: string) => void;
  onDelete: (thread: ThreadMeta) => void;
  collapsedGroups?: string[];
  onToggleGroup?: (groupId: string) => void;
  onOpenSettings?: () => void;
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
  const { toggleSidebar } = useSidebar();
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ThreadMeta | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    lastWidth: number;
    target: HTMLElement;
    wrapper: HTMLElement;
    bodyUserSelect: string;
    bodyCursor: string;
  } | null>(null);

  const finishDrag = (commit: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null;
    document.body.style.userSelect = active.bodyUserSelect;
    document.body.style.cursor = active.bodyCursor;
    if (active.target.hasPointerCapture(active.pointerId)) {
      active.target.releasePointerCapture(active.pointerId);
    }
    if (commit) {
      onWidthChange(active.lastWidth);
      onWidthCommit(active.lastWidth);
    } else {
      active.wrapper.style.setProperty('--sidebar-width', `${clampSidebarWidth(width)}px`);
    }
  };

  useEffect(() => {
    const cancelDrag = () => finishDrag(false);
    window.addEventListener('blur', cancelDrag);
    return () => {
      window.removeEventListener('blur', cancelDrag);
      finishDrag(false);
    };
  });

  const normalizedSearch = search.trim().toLowerCase();
  const filtered = normalizedSearch
    ? threads.filter((thread) => thread.title.toLowerCase().includes(normalizedSearch))
    : threads;
  const groups = groupThreads(filtered);

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem className="flex items-center gap-1">
              <SidebarMenuButton variant="outline" tooltip={t('app.newChat')} onClick={onNewThread}>
                <Plus data-icon="inline-start" />
                <span>{t('app.newChat')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
          <div className="relative group-data-[collapsible=icon]:hidden">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <SidebarInput
              ref={searchInputRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('app.searchThreads')}
              aria-label={t('app.searchThreads')}
              className="pl-8"
            />
          </div>
        </SidebarHeader>

        <SidebarContent>
          {groups.map((group) => {
            const groupCollapsed = !normalizedSearch && collapsedGroups.includes(group.id);
            return (
              <Collapsible
                key={group.id}
                open={!groupCollapsed}
                onOpenChange={() => onToggleGroup?.(group.id)}
                className="group/collapsible"
              >
                <SidebarGroup>
                  <SidebarGroupLabel asChild>
                    <CollapsibleTrigger disabled={!onToggleGroup}>
                      {t(`group.${group.id}`)}
                      <ChevronDown
                        data-icon="inline-end"
                        className="ml-auto transition-transform group-data-[state=closed]/collapsible:-rotate-90"
                      />
                    </CollapsibleTrigger>
                  </SidebarGroupLabel>
                  <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down">
                    <SidebarGroupContent>
                      <SidebarMenu>
                        {group.threads.map((thread) => (
                          <ThreadRow
                            key={thread.id}
                            thread={thread}
                            active={thread.id === activeThreadId}
                            unread={isUnread(thread, seen, activeThreadId)}
                            activity={activity?.get(thread.id)}
                            renaming={renamingId === thread.id}
                            onOpen={() => onOpenThread(thread.id)}
                            onTogglePin={() => onTogglePin(thread)}
                            onStartRename={() => setRenamingId(thread.id)}
                            onCommitRename={(title) => {
                              setRenamingId(null);
                              if (title.trim() && title !== thread.title)
                                onRename(thread, title.trim());
                            }}
                            onCancelRename={() => setRenamingId(null)}
                            onDelete={() => setDeleting(thread)}
                          />
                        ))}
                      </SidebarMenu>
                    </SidebarGroupContent>
                  </CollapsibleContent>
                </SidebarGroup>
              </Collapsible>
            );
          })}
          {groups.length === 0 && (
            <SidebarGroup className="group-data-[collapsible=icon]:hidden">
              <SidebarGroupContent className="p-2 text-center text-muted-foreground">
                {normalizedSearch ? t('app.noMatchingThreads') : t('app.noThreads')}
              </SidebarGroupContent>
            </SidebarGroup>
          )}
        </SidebarContent>

        {onOpenSettings && (
          <SidebarFooter>
            <SidebarSeparator />
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton tooltip={t('app.settings')} onClick={onOpenSettings}>
                  <Settings data-icon="inline-start" />
                  <span>{t('app.settings')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        )}

        <SidebarRail
          role="separator"
          aria-orientation="vertical"
          aria-label={collapsed ? t('app.expandSidebar') : t('app.resizeSidebar')}
          aria-valuemin={SIDEBAR_MIN}
          aria-valuemax={SIDEBAR_MAX}
          aria-valuenow={clampSidebarWidth(width || SIDEBAR_DEFAULT)}
          tabIndex={collapsed ? -1 : 0}
          onClick={
            collapsed
              ? () => (onToggleCollapsed ? onToggleCollapsed() : toggleSidebar())
              : (event) => event.preventDefault()
          }
          onPointerDown={(event) => {
            if (collapsed) return;
            event.preventDefault();
            const wrapper = event.currentTarget.closest<HTMLElement>(
              '[data-slot="sidebar-wrapper"]',
            );
            if (!wrapper) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const startWidth = clampSidebarWidth(width || SIDEBAR_DEFAULT);
            drag.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startWidth,
              lastWidth: startWidth,
              target: event.currentTarget,
              wrapper,
              bodyUserSelect: document.body.style.userSelect,
              bodyCursor: document.body.style.cursor,
            };
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
          }}
          onPointerMove={(event) => {
            const active = drag.current;
            if (!active || active.pointerId !== event.pointerId) return;
            active.lastWidth = clampSidebarWidth(active.startWidth + event.clientX - active.startX);
            active.wrapper.style.setProperty('--sidebar-width', `${active.lastWidth}px`);
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId === event.pointerId) finishDrag(true);
          }}
          onPointerCancel={(event) => {
            if (drag.current?.pointerId === event.pointerId) finishDrag(false);
          }}
          onLostPointerCapture={(event) => {
            if (drag.current?.pointerId === event.pointerId) finishDrag(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            const next = clampSidebarWidth(
              (width || SIDEBAR_DEFAULT) + (event.key === 'ArrowRight' ? 16 : -16),
            );
            onWidthChange(next);
            onWidthCommit(next);
          }}
        />
      </Sidebar>

      {deleting && (
        <Suspense fallback={null}>
          <ThreadDeleteDialog
            thread={deleting}
            onClose={() => setDeleting(null)}
            onDelete={onDelete}
          />
        </Suspense>
      )}
    </>
  );
}

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
  const inputRef = useRef<HTMLInputElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!renaming) return;
    setDraft(thread.title);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [renaming, thread.title]);

  if (renaming) {
    return (
      <SidebarMenuItem>
        <SidebarInput
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter') onCommitRename(draft);
            else if (event.key === 'Escape') onCancelRename();
          }}
          onBlur={() => onCommitRename(draft)}
          aria-label={t('app.rename')}
        />
      </SidebarMenuItem>
    );
  }

  const status = activity?.pendingApprovals ? (
    <TriangleAlert
      data-icon="inline-start"
      className="text-warning"
      aria-label={t('app.needsApproval')}
    />
  ) : activity?.pendingInteractions ? (
    <CircleHelp data-icon="inline-start" className="text-info" aria-label={t('app.needsInput')} />
  ) : activity?.running ? (
    <Loader2
      data-icon="inline-start"
      className="animate-spin text-info"
      aria-label={t('app.running')}
    />
  ) : unread ? (
    <span className="size-2 rounded-full bg-primary" role="img" aria-label={t('app.unread')} />
  ) : null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={thread.title || t('app.untitled')}
        onClick={onOpen}
      >
        {status}
        {thread.pinned && <Pin data-icon="inline-start" />}
        <span className={cn(unread && 'font-medium')}>{thread.title || t('app.untitled')}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge className="group-hover/menu-item:hidden group-focus-within/menu-item:hidden">
        {timeAgo(thread.updatedAt)}
      </SidebarMenuBadge>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            ref={menuTriggerRef}
            showOnHover
            aria-label={t('app.threadMenu', {
              title: thread.title || t('app.untitled'),
            })}
          >
            <Ellipsis data-icon="inline-start" />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="right"
          align="start"
          onCloseAutoFocus={(event) => {
            if (!handoffMenuCloseToApproval(event)) {
              event.preventDefault();
              menuTriggerRef.current?.focus({ preventScroll: true });
            }
          }}
        >
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={onTogglePin}>
              {thread.pinned ? (
                <PinOff data-icon="inline-start" />
              ) : (
                <Pin data-icon="inline-start" />
              )}
              {thread.pinned ? t('app.unpin') : t('app.pin')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onStartRename}>
              <Pencil data-icon="inline-start" />
              {t('app.rename')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 data-icon="inline-start" />
              {t('app.delete')}
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}
