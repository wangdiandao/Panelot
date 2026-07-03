/**
 * Full-page chat (docs/09 §3.1): three columns — thread list / message stream
 * / task panel. ChatGPT/OpenWebUI-flavored: hover row actions, grouped history,
 * centered composer, in-app settings modal (no navigation away).
 */

import { useEffect, useMemo, useState } from 'react';
import type { ContextBlock } from '../../src/messaging/protocol';
import { EngineSession } from '../../src/ui/engineClient';
import { ThreadView, useEngineState } from '../../src/ui/components/ThreadView';
import { SettingsModal } from '../../src/ui/settings/SettingsModal';
import { useTheme } from '../../src/ui/useTheme';
import { SettingsStore } from '../../src/settings/store';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import type { ThreadMeta } from '../../src/db/types';

const db = new PanelotDB();
const tree = new ThreadTree(db);

function groupByTime(threads: ThreadMeta[]): { label: string; threads: ThreadMeta[] }[] {
  const now = Date.now();
  const buckets: Record<string, ThreadMeta[]> = { 今天: [], 昨天: [], 本周: [], 更早: [] };
  const dayMs = 86_400_000;
  for (const t of threads) {
    const age = now - t.updatedAt;
    if (age < dayMs) buckets['今天']!.push(t);
    else if (age < 2 * dayMs) buckets['昨天']!.push(t);
    else if (age < 7 * dayMs) buckets['本周']!.push(t);
    else buckets['更早']!.push(t);
  }
  return Object.entries(buckets)
    .map(([label, threads]) => ({ label, threads }))
    .filter((g) => g.threads.length > 0);
}

