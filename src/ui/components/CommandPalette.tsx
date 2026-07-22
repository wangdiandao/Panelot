/**
 * Command palette (docs/development/ui.md §6, Cmd/Ctrl+K): actions + full-text thread search
 * (titles AND message bodies via threadSearch.ts, OpenWebUI SearchModal
 * semantics) with highlighted snippets and debounced queries. Built on
 * shadcn CommandDialog (cmdk); we disable cmdk's own filter and do our own
 * async search, IME-guarded for zh-CN.
 */

import { useEffect, useRef, useState } from 'react';
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
import { searchThreads, type ThreadSearchHit } from '../threadSearch';
import { t } from '../i18n';

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

/** Wrap the matched query substring in <mark> (title/snippet highlight). */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-primary/20 text-inherit">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
  onOpenThread,
  onNewThread,
  onOpenSettings,
  commands = [],
}: Props) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ThreadSearchHit[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchGeneration = useRef(0);

  // Debounced full-text search (300ms — body scan hits IndexedDB).
  useEffect(() => {
    const generation = ++searchGeneration.current;
    if (!open) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        void searchThreads(db, query).then((nextHits) => {
          if (searchGeneration.current === generation) setHits(nextHits);
        });
      },
      query.trim() ? 300 : 0,
    );
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [open, query]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      searchGeneration.current += 1;
      if (timer.current) clearTimeout(timer.current);
      setQuery('');
      setHits([]);
    }
    onOpenChange(nextOpen);
  };

  const runAndClose = (fn: () => void) => () => {
    fn();
    setQuery('');
    setHits([]);
    onOpenChange(false);
  };

  const q = query.trim().toLowerCase();
  const actionMatch = (label: string) => !q || label.toLowerCase().includes(q);

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t('palette.title')}
      description={t('palette.desc')}
      shouldFilter={false}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t('palette.placeholder')}
        onKeyDown={(e) => {
          // IME guard: composition-confirm Enter must not select (zh-CN).
          if (e.nativeEvent.isComposing || e.keyCode === 229) e.stopPropagation();
        }}
      />
      <CommandList>
        <CommandEmpty>{t('palette.noResults')}</CommandEmpty>
        {(actionMatch(t('app.newChat')) ||
          actionMatch(t('app.settings')) ||
          commands.some((c) => actionMatch(c.label))) && (
          <CommandGroup heading={t('palette.actions')}>
            {actionMatch(t('app.newChat')) && (
              <CommandItem value="__new__" onSelect={runAndClose(onNewThread)}>
                <Plus data-icon="inline-start" /> {t('app.newChat')}
                <span className="ml-auto text-[11px] text-faint-foreground">Ctrl+N</span>
              </CommandItem>
            )}
            {actionMatch(t('app.settings')) && (
              <CommandItem value="__settings__" onSelect={runAndClose(() => onOpenSettings())}>
                <Settings data-icon="inline-start" /> {t('app.settings')}
                <span className="ml-auto text-[11px] text-faint-foreground">Ctrl+,</span>
              </CommandItem>
            )}
            {commands
              .filter((c) => actionMatch(c.label))
              .map((c) => (
                <CommandItem key={c.id} value={c.id} onSelect={runAndClose(c.run)}>
                  {c.label}
                  {c.hint && (
                    <span className="ml-auto text-[11px] text-faint-foreground">{c.hint}</span>
                  )}
                </CommandItem>
              ))}
          </CommandGroup>
        )}
        <CommandSeparator />
        <CommandGroup heading={t('palette.threads')}>
          {hits.map(({ thread, snippet }) => (
            <CommandItem
              key={thread.id}
              value={thread.id}
              onSelect={runAndClose(() => onOpenThread(thread.id))}
            >
              <MessageSquare data-icon="inline-start" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate">
                  <Highlight text={thread.title || t('app.untitled')} query={query} />
                </span>
                {snippet && (
                  <span className="truncate text-[11px] text-faint-foreground">
                    <Highlight text={snippet} query={query} />
                  </span>
                )}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
