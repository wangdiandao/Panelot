/**
 * ModelSelector (docs/09 §2 InputToolbar): switch model mid-conversation.
 * Lives inside the composer (works in the narrow side panel, unlike
 * OpenWebUI's top bar; same role as ChatGPT's model menu). Selection is a
 * sticky per-session TurnOverrides.model sent with each turn.submit.
 * Popover + Command per shadcn composition guidance.
 */

import { useEffect, useState } from 'react';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';
import { cn } from '../lib/utils';
import { SettingsStore } from '../../settings/store';
import { fetchAllModels } from '../../providers/registry';
import type { Connection } from '../../providers/types';

export interface ModelChoice {
  connectionId: string;
  modelId: string;
  /** Display label: model id, prefixed when connections collide. */
  label: string;
  connectionName: string;
}

interface Props {
  /** Currently selected model (sticky override), or null = preset default. */
  value: { connectionId: string; modelId: string } | null;
  onSelect: (choice: ModelChoice | null) => void;
}

export function ModelSelector({ value, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);

  // Fetch on first open; cached for the component's lifetime (PV-3: all
  // connections concurrently, per-connection 4s timeout inside fetchAllModels).
  useEffect(() => {
    if (!open || choices !== null) return;
    void (async () => {
      const connections: Connection[] = await SettingsStore.connections.get();
      const results = await fetchAllModels(connections);
      const byId = new Map(connections.map((c) => [c.id, c]));
      const list: ModelChoice[] = results.flatMap((r) => {
        const conn = byId.get(r.connectionId);
        if (!conn) return [];
        return r.models.map((m) => ({
          connectionId: r.connectionId,
          modelId: m.id,
          label: conn.prefixId ? `${conn.prefixId}/${m.id}` : m.id,
          connectionName: conn.name || conn.baseUrl,
        }));
      });
      setChoices(list);
    })();
  }, [open, choices]);

  const current = value
    ? choices?.find((c) => c.connectionId === value.connectionId && c.modelId === value.modelId)?.label ?? value.modelId
    : '默认模型';

  const groups = new Map<string, ModelChoice[]>();
  for (const c of choices ?? []) {
    const g = groups.get(c.connectionName) ?? [];
    g.push(c);
    groups.set(c.connectionName, g);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 rounded-full px-2 text-[11px] text-muted-foreground hover:text-foreground"
          aria-label="选择模型"
        >
          <Cpu className="size-3" />
          <span className="max-w-32 truncate">{current}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" side="top">
        <Command>
          <CommandInput placeholder="搜索模型…" />
          <CommandList>
            <CommandEmpty>{choices === null ? '加载模型…' : '没有匹配的模型'}</CommandEmpty>
            <CommandGroup heading="预设">
              <CommandItem
                value="__default__"
                onSelect={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                <Check className={cn('size-4', value === null ? 'opacity-100' : 'opacity-0')} />
                默认模型（跟随预设）
              </CommandItem>
            </CommandGroup>
            {[...groups.entries()].map(([connName, models]) => (
              <CommandGroup key={connName} heading={connName}>
                {models.map((m) => {
                  const selected = value?.connectionId === m.connectionId && value?.modelId === m.modelId;
                  return (
                    <CommandItem
                      key={`${m.connectionId}:${m.modelId}`}
                      value={m.label}
                      onSelect={() => {
                        onSelect(m);
                        setOpen(false);
                      }}
                    >
                      <Check className={cn('size-4', selected ? 'opacity-100' : 'opacity-0')} />
                      <span className="truncate font-mono text-[12px]">{m.label}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
