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
import { t } from '../i18n';
import { SettingsStore } from '../../settings/store';
import { decryptSecret } from '../../settings/crypto';
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
  /** Trigger placement variant; popover content is shared. */
  variant?: 'composer' | 'header';
  /** Empty-state CTA: open settings on the Providers tab. */
  onOpenSettings?: () => void;
}

export function ModelSelector({ value, onSelect, variant = 'composer', onOpenSettings }: Props) {
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<ModelChoice[] | null>(null);
  const [connFilter, setConnFilter] = useState<string | null>(null);

  // Fetch on first open; cached for the component's lifetime (PV-3: all
  // connections concurrently, per-connection 4s timeout inside fetchAllModels).
  useEffect(() => {
    if (!open || choices !== null) return;
    void (async () => {
      const stored: Connection[] = await SettingsStore.connections.get();
      // Keys are AES-GCM obfuscated at rest — decrypt before the live fetch.
      const connections = await Promise.all(
        stored.map(async (c) => ({
          ...c,
          apiKeys: await Promise.all(c.apiKeys.map(decryptSecret)),
        })),
      );
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
    ? (choices?.find((c) => c.connectionId === value.connectionId && c.modelId === value.modelId)
        ?.label ?? value.modelId)
    : t('model.default');

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
            className="h-8 gap-1 px-2 text-[15px] font-medium"
            aria-label={t('model.select')}
          >
            <span className="max-w-56 truncate">{current}</span>
            <ChevronDown className="size-3.5 text-faint-foreground" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 rounded-full px-2 text-[11px] text-muted-foreground hover:text-foreground"
            aria-label={t('model.select')}
          >
            <Cpu className="size-3" />
            <span className="max-w-32 truncate">{current}</span>
            <ChevronDown className="size-3 opacity-60" />
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
          <div className="flex flex-col items-center gap-1.5 px-4 py-6 text-center">
            <div className="text-[13px] font-medium">{t('model.none')}</div>
            <div className="text-[12px] text-muted-foreground">{t('model.noneHint')}</div>
            {onOpenSettings && (
              <Button
                size="sm"
                className="mt-2"
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
              >
                {t('model.manage')}
              </Button>
            )}
          </div>
        ) : (
          <Command>
            <CommandInput autoFocus placeholder={t('model.search')} />
            {connNames.length > 1 && (
              <div className="flex gap-1 overflow-x-auto border-b border-border-soft px-2 py-1.5 [scrollbar-width:none]">
                <FilterPill
                  label={t('model.all')}
                  active={connFilter === null}
                  onClick={() => setConnFilter(null)}
                />
                {connNames.map((name) => (
                  <FilterPill
                    key={name}
                    label={name}
                    active={connFilter === name}
                    onClick={() => setConnFilter(name)}
                  />
                ))}
              </div>
            )}
            <CommandList>
              <CommandEmpty>{loaded ? t('model.noMatch') : t('model.loading')}</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="__default__"
                  onSelect={() => {
                    onSelect(null);
                    setOpen(false);
                  }}
                >
                  <Check className={cn('size-4', value === null ? 'opacity-100' : 'opacity-0')} />
                  <div className="flex flex-col">
                    <span>{t('model.default')}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {t('model.defaultHint')}
                    </span>
                  </div>
                </CommandItem>
              </CommandGroup>
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
                        <Check className={cn('size-4', selected ? 'opacity-100' : 'opacity-0')} />
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

function FilterPill({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
        active
          ? 'border-primary/30 bg-primary/10 text-primary'
          : 'border-transparent bg-muted text-muted-foreground hover:text-foreground',
      )}
    >
      {label}
    </button>
  );
}
