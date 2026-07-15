/**
 * Standalone visual preview of Panelot's presentational UI. No chrome APIs,
 * no engine — just the styled pieces with mock data, so the ChatGPT/OpenWebUI
 * look can be checked in a plain browser. Not shipped in the extension.
 */

import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import { ArrowUp, PanelLeft, Plus, Search, Settings } from 'lucide-react';
import { MessageStream } from '../src/ui/components/MessageStream';
import { PermissionSwitch } from '../src/ui/components/PermissionSwitch';
import { SettingsModal } from '../src/ui/settings/SettingsModal';
import { Button } from '../src/ui/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from '../src/ui/components/ui/input-group';
import { TooltipProvider } from '../src/ui/components/ui/tooltip';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '../src/ui/components/ui/sheet';
import type { SnapshotItem } from '../src/messaging/protocol';
import type { LiveItem } from '../src/ui/engineClient';
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

const MOCK_ITEMS: SnapshotItem[] = [
  {
    nodeId: 'user-1',
    kind: 'user_message',
    ts: 1,
    payload: {
      content: [{ type: 'text', text: '帮我调研这三款耳机的评价并做对比表' }],
      attachedContext: [
        { kind: 'page', label: '淘宝 · XX 耳机', content: [{ type: 'text', text: '页面内容' }] },
      ],
    },
  },
  {
    nodeId: 'assistant-plan',
    kind: 'assistant_message',
    ts: 1_000,
    payload: {
      content: [],
      reasoning: '先读取当前商品页，再根据页面结果决定下一步需要打开和提取的内容。',
      model: 'claude-sonnet-5',
      connectionId: 'preview',
    },
  },
  ...[
    ['navigate', { url: 'https://example.com/headphones/a' }],
    ['read_page', { snapshot: 's4' }],
    ['extract', { fields: ['评分', '降噪', '续航'] }],
  ].flatMap(([toolName, params], index): SnapshotItem[] => {
    const itemId = `tool-${index}`;
    return [
      {
        nodeId: `${itemId}-call`,
        kind: 'tool_call',
        ts: index * 2_000 + 3_000,
        payload: { itemId, toolName, params, level: 'L1' },
      },
      {
        nodeId: `${itemId}-result`,
        kind: 'tool_result',
        ts: index * 2_000 + 4_000,
        payload: {
          itemId,
          ok: true,
          contentForLlm: [{ type: 'text', text: `${toolName} 完成` }],
        },
      },
    ];
  }),
  {
    nodeId: 'assistant-1',
    kind: 'assistant_message',
    ts: 10_000,
    payload: {
      content: [{ type: 'text', text: ASSISTANT_MD }],
      reasoning:
        '先读取当前页面拿到第一款的评价，再打开另外两款页面分别提取，最后按音质、降噪、佩戴和续航汇总。',
      model: 'claude-sonnet-5',
      connectionId: 'preview',
      usage: { input: 18_240, output: 1_386 },
    },
  },
];

const LIVE_ITEMS: LiveItem[] = [
  {
    itemId: 'user-live',
    kind: 'user_message',
    meta: {},
    text: '再帮我确认一下型号 C 的差评里有没有连接稳定性问题',
    reasoning: '',
    status: 'ok',
  },
  {
    itemId: 'thinking-live',
    kind: 'assistant_message',
    meta: {},
    text: '',
    reasoning: '正在筛选型号 C 的一星到三星评价，并排除物流和包装相关反馈…',
    status: 'streaming',
  },
  {
    itemId: 'tool-live',
    kind: 'tool_call',
    meta: { toolName: 'read_page', label: '读取差评列表' },
    text: '',
    reasoning: '',
    toolProgress: { progressText: '正在读取第 2 页…' },
    status: 'streaming',
  },
];