export function App() {
  useTheme();
  const session = useMemo(() => new EngineSession(), []);
  const state = useEngineState(session);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [search, setSearch] = useState('');
  const [staged, setStaged] = useState<ContextBlock[]>([]);
  const [taskPanelOpen, setTaskPanelOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => () => session.dispose(), [session]);

  const refreshThreads = () =>
    db.threads.orderBy('updatedAt').reverse().limit(200).toArray().then((list) => {
      setThreads(list.filter((t) => !t.deleting && !t.archived));
    });

  useEffect(() => {
    void SettingsStore.connections.get().then((conns) => {
      setProviderConfigured(conns.some((c) => c.enabled && (c.apiKeys.length > 0 || c.baseUrl.includes('localhost'))));
    });
    void refreshThreads().then(() => {
      const fromUrl = new URLSearchParams(location.search).get('thread');
      if (fromUrl) session.openThread(fromUrl);
      else {
        void db.threads.orderBy('updatedAt').reverse().first().then((t) => {
          if (t && !t.deleting) session.openThread(t.id);
          else session.createThread();
        });
      }
    });
  }, [session]);

  useEffect(() => void refreshThreads(), [state.meta?.title, state.meta?.updatedAt]);

  // Keyboard shortcuts (docs/09 §6): Ctrl/Cmd+N new chat, Ctrl/Cmd+, settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        session.createThread();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const filtered = search.trim()
    ? threads.filter((t) => t.title.toLowerCase().includes(search.trim().toLowerCase()))
    : threads;
  const groups = groupByTime(filtered);

  const del = async (id: string) => {
    await tree.deleteThread(id);
    await refreshThreads();
    if (state.threadId === id) session.createThread();
  };
  const rename = async (id: string, current: string) => {
    const title = prompt('重命名会话', current);
    if (title != null) {
      await tree.updateThread(id, { title });
      await refreshThreads();
    }
  };
  const togglePin = async (t: ThreadMeta) => {
    await tree.updateThread(t.id, { pinned: !t.pinned });
    await refreshThreads();
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Left: thread list */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border-soft bg-card">
        <div className="space-y-2 p-3">
          <button
            type="button"
            onClick={() => session.createThread()}
            className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] font-medium transition-colors hover:bg-muted"
          >
            <span className="text-[15px] leading-none">＋</span> 新会话
          </button>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-faint-foreground">⌕</span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索会话"
              className="w-full rounded-lg border border-transparent bg-muted py-1.5 pl-7 pr-2 text-[12.5px] outline-none transition-colors placeholder:text-faint-foreground focus:border-primary/50"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {groups.map((g) => (
            <div key={g.label} className="mb-3">
              <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-faint-foreground">{g.label}</div>
              {g.threads.map((t) => (
                <div
                  key={t.id}
                  className={`group flex items-center rounded-lg pr-1 transition-colors ${
                    t.id === state.threadId ? 'bg-muted' : 'hover:bg-muted/60'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => session.openThread(t.id)}
                    className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px]"
                  >
                    {t.pinned && <span className="mr-1 text-faint-foreground">📌</span>}
                    {t.title || '新会话'}
                  </button>
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                    <button type="button" title="置顶" onClick={() => void togglePin(t)} className="rounded px-1 text-[11px] text-faint-foreground hover:text-foreground">📌</button>
                    <button type="button" title="重命名" onClick={() => void rename(t.id, t.title)} className="rounded px-1 text-[11px] text-faint-foreground hover:text-foreground">✎</button>
                    <button type="button" title="删除" onClick={() => void del(t.id)} className="rounded px-1 text-[11px] text-faint-foreground hover:text-destructive">🗑</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-faint-foreground">暂无会话</div>}
        </div>
        <div className="border-t border-border-soft p-2">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <span className="opacity-70">⚙</span> 设置
          </button>
        </div>
      </aside>

      {/* Center: conversation (768px cap) */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border-soft px-5 py-3">
          <div className="truncate text-[14px] font-medium">{state.meta?.title || '新会话'}</div>
          <button
            type="button"
            onClick={() => setTaskPanelOpen((v) => !v)}
            className="ml-auto rounded-lg px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted"
            aria-expanded={taskPanelOpen}
          >
            {taskPanelOpen ? '隐藏任务面板' : '任务面板'}
          </button>
        </div>
        <div className="mx-auto flex min-h-0 w-full max-w-[768px] flex-1 flex-col">
          <ThreadView
            session={session}
            providerConfigured={providerConfigured}
            onOpenSettings={() => setSettingsOpen(true)}
            stagedContext={staged}
            onRemoveStagedContext={(i) => setStaged((s) => s.filter((_, idx) => idx !== i))}
          />
        </div>
      </main>

      {/* Right: task panel */}
      {taskPanelOpen && (
        <aside className="w-60 shrink-0 border-l border-border-soft bg-card p-4">
          <div className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-faint-foreground">任务面板</div>
          {state.todos.length > 0 && (
            <div className="mb-4 space-y-1.5 text-[12.5px]">
              {state.todos.map((t, i) => (
                <div key={i} className={`flex gap-2 ${t.done ? 'text-faint-foreground line-through' : ''}`}>
                  <span className={t.done ? 'text-success' : 'text-faint-foreground'}>{t.done ? '☑' : '☐'}</span>
                  <span>{t.text}</span>
                </div>
              ))}
            </div>
          )}
          {state.lastUsage ? (
            <div className="space-y-3 text-[12px]">
              <div>
                <div className="mb-1 flex justify-between text-muted-foreground">
                  <span>上下文</span>
                  <span>{state.lastUsage.contextPct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${state.lastUsage.contextPct}%` }} />
                </div>
              </div>
              <div className="font-mono text-muted-foreground">
                {state.lastUsage.costUsd !== undefined && `$${state.lastUsage.costUsd.toFixed(4)} · `}
                {(state.lastUsage.totalTokens / 1000).toFixed(1)}k tok
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-faint-foreground">本轮暂无用量数据</div>
          )}
          {state.queuedInputs > 0 && <div className="mt-3 text-[12px] text-muted-foreground">队列 {state.queuedInputs} 条</div>}
        </aside>
      )}

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
