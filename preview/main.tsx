/**
 * Standalone visual preview of Panelot's presentational UI. No chrome APIs,
 * no engine — just the styled pieces with mock data, so the ChatGPT/OpenWebUI
 * look can be checked in a plain browser. Not shipped in the extension.
 *
 * Toggle "Plan mode" in the toolbar to preview the PlanConfirmCard UI.
 */

import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Markdown } from '../src/ui/components/Markdown';
import { ReasoningBlock } from '../src/ui/components/ReasoningBlock';
import { ToolCallGroup } from '../src/ui/components/ToolCallCard';
import { PlanConfirmCard } from '../src/ui/components/PlanConfirmCard';
import { PermissionSwitch } from '../src/ui/components/PermissionSwitch';
import { SettingsModal } from '../src/ui/settings/SettingsModal';
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

const PLAN_TODOS = [
  { text: '打开商品页 A', done: true },
  { text: '打开商品页 B', done: false },
  { text: '打开商品页 C', done: false },
  { text: '读取并对比三款评价', done: false },
  { text: '输出对比表格和结论', done: false },
];

function Bubble() {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-user-bubble px-4 py-2.5 text-[14.5px] leading-[1.65]">
        <div className="mb-1.5 flex flex-wrap gap-1">
          <span className="inline-flex items-center gap-1 rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] text-muted-foreground">📎 淘宝-XX耳机</span>
        </div>
        <div className="whitespace-pre-wrap">帮我调研这三款耳机的评价并做对比表</div>
      </div>
    </div>
  );
}

function Assistant() {
  return (
    <div className="min-w-0 flex-1 pt-0.5">
      <ReasoningBlock
        text={'用户要对比三款耳机。先读取当前页面拿到第一款的评价，再打开另外两款的页面分别提取，最后汇总成表格。\n注意：评价要区分音质/降噪/佩戴三个维度。'}
      />
      <Markdown content={ASSISTANT_MD} />
    </div>
  );
}

function AssistantThinking() {
  return (
    <div className="min-w-0 flex-1 pt-0.5">
      <ReasoningBlock text={'正在分析页面结构，第一款耳机的评价集中在…'} streaming />
    </div>
  );
}

function Composer({ planMode, onPlanModeChange }: { planMode: boolean; onPlanModeChange: (v: boolean) => void }) {
  const [text, setText] = useState('');
  return (
    <div className="px-4 pb-4 pt-1">
      <div className="relative flex flex-col rounded-[24px] border border-border bg-muted px-2 py-1.5 shadow-soft focus-within:border-primary/60">
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={planMode ? '描述你要完成的任务…' : '给 Panelot 发消息…'}
            rows={1}
            className="max-h-48 min-h-[36px] flex-1 resize-none bg-transparent px-2.5 py-1.5 text-[14.5px] leading-[1.5] outline-none placeholder:text-faint-foreground"
          />
          <button className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground" aria-label="发送">↑</button>
        </div>
        <div className="flex items-center gap-1 px-1.5 pt-0.5">
          <PermissionSwitch
            value={undefined}
            planMode={planMode}
            onSelect={(tier) => onPlanModeChange(tier === 'plan')}
          />
        </div>
      </div>
      <div className="mt-1.5 px-2 text-center text-[11px] text-faint-foreground">
        {planMode ? '计划模式：AI 先制定计划，确认后执行' : 'Enter 发送 · Shift+Enter 换行'}
      </div>
    </div>
  );
}

function Preview() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planMode, setPlanMode] = useState(false);
  const [planConfirming, setPlanConfirming] = useState(false);
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border-soft bg-card">
        <div className="space-y-2 p-3">
          <button className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] font-medium hover:bg-muted">
            <span className="text-[15px] leading-none">＋</span> 新会话
          </button>
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[12px] text-faint-foreground">⌕</span>
            <input placeholder="搜索会话" className="w-full rounded-lg bg-muted py-1.5 pl-7 pr-2 text-[13px] outline-none placeholder:text-faint-foreground" />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <div className="mb-3">
            <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-faint-foreground">今天</div>
            <div className="flex items-center rounded-lg bg-muted pr-1">
              <button className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px]">耳机调研对比</button>
            </div>
            <div className="flex items-center rounded-lg pr-1 hover:bg-muted/60">
              <button className="min-w-0 flex-1 truncate px-2.5 py-2 text-left text-[13px]">翻译 PDF 文档</button>
            </div>
          </div>
        </div>
        <div className="border-t border-border-soft p-2">
          <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
            <span className="opacity-70">⚙</span> 切换主题（预览）
          </button>
          <button onClick={() => setSettingsOpen(true)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
            <span className="opacity-70">⚙</span> 设置（预览）
          </button>
          <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        </div>
      </aside>

      {/* Conversation */}
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border-soft px-5 py-3">
          <div className="truncate text-[13px] font-medium">耳机调研对比</div>
          <div className="ml-auto flex gap-2">
            <button
              onClick={() => { setPlanMode(true); setPlanConfirming(true); }}
              className="rounded-lg bg-info/10 px-3 py-1 text-[12px] text-info hover:bg-info/20"
            >
              ← 模拟计划完成
            </button>
            <button
              onClick={() => setPlanConfirming(false)}
              className="rounded-lg bg-muted px-3 py-1 text-[12px] text-muted-foreground hover:bg-accent"
            >
              重置
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-[768px] space-y-6">
            <Bubble />
            {/* Assistant turn — flat, no avatar (Codex style) */}
            <Assistant />
            <div>
              <ToolCallGroup
                cards={[
                  { itemId: '1', toolName: 'navigate', label: '导航', status: 'ok', paramsSummary: 'taobao.com/item…', durationMs: 1200 },
                  { itemId: '2', toolName: 'read_page', label: '读取页面', status: 'ok', paramsSummary: '增量快照 s4', durationMs: 300 },
                  { itemId: '3', toolName: 'extract', label: '提取', status: 'fail', resultText: '快照已过期：ref "s3_2" 不属于当前快照，请重新 read_page' },
                  { itemId: '4', toolName: 'click', label: '点击元素', status: 'running', progressText: '等待加载…', params: { element: '评价标签页', ref: 's4_11' } },
                ]}
              />
            </div>
            <AssistantThinking />
          </div>
        </div>
        {/* Plan confirm card replaces composer when plan is ready */}
        {planConfirming ? (
          <PlanConfirmCard
            todos={PLAN_TODOS}
            onConfirm={() => { setPlanConfirming(false); setPlanMode(false); }}
            onEdit={() => { setPlanConfirming(false); setPlanMode(false); }}
            onCancel={() => { setPlanConfirming(false); setPlanMode(false); }}
          />
        ) : (
          <div className="mx-auto w-full max-w-[768px]">
            <Composer planMode={planMode} onPlanModeChange={setPlanMode} />
          </div>
        )}
      </main>

      {/* Task panel — simplified (no token display) */}
      <aside className="w-56 shrink-0 border-l border-border-soft bg-card p-4">
        <div className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-faint-foreground">任务面板</div>
        <div className="space-y-1.5 text-[13px]">
          <div className="flex items-start gap-2 text-faint-foreground">
            <span className="mt-0.5 shrink-0 text-[11px] text-success">✓</span>
            <span className="line-through">打开商品页 A</span>
          </div>
          <div className="flex items-start gap-2 text-faint-foreground">
            <span className="mt-0.5 shrink-0 text-[11px] text-success">✓</span>
            <span className="line-through">读取评价</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0 text-[11px] text-faint-foreground">○</span>
            <span>汇总对比</span>
          </div>
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
