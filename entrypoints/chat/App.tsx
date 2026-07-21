/**
 * Full-page chat (docs/09 §3.1): thread sidebar + message stream. Layout
 * follows OpenWebUI's resizable navigation pattern; conversation progress
 * stays inside each assistant message instead of a detached activity panel.
 */

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import type { ContextBlock } from '../../src/messaging/protocol';
import { EngineSession } from '../../src/ui/engineClient';
import { ThreadView, useEngineState } from '../../src/ui/components/ThreadView';
import { ThreadSidebar } from '../../src/ui/components/ThreadSidebar';
import type { SettingsSectionId } from '../../src/ui/settings/SettingsPanel';
import { CommandPalette } from '../../src/ui/components/CommandPalette';
import { ModelSelector } from '../../src/ui/components/ModelSelector';
import { ShortcutHelp } from '../../src/ui/components/ShortcutHelp';
import { AppToaster } from '../../src/ui/components/AppToaster';
import { Skeleton } from '../../src/ui/components/ui/skeleton';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '../../src/ui/components/ui/sidebar';
import { useTheme } from '../../src/ui/useTheme';
import { t, useLanguage } from '../../src/ui/i18n';
import { SettingsStore, type GlobalSettings } from '../../src/settings/store';
import type { Connection } from '../../src/providers/types';
import { useStorageValue } from '../../src/ui/useStorageValue';
import { SIDEBAR_DEFAULT, STREAM_MAX_W, clampSidebarWidth } from '../../src/ui/layoutTokens';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import type { ThreadMeta } from '../../src/db/types';
import { clearThreadRuntimeState } from '../../src/messaging/threadRuntimeState';
import { openSidePanelAndCloseFullPage } from '../../src/ui/openFullPageChat';

const db = new PanelotDB();
const tree = new ThreadTree(db);
const SettingsModal = lazy(() =>
  import('../../src/ui/settings/SettingsModal').then((module) => ({
    default: module.SettingsModal,
  })),
);

