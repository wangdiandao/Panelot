/**
 * Side panel (docs/09 §3.2): companion form — thread switcher, page-context
 * chip, shared ThreadView, expand-to-fullpage, in-app settings modal.
 * Built on shadcn/ui primitives; the thread switcher is a real DropdownMenu
 * (menu semantics, Esc, arrow keys, outside-click) instead of a bare div.
 */

import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Expand, Paperclip, Plus, Settings } from 'lucide-react';
import type { ContextBlock } from '../../src/messaging/protocol';
import { EngineSession } from '../../src/ui/engineClient';
import { ThreadView, useEngineState } from '../../src/ui/components/ThreadView';
import { SettingsModal } from '../../src/ui/settings/SettingsModal';
import { Toaster } from '../../src/ui/components/ui/sonner';
import { Button } from '../../src/ui/components/ui/button';
import { Badge } from '../../src/ui/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../../src/ui/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../src/ui/components/ui/tooltip';
import { useTheme } from '../../src/ui/useTheme';
import { attachCurrentPage, getActiveTab } from '../../src/ui/pageContext';
import { SettingsStore } from '../../src/settings/store';
import { PanelotDB } from '../../src/db/schema';
import type { ThreadMeta } from '../../src/db/types';

const db = new PanelotDB();

export function App() {
  useTheme();
  const session = useMemo(() => new EngineSession(), []);
  const state = useEngineState(session);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [staged, setStaged] = useState<ContextBlock[]>([]);
  const [currentPageTitle, setCurrentPageTitle] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => () => session.dispose(), [session]);

  useEffect(() => {
    void SettingsStore.connections.get().then((conns) => {
      setProviderConfigured(conns.some((c) => c.enabled && (c.apiKeys.length > 0 || c.baseUrl.includes('localhost'))));
    });
    void db.threads.orderBy('updatedAt').reverse().limit(20).toArray().then((list) => {
      const live = list.filter((t) => !t.deleting && !t.archived);
      setThreads(live);
      if (live[0] && !session.store.getState().threadId) session.openThread(live[0].id);
      else if (!live[0]) session.createThread();
    });
  }, [session]);

  useEffect(() => {
    const refresh = () => void getActiveTab().then((tab) => setCurrentPageTitle(tab?.title ?? null));
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
        <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" aria-label={label} onClick={onClick}>
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
            <DropdownMenuLabel className="text-[11px] text-faint-foreground">最近会话</DropdownMenuLabel>
            {threads.map((t) => (
              <DropdownMenuItem
                key={t.id}
                className={t.id === state.threadId ? 'text-primary' : ''}
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
          void chrome.tabs.create({ url: chrome.runtime.getURL(`/chat.html${threadId ? `?thread=${threadId}` : ''}`) });
        })}
        {iconButton('新会话', Plus, () => session.createThread())}
        {iconButton('设置', Settings, () => setSettingsOpen(true))}
      </header>

      {currentPageTitle && !staged.some((c) => c.kind === 'page') && (
        <div className="flex items-center gap-2 border-b border-border-soft bg-card px-3 py-1.5 text-[12px]">
          <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground">
            <Paperclip className="size-3 shrink-0" /> {currentPageTitle}
          </span>
          <Badge
            asChild
            variant="outline"
            className="ml-auto shrink-0 cursor-pointer hover:border-primary hover:text-primary"
          >
            <button type="button" onClick={() => void attachPage()}>＋ 附着到对话</button>
          </Badge>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <ThreadView
          session={session}
          providerConfigured={providerConfigured}
          onOpenSettings={() => setSettingsOpen(true)}
          stagedContext={staged}
          onRemoveStagedContext={(i) => setStaged((s) => s.filter((_, idx) => idx !== i))}
          onAttachContext={(block) => setStaged((s) => [...s, block])}
        />
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <Toaster />
    </div>
    </TooltipProvider>
  );
}
