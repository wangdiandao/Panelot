/**
 * Side panel (docs/09 §3.2): companion form — thread switcher, page-context
 * chip, shared ThreadView, expand-to-fullpage, in-app settings modal.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ContextBlock } from '../../src/messaging/protocol';
import { EngineSession } from '../../src/ui/engineClient';
import { ThreadView, useEngineState } from '../../src/ui/components/ThreadView';
import { SettingsModal } from '../../src/ui/settings/SettingsModal';
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
  const [showThreadList, setShowThreadList] = useState(false);
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

  const iconBtn = 'flex h-8 w-8 items-center justify-center rounded-lg text-text-dim transition-colors hover:bg-surface-2 hover:text-text';

  return (
    <div className="flex h-screen flex-col bg-bg text-text">
      <header className="flex items-center gap-1 border-b border-border-soft bg-surface px-2 py-1.5">
        <button
          type="button"
          onClick={() => setShowThreadList((v) => !v)}
          className="flex-1 truncate rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors hover:bg-surface-2"
          aria-expanded={showThreadList}
        >
          {state.meta?.title || '新会话'} <span className="text-text-faint">▾</span>
        </button>
        <button type="button" title="展开全屏" onClick={() => {
          const threadId = session.store.getState().threadId;
          void chrome.tabs.create({ url: chrome.runtime.getURL(`/chat.html${threadId ? `?thread=${threadId}` : ''}`) });
        }} className={iconBtn}>⛶</button>
        <button type="button" title="新会话" onClick={() => { session.createThread(); setShowThreadList(false); }} className={iconBtn}>＋</button>
        <button type="button" title="设置" onClick={() => setSettingsOpen(true)} className={iconBtn}>⚙</button>
      </header>

      {showThreadList && (
        <div className="max-h-64 overflow-y-auto border-b border-border-soft bg-surface">
          {threads.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => { session.openThread(t.id); setShowThreadList(false); }}
              className={`block w-full truncate px-3 py-2 text-left text-[12.5px] transition-colors hover:bg-surface-2 ${t.id === state.threadId ? 'text-accent' : ''}`}
            >
              {t.title || '未命名会话'}
            </button>
          ))}
          {threads.length === 0 && <div className="px-3 py-3 text-[12px] text-text-faint">暂无历史会话</div>}
        </div>
      )}

      {currentPageTitle && !staged.some((c) => c.kind === 'page') && (
        <div className="flex items-center gap-2 border-b border-border-soft bg-surface px-3 py-1.5 text-[12px]">
          <span className="truncate text-text-dim">📎 {currentPageTitle}</span>
          <button
            type="button"
            onClick={() => void attachPage()}
            className="ml-auto shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] transition-colors hover:border-accent hover:text-accent"
          >
            ＋ 附着到对话
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        <ThreadView
          session={session}
          providerConfigured={providerConfigured}
          onOpenSettings={() => setSettingsOpen(true)}
          stagedContext={staged}
          onRemoveStagedContext={(i) => setStaged((s) => s.filter((_, idx) => idx !== i))}
        />
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
