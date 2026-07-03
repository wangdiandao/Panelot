/**
 * Standalone visual preview of Panelot's presentational UI. No chrome APIs,
 * no engine — just the styled pieces with mock data, so the ChatGPT/OpenWebUI
 * look can be checked in a plain browser. Not shipped in the extension.
 */

import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Markdown } from '../src/ui/components/Markdown';
import { ToolCallGroup } from '../src/ui/components/ToolCallCard';
import '../src/ui/styles/global.css';

const ASSISTANT_MD = `我已经打开三个商品页并读取了评价，下面是对比：

| 型号 | 均分 | 降噪 | 续航 |
|---|---|---|---|
| A | 4.6 | 强 | 30h |
| B | 4.4 | 中 | 24h |
| C | 4.7 | 强 | 40h |

**结论**：若看重续航与降噪，\`型号 C\` 最优。

\`\`\`ts
const best = items.sort((a, b) => b.score - a.score)[0];
\`\`\`
`;

function Bubble() {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-user-bubble px-4 py-2.5 text-[14.5px] leading-[1.65]">
        <div className="mb-1.5 flex flex-wrap gap-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-black/20 px-2 py-0.5 text-[11px] text-text-dim">📎 淘宝-XX耳机</span>
        </div>
        <div className="whitespace-pre-wrap">帮我调研这三款耳机的评价并做对比表</div>
      </div>
    </div>
  );
}

function Assistant() {
  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-[13px] text-accent">✦</div>
      <div className="min-w-0 flex-1 pt-0.5">
        <Markdown content={ASSISTANT_MD} />
      </div>
    </div>
  );
}

function Composer() {
  const [text, setText] = useState('');
  return (
    <div className="px-4 pb-4 pt-1">
      <div className="flex flex-col rounded-[24px] border border-border bg-surface-2 px-2 py-1.5 shadow-soft focus-within:border-accent/60">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="给 Panelot 发消息…"
            rows={1}
            className="max-h-48 min-h-[36px] flex-1 resize-none bg-transparent px-2.5 py-1.5 text-[14.5px] leading-[1.5] outline-none placeholder:text-text-faint"
          />
          <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-black" aria-label="发送">↑</button>
        </div>
      </div>
      <div className="mt-1.5 px-2 text-center text-[10.5px] text-text-faint">Enter 发送 · Shift+Enter 换行</div>
    </div>
  );
}

function Preview() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  React.useEffect(() => document.documentElement.setAttribute('data-theme', theme), [theme]);

  return (
    <div className="flex h-screen bg-bg text-text">
      {/* Sidebar mock */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border-soft bg-surface">
        <div className="space-y-2 p-3">
          <button className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] font-medium hover:bg-surface-2">
            <span className="text-[15px] leading-none">＋</span> 新会话
          </button>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-text-faint">⌕</span>
            <input placeholder="搜索会话" className="w-full rounded-lg bg-surface-2 py-1.5 pl-7 pr-2 text-[12.5px] outline-none placeholder:text-text-faint" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <div className="mb-3">
            <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-text-faint">今天</div>
            <div className="flex items-center rounded-lg bg-surface-2 pr-1">
              <button className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px]">耳机调研对比</button>
            </div>
            <div className="flex items-center rounded-lg pr-1 hover:bg-surface-2/60">
              <button className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px]">翻译 PDF 文档</button>
            </div>
          </div>
        </div>
        <div className="border-t border-border-soft p-2">
          <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-text-dim hover:bg-surface-2 hover:text-text">
            <span className="opacity-70">⚙</span> 切换主题（预览）
          </button>
        </div>
      </aside>

      {/* Conversation */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border-soft px-5 py-3">
          <div className="truncate text-[14px] font-medium">耳机调研对比</div>
        </div>
        <div className="mx-auto flex min-h-0 w-full max-w-[768px] flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-4 py-6">
            <div className="space-y-6">
              <Bubble />
              <Assistant />
              <div className="pl-10">
                <ToolCallGroup
                  cards={[
                    { itemId: '1', toolName: 'navigate', label: '导航', status: 'ok', paramsSummary: 'taobao.com/item…', durationMs: 1200 },
                    { itemId: '2', toolName: 'read_page', label: '读取页面', status: 'ok', paramsSummary: '增量快照 s4', durationMs: 300 },
                    { itemId: '3', toolName: 'extract', label: '提取', status: 'ok', durationMs: 800 },
                    { itemId: '4', toolName: 'click', label: '点击元素', status: 'running', progressText: '等待加载…' },
                  ]}
                />
              </div>
            </div>
          </div>
          <Composer />
        </div>
      </main>

      {/* Task panel */}
      <aside className="w-60 shrink-0 border-l border-border-soft bg-surface p-4">
        <div className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-text-faint">任务面板</div>
        <div className="mb-4 space-y-1.5 text-[12.5px]">
          <div className="flex gap-2 text-text-faint line-through"><span className="text-ok">☑</span><span>打开商品页 A</span></div>
          <div className="flex gap-2 text-text-faint line-through"><span className="text-ok">☑</span><span>读取评价</span></div>
          <div className="flex gap-2"><span className="text-text-faint">☐</span><span>汇总对比</span></div>
        </div>
        <div className="space-y-3 text-[12px]">
          <div>
            <div className="mb-1 flex justify-between text-text-dim"><span>上下文</span><span>42%</span></div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{ width: '42%' }} /></div>
          </div>
          <div className="font-mono text-text-dim">$0.1840 · 31.0k tok</div>
        </div>
      </aside>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Preview />
  </React.StrictMode>,
);
