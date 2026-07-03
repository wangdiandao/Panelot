/**
 * Full-page chat (docs/09 §3.1): three columns — thread list / message
 * stream (720px centered) / task panel. Shares ThreadView with the panel.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ContextBlock } from '../../src/messaging/protocol';
import { EngineSession } from '../../src/ui/engineClient';
import { ThreadView, useEngineState } from '../../src/ui/components/ThreadView';
import { SettingsStore } from '../../src/settings/store';
import { PanelotDB } from '../../src/db/schema';
import type { ThreadMeta } from '../../src/db/types';

const db = new PanelotDB();

function groupByTime(threads: ThreadMeta[]): { label: string; threads: ThreadMeta[] }[] {
  const now = Date.now();
  const today: ThreadMeta[] = [];
  const yesterday: ThreadMeta[] = [];
  const week: ThreadMeta[] = [];
  const older: ThreadMeta[] = [];
  const dayMs = 86_400_000;
  for (const t of threads) {
    const age = now - t.updatedAt;
    if (age < dayMs) today.push(t);
    else if (age < 2 * dayMs) yesterday.push(t);
    else if (age < 7 * dayMs) week.push(t);
    else older.push(t);
  }
  return [
    { label: '今天', threads: today },
    { label: '昨天', threads: yesterday },
    { label: '本周', threads: week },
    { label: '更早', threads: older },
  ].filter((g) => g.threads.length > 0);
}

export function App() {
  const session = useMemo(() => new EngineSession(), []);
  const state = useEngineState(session);
  const [providerConfigured, setProviderConfigured] = useState(true);
  const [threads, setThreads] = useState<ThreadMeta[]>([]);
  const [search, setSearch] = useState('');
  const [staged, setStaged] = useState<ContextBlock[]>([]);
  const [taskPanelOpen, setTaskPanelOpen] = useState(true);

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
      // Deep link: /chat.html?thread=<id>
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

  // Refresh the sidebar list when the active thread updates (title etc.).
  useEffect(() => void refreshThreads(), [state.meta?.title, state.meta?.updatedAt]);

  const filtered = search.trim()
    ? threads.filter((t) => t.title.toLowerCase().includes(search.trim().toLowerCase()))
    : threads;
  const groups = groupByTime(filtered);

  return (
    <div className="flex h-screen bg-bg text-text">
      {/* Left: thread list */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
        <div className="space-y-2 p-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="⌕ 搜索会话"
            className="w-full rounded-md border border-border bg-surface-2 px-2 py-1 text-[12.5px] outline-none placeholder:text-text-dim focus:border-accent/60"
          />
          <button
            type="button"
            onClick={() => session.createThread()}
            className="w-full rounded-md border border-border px-2 py-1 text-left text-[12.5px] text-text-dim hover:border-accent hover:text-accent"
          >
            ✚ 新会话
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {groups.map((g) => (
            <div key={g.label} className="mb-2">
              <div className="px-1 py-1 text-[11px] text-text-dim">{g.label}</div>
              {g.threads.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => session.openThread(t.id)}
                  className={`block w-full truncate rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-surface-2 ${
                    t.id === state.threadId ? 'bg-surface-2 text-accent' : ''
                  }`}
                >
                  {t.pinned && '📌 '}
                  {t.title || '未命名会话'}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="border-t border-border p-2">
          <button
            type="button"
            onClick={() => void chrome.runtime.openOptionsPage()}
            className="w-full rounded-md px-2 py-1 text-left text-[12.5px] text-text-dim hover:bg-surface-2"
          >
            ⚙ 设置
          </button>
        </div>
      </aside>

      {/* Center: conversation (720px cap) */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center border-b border-border bg-surface px-4 py-2">
          <div className="truncate text-[14px] font-medium">{state.meta?.title || '新会话'}</div>
          <button
            type="button"
            onClick={() => setTaskPanelOpen((v) => !v)}
            className="ml-auto rounded-md px-2 py-1 text-[12px] text-text-dim hover:bg-surface-2"
            aria-expanded={taskPanelOpen}
          >
            任务 ▾
          </button>
        </div>
        <div className="mx-auto flex min-h-0 w-full max-w-[720px] flex-1 flex-col">
          <ThreadView
            session={session}
            providerConfigured={providerConfigured}
            onOpenSettings={() => void chrome.runtime.openOptionsPage()}
            stagedContext={staged}
            onRemoveStagedContext={(i) => setStaged((s) => s.filter((_, idx) => idx !== i))}
          />
        </div>
      </main>

      {/* Right: task panel (full version lands with browser tools) */}
      {taskPanelOpen && (
        <aside className="w-56 shrink-0 border-l border-border bg-surface p-3">
          <div className="mb-2 text-[12px] font-medium text-text-dim">任务面板</div>
          {state.todos.length > 0 && (
            <div className="mb-3 space-y-1 text-[12px]">
              {state.todos.map((t, i) => (
                <div key={i} className={t.done ? 'text-text-dim line-through' : ''}>
                  {t.done ? '☑' : '◻'} {t.text}
                </div>
              ))}
            </div>
          )}
          {state.lastUsage ? (
            <div className="space-y-2 text-[12px]">
              <div>
                <div className="mb-1 flex justify-between text-text-dim">
                  <span>上下文</span>
                  <span>{state.lastUsage.contextPct}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full bg-accent" style={{ width: `${state.lastUsage.contextPct}%` }} />
                </div>
              </div>
              <div className="font-mono text-text-dim">
                {state.lastUsage.costUsd !== undefined && `$${state.lastUsage.costUsd.toFixed(2)} · `}
                {(state.lastUsage.totalTokens / 1000).toFixed(1)}k tok
              </div>
            </div>
          ) : (
            <div className="text-[12px] text-text-dim">本轮暂无用量数据</div>
          )}
          {state.queuedInputs > 0 && (
            <div className="mt-3 text-[12px] text-text-dim">队列 {state.queuedInputs} 条</div>
          )}
        </aside>
      )}
    </div>
  );
}
