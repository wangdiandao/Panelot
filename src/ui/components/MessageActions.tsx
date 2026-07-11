/**
 * MessageActions — the per-message icon row (docs/09 §2).
 *
 * Reveal recipe from LibreChat HoverButtons (three correctness rules most
 * chat UIs miss): hidden only on hover-capable devices, revealed by hover OR
 * focus-within OR an open menu, and the LAST message keeps its row visible.
 * Opacity/visibility toggling only — the row always occupies layout height so
 * react-virtuoso never re-measures on hover.
 *
 * Approval keys (Y/S/A/N) never appear here — that contract is fixed.
 */

import { useState } from 'react';
import { Check, Copy, Info, Pencil, RefreshCw } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import type { Usage } from '../../messaging/protocol';

export interface MessageActionsProps {
  role: 'user' | 'assistant';
  /** Raw text for the clipboard. */
  text: string;
  isLast: boolean;
  /** Assistant-only: regenerate this response as a sibling branch. */
  onRegenerate?: () => void;
  /** User-only: switch the bubble to edit-in-place. */
  onEdit?: () => void;
  /** Assistant-only usage popover data. */
  usage?: Usage;
  model?: string;
  align?: 'start' | 'end';
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function MessageActions({
  role,
  text,
  isLast,
  onRegenerate,
  onEdit,
  usage,
  model,
  align = 'start',
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    });
  };

  return (
    <div
      className={cn(
        'flex h-7 items-center gap-0.5',
        align === 'end' && 'justify-end',
        // LibreChat reveal recipe: touch devices always show; hover devices
        // reveal on hover/focus-within/open-menu; last message always shows.
        !isLast &&
          '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/msg:opacity-100 [@media(hover:hover)]:group-focus-within/msg:opacity-100 [@media(hover:hover)]:has-[[data-state=open]]:opacity-100',
      )}
    >
      <ActionButton label={copied ? t('actions.copied') : t('actions.copy')} onClick={copy}>
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </ActionButton>
      {role === 'assistant' && onRegenerate && (
        <ActionButton label={t('actions.regenerate')} onClick={onRegenerate}>
          <RefreshCw className="size-3.5" />
        </ActionButton>
      )}
      {role === 'user' && onEdit && (
        <ActionButton label={t('actions.edit')} onClick={onEdit}>
          <Pencil className="size-3.5" />
        </ActionButton>
      )}
      {role === 'assistant' && usage && (
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t('actions.usage')}
                  className="rounded-lg p-1.5 text-faint-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  <Info className="size-3.5" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('actions.usage')}</TooltipContent>
          </Tooltip>
          <PopoverContent side="top" align="start" className="w-56 p-3 text-[12px]">
            <div className="space-y-0.5 font-mono text-muted-foreground">
              {model && (
                <div className="mb-1 truncate border-b border-border-soft pb-1 font-sans font-medium text-foreground">
                  {model}
                </div>
              )}
              <div className="flex justify-between">
                <span>input</span>
                <span>{fmt(usage.input)}</span>
              </div>
              <div className="flex justify-between">
                <span>output</span>
                <span>{fmt(usage.output)}</span>
              </div>
              {usage.cacheRead !== undefined && (
                <div className="flex justify-between">
                  <span>cache read</span>
                  <span>{fmt(usage.cacheRead)}</span>
                </div>
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="rounded-lg p-1.5 text-faint-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
