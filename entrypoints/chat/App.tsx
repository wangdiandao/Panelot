/**
 * Full-page chat (docs/09 §3.1): three columns — thread list / message stream
 * / task panel. ChatGPT/OpenWebUI-flavored: per-row ⋯ menu (like ChatGPT's
 * conversation rows), grouped history, centered composer, in-app settings
 * modal (no navigation away). Built on shadcn/ui primitives.
 */

import { useEffect, useMemo, useState } from 'react';
import { Ellipsis, Pencil, Pin, PinOff, Plus, Search, Settings, Trash2 } from 'lucide-react';
import type { ContextBlock } from '../../src/messaging/protocol';
import { EngineSession } from '../../src/ui/engineClient';
import { ThreadView, useEngineState } from '../../src/ui/components/ThreadView';
import { SettingsModal } from '../../src/ui/settings/SettingsModal';
import { CommandPalette } from '../../src/ui/components/CommandPalette';
import { Toaster } from '../../src/ui/components/ui/sonner';
import { Button } from '../../src/ui/components/ui/button';
import { Input } from '../../src/ui/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../src/ui/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../src/ui/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../src/ui/components/ui/dropdown-menu';
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
  const [renaming, setRenaming] = useState<ThreadMeta | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleting, setDeleting] = useState<ThreadMeta | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => () => session.dispose(), [session]);

  const refreshThreads = () =>
    db.threads.orderBy('updatedAt').reverse().limit(200).toArray().then((list) => {
      setThreads(list.filter((t) => !t.deleting && !t.archived));
    });

  const checkProvider = () =>
    void SettingsStore.connections.get().then((conns) => {
      setProviderConfigured(conns.some((c) => c.enabled && (c.apiKeys.length > 0 || c.baseUrl.includes('localhost'))));
    });

  useEffect(() => {
    checkProvider();
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

  // Keyboard shortcuts (docs/09 §6): Ctrl/Cmd+N new, Ctrl/Cmd+, settings,
  // Ctrl/Cmd+K command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        session.createThread();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const filtered = search.trim()
    ? threads.filter((t) => t.title.toLowerCase().includes(search.trim().toLowerCase()))
    : threads;
  const groups = groupByTime(filtered);

  const confirmDelete = async () => {
    if (!deleting) return;
    await tree.deleteThread(deleting.id);
    await refreshThreads();
    if (state.threadId === deleting.id) session.createThread();
    setDeleting(null);
  };
  const confirmRename = async () => {
    if (!renaming) return;
    await tree.updateThread(renaming.id, { title: renameTitle });
    await refreshThreads();
    setRenaming(null);
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
          <Button
            variant="outline"
            className="w-full justify-start gap-2 text-[13px] font-medium"
            onClick={() => session.createThread()}
          >
            <Plus className="size-4" /> 新会话
          </Button>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索会话"
              className="h-8 border-transparent bg-muted pl-8 text-[12.5px] shadow-none"
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
                    {t.pinned && <Pin className="mr-1 inline size-3 text-faint-foreground" />}
                    {t.title || '新会话'}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 shrink-0 text-faint-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                        aria-label={`会话「${t.title || '新会话'}」操作`}
                      >
                        <Ellipsis className="size-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-36">
                      <DropdownMenuItem onClick={() => void togglePin(t)}>
                        {t.pinned ? <PinOff /> : <Pin />}
                        {t.pinned ? '取消置顶' : '置顶'}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => { setRenaming(t); setRenameTitle(t.title); }}>
                        <Pencil /> 重命名
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onClick={() => setDeleting(t)}>
                        <Trash2 /> 删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="px-3 py-6 text-center text-[12px] text-faint-foreground">暂无会话</div>}
        </div>
        <div className="border-t border-border-soft p-2">
          <Button
            variant="ghost"
            className="w-full justify-start gap-2 text-[13px] text-muted-foreground"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings className="size-4 opacity-70" /> 设置
          </Button>
        </div>
      </aside>

      {/* Center: conversation (768px cap) */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border-soft px-5 py-3">
          <div className="truncate text-[14px] font-medium">{state.meta?.title || '新会话'}</div>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto text-[12px] text-muted-foreground"
            onClick={() => setTaskPanelOpen((v) => !v)}
            aria-expanded={taskPanelOpen}
          >
            {taskPanelOpen ? '隐藏任务面板' : '任务面板'}
          </Button>
        </div>
        <div className="mx-auto flex min-h-0 w-full max-w-[768px] flex-1 flex-col">
          <ThreadView
            session={session}
            providerConfigured={providerConfigured}
            onProviderConfigured={checkProvider}
            onOpenSettings={() => setSettingsOpen(true)}
            stagedContext={staged}
            onRemoveStagedContext={(i) => setStaged((s) => s.filter((_, idx) => idx !== i))}
            onAttachContext={(block) => setStaged((s) => [...s, block])}
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

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenThread={(id) => session.openThread(id)}
        onNewThread={() => session.createThread()}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <Dialog open={renaming !== null} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <Input
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void confirmRename()}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenaming(null)}>取消</Button>
            <Button size="sm" onClick={() => void confirmRename()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除会话「{deleting?.title || '新会话'}」？</AlertDialogTitle>
            <AlertDialogDescription>删除后不可恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void confirmDelete()}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Toaster />
    </div>
  );
}
