/**
 * Tool-level switch (docs/09 §2 InputToolbar): per-session restriction of the
 * tool registry — pure chat / read-only page ops / full browser operation.
 * Sent as TurnOverrides.enabledToolLevels with each turn.submit.
 */

import { Check, ChevronDown, Wrench } from 'lucide-react';
import { Button } from './ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { cn } from '../lib/utils';

type ToolLevel = 'L0' | 'L1' | 'L2' | 'mcp';

const MODES: { id: string; label: string; hint: string; levels: ToolLevel[] | undefined }[] = [
  { id: 'full', label: '全部工具', hint: '浏览器操作 + MCP（默认）', levels: undefined },
  { id: 'browse', label: '仅 L0/L1', hint: '常规页面操作，无调试模式', levels: ['L0', 'L1', 'mcp'] },
  { id: 'chat', label: '纯聊天', hint: '不提供任何工具', levels: [] },
];

interface Props {
  value: ToolLevel[] | undefined;
  onSelect: (levels: ToolLevel[] | undefined) => void;
}

export function ToolLevelSwitch({ value, onSelect }: Props) {
  const current = MODES.find((m) => JSON.stringify(m.levels) === JSON.stringify(value)) ?? MODES[0]!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 rounded-full px-2 text-[11px] text-muted-foreground hover:text-foreground"
          aria-label="工具级别"
        >
          <Wrench className="size-3" />
          {current.label}
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        {MODES.map((m) => (
          <DropdownMenuItem key={m.id} onClick={() => onSelect(m.levels)}>
            <Check className={cn('size-4', m.id === current.id ? 'opacity-100' : 'opacity-0')} />
            <div className="flex min-w-0 flex-col">
              <span>{m.label}</span>
              <span className="text-[11px] text-faint-foreground">{m.hint}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
