/**
 * ModelSelector (docs/09 §2): switch model mid-conversation. Selection is a
 * sticky per-session TurnOverrides.model sent with each turn.submit.
 *
 * Two trigger variants (OpenWebUI parity where space allows):
 *  - 'header': full-page top-left, text-style trigger with the model name
 *    (OpenWebUI Navbar selector);
 *  - 'composer': compact pill inside the input toolbar (side panel — a 360px
 *    surface has no room in the header).
 * Popover upgrades borrowed from OpenWebUI's Selector: autofocused search,
 * connection filter pills when >1 connection, and an empty-state CTA that
 * jumps straight to Settings → Providers (the BYOK dead-end killer).
 */

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu } from 'lucide-react';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ToggleGroup, ToggleGroupItem } from './ui/toggle-group';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from './ui/empty';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import { decryptSecret } from '../../settings/crypto';
import { fetchAllModels } from '../../providers/registry';
import type { Connection } from '../../providers/types';
import { useStorageValue } from '../useStorageValue';

export interface ModelChoice {
  connectionId: string;
  modelId: string;
  /** Display label: model id, prefixed when connections collide. */
  label: string;
  connectionName: string;
}

interface Props {
  /** Currently selected model, or null = the configured global/preset default. */
  value: { connectionId: string; modelId: string } | null;
  onSelect: (choice: ModelChoice | null) => void;
  /** Whether the selector may store a null value that follows the configured default. */
  allowDefaultSelection?: boolean;
  /** Trigger placement variant; popover content is shared. */
  variant?: 'composer' | 'header';
  /** Empty-state CTA: open settings on the Providers tab. */
  onOpenSettings?: () => void;
}