export function App() {
  useLanguage();
  useTheme();
  const session = useMemo(() => new EngineSession(), []);
  const state = useEngineState(session);
  const storedConnections = useStorageValue<Connection[] | null>('connections', null);
  const globalSettings = useStorageValue<GlobalSettings | null>('global_settings', null);
  const providerConfigured =
    storedConnections === null ||
    storedConnections.some(
      (connection) =>
        connection.enabled &&
        (connection.apiKeys.length > 0 || connection.baseUrl.includes('localhost')),
    );
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [staged, setStaged] = useState<ContextBlock[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>([]);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const browserWindowId = useRef<number | undefined>(undefined);
  // Cross-thread activity (running / awaiting approval) for sidebar rows —
  // separate store so it never re-renders the message stream.
  const activity = useSyncExternalStore(
    session.activityStore.subscribe,
    () => session.activityStore.getState().activity,
    () => session.activityStore.getState().activity,
  );

  useEffect(() => {
    session.start();
    void chrome.windows
      .getCurrent()
      .then((currentWindow) => {
        browserWindowId.current = currentWindow.id;
      })
      .catch(() => {});
    return () => session.stop();
  }, [session]);

  const refreshThreads = () =>
    db.threads
      .orderBy('updatedAt')
      .reverse()
      .limit(200)
      .toArray()
      .then((list) => {
        // Only chats with content are listed (drafts never persist a row).
        setThreads(list.filter((th) => !th.deleting && !th.archived && th.leafId !== null));
      });

  // Mark the open thread as seen (unread indicator source, docs/09 §3.1).
  const markSeen = (threadId: string) => {
    const seenAt = Date.now();
    setSeen((current) => ({ ...current, [threadId]: seenAt }));
    void SettingsStore.threadSeen.mark(threadId, seenAt);
  };

  useEffect(() => {
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
      const recent = await db.threads
        .orderBy('updatedAt')
        .reverse()
        .filter((th) => !th.deleting && th.leafId !== null)
        .first();
      if (recent) {
        session.openThread(recent.id);
        markSeen(recent.id);
      } else session.startDraft();
    });
  }, [session]);

  useEffect(() => {
    if (!globalSettings) return;
    if (globalSettings.sidebarWidth) {
      // Hydrate persisted layout when the external settings snapshot becomes available.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSidebarWidth(clampSidebarWidth(globalSettings.sidebarWidth));
    }
    setSidebarCollapsed(globalSettings.sidebarCollapsed ?? false);
    setCollapsedGroups(globalSettings.sidebarGroupsCollapsed ?? []);
  }, [globalSettings]);

  useEffect(() => {
    void refreshThreads();
  }, [state.meta?.title, state.meta?.updatedAt]);
  // Keep the open thread's seen timestamp fresh while it advances on-screen.
  useEffect(() => {
    // Reconcile local unread state with externally persisted thread progress.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (state.threadId && state.meta?.updatedAt) markSeen(state.threadId);
  }, [state.threadId, state.meta?.updatedAt]);

  const persistGlobal = (patch: { sidebarWidth?: number; sidebarCollapsed?: boolean }) =>
    void SettingsStore.global.patch(patch);

  // Keyboard shortcuts (docs/09 §6): Ctrl/Cmd+N new, Ctrl/Cmd+, settings,
  // Ctrl/Cmd+K command palette, Ctrl/Cmd+Shift+S sidebar collapse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!matchMedia('(min-width: 1024px)').matches) {
          document.querySelector<HTMLElement>('[data-sidebar="trigger"]')?.click();
          return;
        }
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
        const windowId = browserWindowId.current;
        if (windowId !== undefined) void openSidePanelAndCloseFullPage(windowId).catch(() => {});
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const openSettingsAt = (section?: SettingsSectionId) => {
    setSettingsSection(section);
    setSettingsOpen(true);
  };

  const renderThreadSidebar = () => (
    <ThreadSidebar
      threads={threads}
      activeThreadId={state.threadId}
      seen={seen}
      activity={activity}
      collapsed={sidebarCollapsed}
      width={sidebarWidth}
      onWidthChange={setSidebarWidth}
      onWidthCommit={(px) => persistGlobal({ sidebarWidth: px })}
      onOpenThread={(id) => {
        session.openThread(id);
        markSeen(id);
      }}
      onNewThread={() => {
        session.startDraft();
      }}
      onTogglePin={(thread) =>
        void tree.updateThread(thread.id, { pinned: !thread.pinned }).then(refreshThreads)
      }
      onRename={(thread, title) =>
        void tree.updateThread(thread.id, { title }).then(refreshThreads)
      }
      onDelete={(thread) =>
        void session
          .deleteThread(thread.id)
          .then(async () => {
            try {
              await clearThreadRuntimeState(thread.id);
            } finally {
              await refreshThreads();
              if (state.threadId === thread.id) session.startDraft();
            }
          })
          .catch(() => undefined)
      }
      collapsedGroups={collapsedGroups}
      onToggleGroup={(groupId) =>
        setCollapsedGroups((current) => {
          const next = current.includes(groupId)
            ? current.filter((candidate) => candidate !== groupId)
            : [...current, groupId];
          void SettingsStore.global.patch({ sidebarGroupsCollapsed: next });
          return next;
        })
      }
      onOpenSettings={() => {
        openSettingsAt(undefined);
      }}
      searchInputRef={searchRef}
    />
  );

  return (
    <SidebarProvider
      open={!sidebarCollapsed}
      onOpenChange={(open) => {
        setSidebarCollapsed(!open);
        persistGlobal({ sidebarCollapsed: !open });
      }}
      style={{ '--sidebar-width': `${sidebarWidth}px` } as CSSProperties}
      className="h-screen bg-background text-foreground"
    >
      {renderThreadSidebar()}

      <SidebarInset className="min-w-0">
        <header className="border-b border-border-soft">
          <div className="grid h-11 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-3">
            <div className="flex min-w-0 items-center gap-1">
              <SidebarTrigger
                className="shrink-0"
                aria-label={sidebarCollapsed ? t('app.expandSidebar') : t('app.collapseSidebar')}
              />
              <ModelSelector
                variant="header"
                value={state.pendingOverrides.model ?? null}
                onSelect={(choice) =>
                  session.setOverrides({
                    model: choice
                      ? { connectionId: choice.connectionId, modelId: choice.modelId }
                      : undefined,
                  })
                }
                onOpenSettings={() => openSettingsAt('providers')}
              />
            </div>
            <div className="max-w-[42vw] truncate px-2 text-center text-[13px] text-muted-foreground">
              {state.loading ? (
                <Skeleton className="mx-auto h-4 w-32" />
              ) : (
                state.meta?.title || t('app.newChat')
              )}
            </div>
            <div aria-hidden="true" />
          </div>
        </header>
        {/* No max-width wrapper here: the stream's scroll container spans the
            full center column so the scrollbar hugs the right edge (OpenWebUI
            layout); row content + composer are capped individually. */}
        <ThreadView
          session={session}
          providerConfigured={providerConfigured}
          onOpenSettings={() => openSettingsAt('providers')}
          stagedContext={staged}
          onRemoveStagedContext={(i) => setStaged((s) => s.filter((_, idx) => idx !== i))}
          onAttachContext={(block) => setStaged((s) => [...s, block])}
          modelSelectorInComposer={false}
          contentMaxWidth={STREAM_MAX_W}
        />
      </SidebarInset>

      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onClose={() => {
              setSettingsOpen(false);
              setSettingsSection(undefined);
            }}
            initialSection={settingsSection}
          />
        </Suspense>
      )}

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
      <AppToaster />
    </SidebarProvider>
  );
}
