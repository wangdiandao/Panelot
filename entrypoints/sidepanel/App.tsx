/**
 * Side panel (docs/09 §3.2): companion form — thread switcher, page-context
 * chip, shared ThreadView, expand-to-fullpage, in-app settings modal.
 * Built on shadcn/ui primitives; the thread switcher is a real DropdownMenu
 * (menu semantics, Esc, arrow keys, outside-click) instead of a bare div.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Expand, Paperclip, Plus } from 'lucide-react';
import type { ContextBlock } from '../../src/messaging/protocol';
import { EngineSession } from '../../src/ui/engineClient';
import { ThreadView, useEngineState } from '../../src/ui/components/ThreadView';
import { CommandPalette } from '../../src/ui/components/CommandPalette';
import { ShortcutHelp } from '../../src/ui/components/ShortcutHelp';
import { AppToaster } from '../../src/ui/components/AppToaster';
import { Button } from '../../src/ui/components/ui/button';
import { Alert, AlertAction, AlertDescription } from '../../src/ui/components/ui/alert';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../src/ui/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../src/ui/components/ui/tooltip';
import { useTheme } from '../../src/ui/useTheme';
import { t, useLanguage } from '../../src/ui/i18n';
import { attachCurrentPage, getActiveTab } from '../../src/ui/pageContext';
import type { Connection } from '../../src/providers/types';
import { useStorageValue } from '../../src/ui/useStorageValue';
import { PanelotDB } from '../../src/db/schema';
import type { ThreadMeta } from '../../src/db/types';
import { cn } from '../../src/ui/lib/utils';
import { handoffMenuCloseToApproval } from '../../src/ui/focusHandoff';
import { openFullPageChat } from '../../src/ui/openFullPageChat';
import { SettingsStore } from '../../src/settings/store';
import { selectInitialSidePanelThread } from '../../src/ui/sidePanelSession';

const db = new PanelotDB();
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
  const providerConfigured =
    storedConnections === null ||
    storedConnections.some(
      (connection) =>
        connection.enabled &&
        (connection.apiKeys.length > 0 || connection.baseUrl.includes('localhost')),
    );
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [staged, setStaged] = useState<ContextBlock[]>([]);
  const [currentPage, setCurrentPage] = useState<{ title: string; url?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    session.start();
    return () => session.stop();
  }, [session]);

  // Keyboard shortcuts (docs/09 §6): Ctrl/Cmd+K palette, Ctrl/Cmd+N new chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        session.startDraft();
      } else if (mod && e.key.toLowerCase() === 'e') {
        // Ctrl/Cmd+E: expand to the full-page form (docs/09 §6).
        e.preventDefault();
        const threadId = session.store.getState().threadId;
        void openFullPageChat(threadId ?? undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const refreshThreads = () =>
    db.threads
      .orderBy('updatedAt')
      .reverse()
      .limit(20)
      .toArray()
      .then((list) => {
        // Only chats with content are listed (drafts never persist a row).
        setThreads(list.filter((t) => !t.deleting && !t.archived && t.leafId !== null));
      });

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      refreshThreads(),
      SettingsStore.lastSidePanelThread.get(),
      db.threads
        .orderBy('updatedAt')
        .reverse()
        .filter((t) => !t.deleting && !t.archived && t.leafId !== null)
        .first(),
    ]).then(async ([, lastThreadId, recent]) => {
      const lastSelected = lastThreadId ? await db.threads.get(lastThreadId) : undefined;
      if (cancelled || session.store.getState().threadId) return;
      const initialThread = selectInitialSidePanelThread(lastSelected, recent);
      if (initialThread) session.openThread(initialThread.id);
      else session.startDraft();
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (state.threadId) void SettingsStore.lastSidePanelThread.set(state.threadId);
  }, [state.threadId]);

  // Keep the dropdown list in sync with title generation / new turns.
  useEffect(
    () => void refreshThreads(),
    [state.meta?.title, state.meta?.updatedAt, state.threadId],
  );

  useEffect(() => {
    const refresh = () =>
      void getActiveTab().then((tab) =>
        setCurrentPage(tab?.title ? { title: tab.title, url: tab.url } : null),
      );
    refresh();
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(refresh);
    return () => {
      chrome.tabs.onActivated.removeListener(refresh);
      chrome.tabs.onUpdated.removeListener(refresh);
    };
  }, []);

  const attachPage = async () => {
    const block = await attachCurrentPage();
    if (block) setStaged((s) => [...s.filter((c) => c.kind !== 'page'), block]);
  };

  const iconButton = (label: string, Icon: typeof Plus, onClick: () => void) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>
          <Icon data-icon="inline-start" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-dvh min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-12 shrink-0 items-center gap-1 border-b border-border-soft bg-card px-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start">
                <span className="truncate">{state.meta?.title || t('app.newChat')}</span>
                <ChevronDown data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 w-[min(16rem,calc(100vw-1rem))] overflow-y-auto"
              onCloseAutoFocus={handoffMenuCloseToApproval}
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-[11px] text-faint-foreground">
                  {t('app.recentThreads')}
                </DropdownMenuLabel>
                {threads.map((thread) => (
                  <DropdownMenuItem
                    key={thread.id}
                    className={cn(thread.id === state.threadId && 'bg-accent font-medium')}
                    onClick={() => session.openThread(thread.id)}
                  >
                    <span className="truncate">{thread.title || t('app.untitled')}</span>
                  </DropdownMenuItem>
                ))}
                {threads.length === 0 && (
                  <DropdownMenuItem disabled>{t('app.noThreads')}</DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {iconButton(t('app.expand'), Expand, () => {
            const threadId = session.store.getState().threadId;
            void openFullPageChat(threadId ?? undefined);
          })}
          {iconButton(t('app.newChat'), Plus, () => session.startDraft())}
        </header>

        {currentPage && !staged.some((c) => c.kind === 'page') && (
          <Alert role="status" className="mx-3 mt-3 w-auto min-w-0 shrink-0">
            <Paperclip />
            <AlertDescription className="min-w-0 truncate">{currentPage.title}</AlertDescription>
            <AlertAction>
              <Button variant="outline" size="xs" onClick={() => void attachPage()}>
                {t('app.attachPage')}
              </Button>
            </AlertAction>
          </Alert>
        )}

        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <ThreadView
            session={session}
            providerConfigured={providerConfigured}
            onOpenSettings={() => setSettingsOpen(true)}
            stagedContext={staged}
            onRemoveStagedContext={(i) => setStaged((s) => s.filter((_, idx) => idx !== i))}
            onAttachContext={(block) => setStaged((s) => [...s, block])}
            surface="panel"
            pageUrl={currentPage?.url}
            onBackspaceEmpty={() =>
              // Cherry Studio ClipboardPreview semantics: Backspace on an empty
              // composer removes the attached page chip.
              setStaged((s) => {
                const idx = s.findIndex((c) => c.kind === 'page');
                return idx >= 0 ? s.filter((_, i) => i !== idx) : s;
              })
            }
          />
        </main>

        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          </Suspense>
        )}
        <CommandPalette
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          onOpenThread={(id) => session.openThread(id)}
          onNewThread={() => session.startDraft()}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <ShortcutHelp />
        {/* Bottom-center: top-right would overlap the thread-switcher header. */}
        <AppToaster position="bottom-center" />
      </div>
    </TooltipProvider>
  );
}