function Composer() {
  const [text, setText] = useState('');
  return (
    <div className="px-4 pb-4 pt-1">
      <InputGroup className="h-auto flex-col rounded-3xl bg-muted px-2 py-1.5 shadow-soft">
        <InputGroupTextarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="给 Panelot 发消息…"
          rows={1}
          className="min-h-9 py-2"
        />
        <InputGroupAddon align="block-end" className="gap-1 px-1 pb-0 pt-0.5">
          <InputGroupButton size="icon-sm" aria-label="添加附件">
            <Plus />
          </InputGroupButton>
          <PermissionSwitch value={undefined} onSelect={() => undefined} />
          <span className="flex-1" />
          <InputGroupButton
            variant="default"
            size="icon-sm"
            aria-label="发送"
            disabled={!text.trim()}
          >
            <ArrowUp />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
      <div className="mt-1.5 px-2 text-center text-[11px] text-faint-foreground">
        Enter 发送 · Shift+Enter 换行
      </div>
    </div>
  );
}

function PreviewNavigation({
  onClose,
  onToggleTheme,
  onOpenSettings,
}: {
  onClose?: () => void;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="flex flex-col gap-2 p-3">
        <Button variant="outline" className="w-full justify-start" onClick={onClose}>
          <Plus data-icon="inline-start" /> 新会话
        </Button>
        <InputGroup>
          <InputGroupAddon>
            <Search />
          </InputGroupAddon>
          <InputGroupInput placeholder="搜索会话" />
        </InputGroup>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div className="mb-3">
          <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-faint-foreground">
            今天
          </div>
          <div className="flex items-center rounded-lg bg-muted pr-1">
            <Button
              variant="ghost"
              className="min-w-0 flex-1 justify-start truncate"
              onClick={onClose}
            >
              耳机调研对比
            </Button>
          </div>
          <div className="flex items-center rounded-lg pr-1 hover:bg-muted/60">
            <Button variant="ghost" className="min-w-0 flex-1 justify-start truncate">
              翻译 PDF 文档
            </Button>
          </div>
        </div>
      </div>
      <div className="border-t border-border-soft p-2">
        <Button variant="ghost" onClick={onToggleTheme} className="w-full justify-start">
          <Settings data-icon="inline-start" /> 切换主题（预览）
        </Button>
        <Button variant="ghost" onClick={onOpenSettings} className="w-full justify-start">
          <Settings data-icon="inline-start" /> 设置（预览）
        </Button>
      </div>
    </div>
  );
}

function Preview() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border-soft bg-card lg:flex">
        <PreviewNavigation
          onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </aside>

      {/* Conversation */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-border-soft">
          <div className="grid h-11 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-3">
            <div className="flex min-w-0 items-center">
              <Sheet open={navOpen} onOpenChange={setNavOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="lg:hidden"
                    aria-label="打开会话导航"
                  >
                    <PanelLeft />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left" className="w-[min(88vw,320px)] gap-0 p-0 sm:max-w-xs">
                  <SheetHeader className="sr-only">
                    <SheetTitle>最近会话</SheetTitle>
                    <SheetDescription>搜索和切换会话</SheetDescription>
                  </SheetHeader>
                  <PreviewNavigation
                    onClose={() => setNavOpen(false)}
                    onToggleTheme={() =>
                      setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
                    }
                    onOpenSettings={() => {
                      setNavOpen(false);
                      setSettingsOpen(true);
                    }}
                  />
                </SheetContent>
              </Sheet>
            </div>
            <div className="max-w-[42vw] truncate px-2 text-center text-[13px] text-muted-foreground">
              耳机调研对比
            </div>
            <div aria-hidden="true" />
          </div>
        </header>
        <MessageStream items={MOCK_ITEMS} liveItems={LIVE_ITEMS} contentMaxWidth={768} />
        <div className="mx-auto w-full max-w-[768px]">
          <Composer />
        </div>
      </main>
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <TooltipProvider>
      <Preview />
    </TooltipProvider>
  </React.StrictMode>,
);
