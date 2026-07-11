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
import { LazyToaster } from '../../src/ui/components/LazyToaster';
import { Button } from '../../src/ui/components/ui/button';
import { Badge } from '../../src/ui/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
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
import { t } from '../../src/ui/i18n';
import { attachCurrentPage, getActiveTab } from '../../src/ui/pageContext';
import { SettingsStore } from '../../src/settings/store';
import { PanelotDB } from '../../src/db/schema';
import type { ThreadMeta } from '../../src/db/types';

const db = new PanelotDB();
const SettingsModal = lazy(() =>
  import('../../src/ui/settings/SettingsModal').then((module) => ({
    default: module.SettingsModal,
  })),
);

export function App() {
  useTheme();
  const session = useMemo(() => new EngineSession(), []);
  const state = useEngineState(session);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [staged, setStaged] = useState<ContextBlock[]>([]);
  const [currentPage, setCurrentPage] = useState<{ title: string; url?: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => () => session.dispose(), [session]);

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
        void chrome.tabs.create({
          url: chrome.runtime.getURL(`/chat.html${threadId ? `?thread=${threadId}` : ''}`),
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const checkProvider = () =>
    void SettingsStore.connections.get().then((conns) => {
      setProviderConfigured(
        conns.some((c) => c.enabled && (c.apiKeys.length > 0 || c.baseUrl.includes('localhost'))),
      );
    });

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
    checkProvider();
    void refreshThreads().then(() => {
      const live = session.store.getState().threadId;
      void db.threads
        .orderBy('updatedAt')
        .reverse()
        .filter((t) => !t.deleting && !t.archived && t.leafId !== null)
        .first()
        .then((recent) => {
          if (recent && !live) session.openThread(recent.id);
          else if (!recent && !live) session.startDraft();
        });
    });
  }, [session]);

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
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={label}
          onClick={onClick}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-screen flex-col bg-background text-foreground">
        <header className="flex items-center gap-1 border-b border-border-soft bg-card px-2 py-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="min-w-0 flex-1 justify-start gap-1 px-2.5 text-[13px] font-medium"
              >
                <span className="truncate">{state.meta?.title || '新会话'}</span>
                <ChevronDown className="size-3.5 shrink-0 text-faint-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
              <DropdownMenuLabel className="text-[11px] text-faint-foreground">
                最近会话
              </DropdownMenuLabel>
              {threads.map((t) => (
                <DropdownMenuItem
                  key={t.id}
                  className={t.id === state.threadId ? 'bg-accent font-medium' : ''}
                  onClick={() => session.openThread(t.id)}
                >
                  <span className="truncate">{t.title || '未命名会话'}</span>
                </DropdownMenuItem>
              ))}
              {threads.length === 0 && (
                <div className="px-2 py-2 text-[12px] text-faint-foreground">暂无历史会话</div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {iconButton('展开全屏', Expand, () => {
            const threadId = session.store.getState().threadId;
            void chrome.tabs.create({
              url: chrome.runtime.getURL(`/chat.html${threadId ? `?thread=${threadId}` : ''}`),
            });
          })}
          {iconButton('新会话', Plus, () => session.startDraft())}
        </header>

        {currentPage && !staged.some((c) => c.kind === 'page') && (
          <div className="flex items-center gap-2 border-b border-border-soft bg-card px-3 py-1.5 text-[12px]">
            <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground">
              <Paperclip className="size-3 shrink-0" /> {currentPage.title}
            </span>
            <Badge
              asChild
              variant="outline"
              className="ml-auto shrink-0 cursor-pointer hover:border-primary hover:text-primary"
            >
              <button type="button" onClick={() => void attachPage()}>
                {t('app.attachPage')}
              </button>
            </Badge>
          </div>
        )}

        <div className="min-h-0 flex-1">
          <ThreadView
            session={session}
            providerConfigured={providerConfigured}
            onProviderConfigured={checkProvider}
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
        </div>

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
        <LazyToaster position="bottom-center" />
      </div>
    </TooltipProvider>
  );
}