export function ModelSelector({
  value,
  onSelect,
  allowDefaultSelection = true,
  variant = 'composer',
  onOpenSettings,
}: Props) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);
  const [connFilter, setConnFilter] = useState<string | null>(null);
  const storedConnections = useStorageValue<Connection[] | null>('connections', null);
  const choicesSource = useRef<Connection[] | null>(null);
  const loadGeneration = useRef(0);
  const automaticSelection = useRef<string | null>(null);

  // Required selectors load eagerly so a missing or stale value can be replaced
  // with a concrete model before the user starts a conversation.
  // Stale decrypt/model requests cannot replace choices for a newer snapshot.
  useEffect(() => {
    if (choicesSource.current !== storedConnections) {
      setChoices(null);
      setConnFilter(null);
    }
    if (
      (!open && allowDefaultSelection) ||
      storedConnections === null ||
      choicesSource.current === storedConnections
    )
      return;
    const generation = ++loadGeneration.current;
    void (async () => {
      // Keys are AES-GCM obfuscated at rest — decrypt before the live fetch.
      const connections = await Promise.all(
        storedConnections.map(async (c) => ({
          ...c,
          apiKeys: await Promise.all(c.apiKeys.map(decryptSecret)),
        })),
      );
      const results = await fetchAllModels(connections);
      if (loadGeneration.current !== generation) return;
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
      choicesSource.current = storedConnections;
      setChoices(list);
    })();
    return () => {
      if (loadGeneration.current === generation) loadGeneration.current += 1;
    };
  }, [allowDefaultSelection, open, storedConnections]);

  useEffect(() => {
    if (allowDefaultSelection || choices === null || choices.length === 0) return;
    const selectedIsAvailable =
      value !== null &&
      choices.some(
        (choice) => choice.connectionId === value.connectionId && choice.modelId === value.modelId,
      );
    if (selectedIsAvailable) {
      automaticSelection.current = null;
      return;
    }
    const first = choices[0];
    if (!first) return;
    const key = `${first.connectionId}:${first.modelId}`;
    if (automaticSelection.current === key) return;
    automaticSelection.current = key;
    onSelect(first);
  }, [allowDefaultSelection, choices, onSelect, value]);

  const current = value
    ? (choices?.find((c) => c.connectionId === value.connectionId && c.modelId === value.modelId)
        ?.label ?? value.modelId)
    : t(allowDefaultSelection ? 'model.default' : 'model.select');

  const connNames = [...new Set((choices ?? []).map((c) => c.connectionName))];
  const visible = connFilter
    ? (choices ?? []).filter((c) => c.connectionName === connFilter)
    : (choices ?? []);
  const groups = new Map<string, ModelChoice[]>();
  for (const c of visible) {
    const g = groups.get(c.connectionName) ?? [];
    g.push(c);
    groups.set(c.connectionName, g);
  }

  const loaded = choices !== null;
  const isEmpty = loaded && choices.length === 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {variant === 'header' ? (
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0 max-w-full"
            aria-label={t('model.select')}
          >
            <span className="max-w-24 truncate sm:max-w-40 lg:max-w-56">{current}</span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        ) : (
          <Button variant="ghost" size="xs" aria-label={t('model.select')}>
            <Cpu data-icon="inline-start" />
            <span className="max-w-32 truncate">{current}</span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0"
        align="start"
        side={variant === 'header' ? 'bottom' : 'top'}
      >
        {isEmpty ? (
          /* Dead-end → fix: no models means no key/connection (OpenWebUI's
             best onboarding micro-pattern). */
          <Empty className="px-4 py-6 md:p-6">
            <EmptyHeader>
              <EmptyTitle>{t('model.none')}</EmptyTitle>
              <EmptyDescription>{t('model.noneHint')}</EmptyDescription>
            </EmptyHeader>
            {onOpenSettings && (
              <EmptyContent>
                <Button
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                    onOpenSettings();
                  }}
                >
                  {t('model.manage')}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        ) : (
          <Command>
            <CommandInput autoFocus placeholder={t('model.search')} />
            {connNames.length > 1 && (
              <ToggleGroup
                type="single"
                value={connFilter ?? '__all__'}
                onValueChange={(next) => {
                  if (next) setConnFilter(next === '__all__' ? null : next);
                }}
                variant="outline"
                size="sm"
                spacing={1}
                className="max-w-full overflow-x-auto border-b border-border-soft px-2 py-1.5 [scrollbar-width:none]"
                aria-label={t('model.select')}
              >
                <ToggleGroupItem value="__all__">{t('model.all')}</ToggleGroupItem>
                {connNames.map((name) => (
                  <ToggleGroupItem key={name} value={name}>
                    {name}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            )}
            <CommandList>
              <CommandEmpty>{loaded ? t('model.noMatch') : t('model.loading')}</CommandEmpty>
              {allowDefaultSelection && (
                <CommandGroup>
                  <CommandItem
                    value="__default__"
                    onSelect={() => {
                      onSelect(null);
                      setOpen(false);
                    }}
                  >
                    <Check
                      data-icon="inline-start"
                      className={cn(value === null ? 'opacity-100' : 'opacity-0')}
                    />
                    <div className="flex flex-col">
                      <span>{t('model.default')}</span>
                      <span className="text-[11px] text-muted-foreground">
                        {t('model.defaultHint')}
                      </span>
                    </div>
                  </CommandItem>
                </CommandGroup>
              )}
              {[...groups.entries()].map(([connName, models]) => (
                <CommandGroup key={connName} heading={connName}>
                  {models.map((m) => {
                    const selected =
                      value?.connectionId === m.connectionId && value?.modelId === m.modelId;
                    return (
                      <CommandItem
                        key={`${m.connectionId}:${m.modelId}`}
                        value={m.label}
                        onSelect={() => {
                          onSelect(m);
                          setOpen(false);
                        }}
                      >
                        <Check
                          data-icon="inline-start"
                          className={cn(selected ? 'opacity-100' : 'opacity-0')}
                        />
                        <span className="truncate font-mono text-[12px]">{m.label}</span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}
