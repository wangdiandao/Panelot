/**
 * Full-page chat (docs/09 §3.1): three columns — thread sidebar / message
 * stream / task panel. Layout follows OpenWebUI (resizable sidebar, top-left
 * model selector in the header, settings in the header) without cloning its
 * visuals; the sidebar itself is src/ui/components/ThreadSidebar.tsx.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PanelRight } from 'lucide-react';
import type { ContextBlock } from '../../src/messaging/protocol';
import { EngineSession } from '../../src/ui/engineClient';
import { ThreadView, useEngineState } from '../../src/ui/components/ThreadView';
import { ThreadSidebar } from '../../src/ui/components/ThreadSidebar';
import { SettingsModal } from '../../src/ui/settings/SettingsModal';
import type { SettingsSectionId } from '../../src/ui/settings/SettingsPanel';
import { CommandPalette } from '../../src/ui/components/CommandPalette';
import { ModelSelector } from '../../src/ui/components/ModelSelector';
import { ShortcutHelp } from '../../src/ui/components/ShortcutHelp';
import { TaskPanel } from '../../src/ui/components/TaskPanel';
import { Toaster } from '../../src/ui/components/ui/sonner';
import { Button } from '../../src/ui/components/ui/button';
import { Tooltip, TooltipProvider, TooltipContent, TooltipTrigger } from '../../src/ui/components/ui/tooltip';
import { useTheme } from '../../src/ui/useTheme';
import { t } from '../../src/ui/i18n';
import { SettingsStore } from '../../src/settings/store';
import { SIDEBAR_DEFAULT, STREAM_MAX_W, clampSidebarWidth } from '../../src/ui/layoutTokens';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import type { ThreadMeta } from '../../src/db/types';

const db = new PanelotDB();
const tree = new ThreadTree(db);

export function App() {
  useTheme();
  const session = useMemo(() => new EngineSession(), []);
  const state = useEngineState(session);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [staged, setStaged] = useState<ContextBlock[]>([]);
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  // Cross-thread activity (running / awaiting approval) for sidebar rows —
  // separate store so it never re-renders the message stream.
  const activity = useSyncExternalStore(
    session.activityStore.subscribe,
    () => session.activityStore.getState().activity,
    () => session.activityStore.getState().activity,
  );

  useEffect(() => () => session.dispose(), [session]);

  const refreshThreads = () =>
    db.threads.orderBy('updatedAt').reverse().limit(200).toArray().then((list) => {
      // Only chats with content are listed (drafts never persist a row).
      setThreads(list.filter((th) => !th.deleting && !th.archived && th.leafId !== null));
    });

  const checkProvider = () =>
    void SettingsStore.connections.get().then((conns) => {
      setProviderConfigured(conns.some((c) => c.enabled && (c.apiKeys.length > 0 || c.baseUrl.includes('localhost'))));
    });

  // Mark the open thread as seen (unread indicator source, docs/09 §3.1).
  const markSeen = (threadId: string) =>
    void SettingsStore.threadSeen.get().then((map) => {
      const next = { ...map, [threadId]: Date.now() };
      setSeen(next);
      void SettingsStore.threadSeen.set(next);
    });

  useEffect(() => {
    checkProvider();
    void SettingsStore.global.get().then((g) => {
      if (g.sidebarWidth) setSidebarWidth(clampSidebarWidth(g.sidebarWidth));
      setSidebarCollapsed(g.sidebarCollapsed ?? false);
      setCollapsedGroups(g.sidebarGroupsCollapsed ?? []);
    });
    void SettingsStore.threadSeen.get().then(setSeen);
    void refreshThreads().then(async () => {
      // Validate the ?thread= param — a stale link (deleted thread) must not
      // subscribe into thread_not_found; fall back to the most recent thread.
      const fromUrl = new URLSearchParams(location.search).get('thread');
      const target = fromUrl ? await db.threads.get(fromUrl) : undefined;
      if (target && !target.deleting) {
        session.openThread(target.id);
        markSeen(target.id);
        return;
      }
      if (fromUrl) history.replaceState(null, '', location.pathname);
      const recent = await db.threads.orderBy('updatedAt').reverse().filter((th) => !th.deleting && th.leafId !== null).first();
      if (recent) {
        session.openThread(recent.id);
        markSeen(recent.id);
      } else session.startDraft();
    });
  }, [session]);

  useEffect(() => void refreshThreads(), [state.meta?.title, state.meta?.updatedAt]);
  // Auto-expand the task panel when the agent produces its first todo
  // (the /plan flow writes todos; opening gives immediate feedback).
  const prevTodosLen = useRef(0);
  useEffect(() => {
    if (state.todos.length > 0 && prevTodosLen.current === 0) setTaskPanelOpen(true);
    prevTodosLen.current = state.todos.length;
  }, [state.todos.length]);
  // Keep the open thread's seen timestamp fresh while it advances on-screen.
  useEffect(() => {
    if (state.threadId && state.meta?.updatedAt) markSeen(state.threadId);
  }, [state.threadId, state.meta?.updatedAt]);

  const persistGlobal = (patch: { sidebarWidth?: number; sidebarCollapsed?: boolean }) =>
    void SettingsStore.global.get().then((g) => SettingsStore.global.set({ ...g, ...patch }));

  // Keyboard shortcuts (docs/09 §6): Ctrl/Cmd+N new, Ctrl/Cmd+, settings,
  // Ctrl/Cmd+K command palette, Ctrl/Cmd+Shift+S sidebar collapse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        setSidebarCollapsed((v) => {
          persistGlobal({ sidebarCollapsed: !v });
          return !v;
        });
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        session.startDraft();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'e') {
        // Ctrl/Cmd+E: back to the side panel form (docs/09 §6).
        e.preventDefault();
        window.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const openSettingsAt = (section?: SettingsSectionId) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  return (
    <TooltipProvider delayDuration={300}>
    <div className="flex h-screen bg-background text-foreground">
      <ThreadSidebar
        threads={threads}
        activeThreadId={state.threadId}
        seen={seen}
        activity={activity}
        collapsed={sidebarCollapsed}
        width={sidebarWidth}
        onWidthChange={setSidebarWidth}
        onWidthCommit={(px) => persistGlobal({ sidebarWidth: px })}
        onToggleCollapsed={() =>
          setSidebarCollapsed((v) => {
            persistGlobal({ sidebarCollapsed: !v });
            return !v;
          })
        }
        onOpenThread={(id) => {
          session.openThread(id);
          markSeen(id);
        }}
        onNewThread={() => session.startDraft()}
        onTogglePin={(th) => void tree.updateThread(th.id, { pinned: !th.pinned }).then(refreshThreads)}
        onRename={(th, title) => void tree.updateThread(th.id, { title }).then(refreshThreads)}
        onDelete={(th) =>
          void tree.deleteThread(th.id).then(async () => {
            await refreshThreads();
            if (state.threadId === th.id) session.startDraft();
          })
        }
        collapsedGroups={collapsedGroups}
        onToggleGroup={(groupId) =>
          setCollapsedGroups((prev) => {
            const next = prev.includes(groupId) ? prev.filter((g) => g !== groupId) : [...prev, groupId];
            void SettingsStore.global.get().then((g) => SettingsStore.global.set({ ...g, sidebarGroupsCollapsed: next }));
            return next;
          })
        }
        onOpenSettings={() => openSettingsAt(undefined)}
        searchInputRef={searchRef}
      />

      {/* Center: header + conversation (768px cap) */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2">
          <ModelSelector
            variant="header"
            value={state.pendingOverrides.model ?? null}
            onSelect={(choice) =>
              session.setOverrides({ model: choice ? { connectionId: choice.connectionId, modelId: choice.modelId } : undefined })
            }
            onOpenSettings={() => openSettingsAt('providers')}
          />
          <div className="min-w-0 flex-1 truncate text-center text-[13px] text-muted-foreground">
            {state.loading ? (
              <div className="mx-auto h-4 w-32 animate-pulse rounded bg-muted" />
            ) : (
              state.meta?.title || t('app.newChat')
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground"
                onClick={() => setTaskPanelOpen((v) => !v)}
                aria-expanded={taskPanelOpen}
                aria-label={taskPanelOpen ? t('app.hideTaskPanel') : t('app.taskPanel')}
              >
                <PanelRight className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{taskPanelOpen ? t('app.hideTaskPanel') : t('app.taskPanel')}</TooltipContent>
          </Tooltip>
        </div>
        {/* No max-width wrapper here: the stream's scroll container spans the
            full center column so the scrollbar hugs the right edge (OpenWebUI
            layout); row content + composer are capped individually. */}
        <ThreadView
          session={session}
          providerConfigured={providerConfigured}
          onProviderConfigured={checkProvider}
          onOpenSettings={() => openSettingsAt('providers')}
          stagedContext={staged}
          onRemoveStagedContext={(i) => setStaged((s) => s.filter((_, idx) => idx !== i))}
          onAttachContext={(block) => setStaged((s) => [...s, block])}
          modelSelectorInComposer={false}
          contentMaxWidth={STREAM_MAX_W}
          onPlanCommand={() => setTaskPanelOpen(true)}
        />
      </main>

      {/* Right: task panel */}
      {taskPanelOpen && <TaskPanel state={state} />}

      <SettingsModal
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsSection(undefined);
          checkProvider();
        }}
        initialSection={settingsSection}
      />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenThread={(id) => {
          session.openThread(id);
          markSeen(id);
        }}
        onNewThread={() => session.startDraft()}
        onOpenSettings={() => openSettingsAt(undefined)}
      />

      <ShortcutHelp />
      <Toaster />
    </div>
    </TooltipProvider>
  );
}
