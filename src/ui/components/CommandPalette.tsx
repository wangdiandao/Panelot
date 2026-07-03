/**
 * Command palette (docs/09 §6, Cmd/Ctrl+K): thread switching (Dexie search),
 * new chat, settings sections, and host-supplied commands — VSCode/Slack
 * pattern via shadcn CommandDialog (cmdk).
 */

import { useEffect, useState } from 'react';
import { MessageSquare, Plus, Settings } from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './ui/command';
import { PanelotDB } from '../../db/schema';
import type { ThreadMeta } from '../../db/types';

const db = new PanelotDB();

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenThread: (threadId: string) => void;
  onNewThread: () => void;
  onOpenSettings: (section?: string) => void;
  commands?: PaletteCommand[];
}

export function CommandPalette({ open, onOpenChange, onOpenThread, onNewThread, onOpenSettings, commands = [] }: Props) {
  const [threads, setThreads] = useState<ThreadMeta[]>([]);

  useEffect(() => {
    if (!open) return;
    void db.threads.orderBy('updatedAt').reverse().limit(50).toArray().then((list) => {
      setThreads(list.filter((t) => !t.deleting && !t.archived));
    });
  }, [open]);

  const runAndClose = (fn: () => void) => () => {
    fn();
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="命令面板" description="切换会话、执行命令">
      <CommandInput placeholder="搜索会话或命令…" />
      <CommandList>
        <CommandEmpty>无匹配结果</CommandEmpty>
        <CommandGroup heading="操作">
          <CommandItem value="__new__ 新会话 new chat" onSelect={runAndClose(onNewThread)}>
            <Plus className="size-4" /> 新会话
            <span className="ml-auto text-[11px] text-faint-foreground">Ctrl+N</span>
          </CommandItem>
          <CommandItem value="__settings__ 设置 settings" onSelect={runAndClose(() => onOpenSettings())}>
            <Settings className="size-4" /> 打开设置
            <span className="ml-auto text-[11px] text-faint-foreground">Ctrl+,</span>
          </CommandItem>
          {commands.map((c) => (
            <CommandItem key={c.id} value={`${c.id} ${c.label}`} onSelect={runAndClose(c.run)}>
              {c.label}
              {c.hint && <span className="ml-auto text-[11px] text-faint-foreground">{c.hint}</span>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="会话">
          {threads.map((t) => (
            <CommandItem key={t.id} value={`${t.id} ${t.title}`} onSelect={runAndClose(() => onOpenThread(t.id))}>
              <MessageSquare className="size-4 text-muted-foreground" />
              <span className="truncate">{t.title || '未命名会话'}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
