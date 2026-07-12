/**
 * Tool call card + collapsible group (docs/09 §4.2).
 * pending(⏳) → running(progress text) → ok(✓ + duration) | fail(✗ + error).
 * ≥3 consecutive cards collapse into a group header "N 步浏览器操作 ✓m ✗k";
 * a running group auto-expands its tail card.
 *
 * Visual language follows Vercel AI Elements' Tool component: a status badge
 * on the header, params rendered as a labeled section, output/error as a
 * separate tinted section. Built on shadcn Collapsible + Badge + lucide.
 */

import { useState, type ReactNode } from 'react';
import { Check, ChevronRight, CircleAlert, Clock, Loader2, X } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import { ActionEvidenceDetails, isActionEvidence } from './ActionEvidenceDetails';

export interface ToolCardData {
  itemId: string;
  toolName: string;
  label: string;
  status: 'pending' | 'running' | 'ok' | 'fail';
  progressText?: string;
  paramsSummary?: string;
  params?: unknown;
  resultText?: string;
  durationMs?: number;
  details?: unknown;
}

const STATUS_ICON: Record<ToolCardData['status'], ReactNode> = {
  pending: <Clock className="size-3.5 text-muted-foreground" />,
  running: <Loader2 className="size-3.5 animate-spin text-info" />,
  ok: <Check className="size-3.5 text-success" />,
  fail: <X className="size-3.5 text-destructive" />,
};

/** Status accent on the card's left edge — scannable without reading icons. */
const STATUS_EDGE: Record<ToolCardData['status'], string> = {
  pending: 'border-l-border',
  running: 'border-l-info/60',
  ok: 'border-l-success/50',
  fail: 'border-l-destructive/60',
};

export function ToolCallCard({ card }: { card: ToolCardData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className={cn(
        'overflow-hidden rounded-xl border border-border/30 border-l-2 bg-card text-[13px]',
        STATUS_EDGE[card.status],
      )}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted">
        {STATUS_ICON[card.status]}
        <span className="font-medium text-foreground">{card.label}</span>
        {card.toolName && card.toolName !== card.label && (
          <Badge
            variant="outline"
            className="h-4 rounded px-1 font-mono text-[10px] font-normal text-faint-foreground"
          >
            {card.toolName}
          </Badge>
        )}
        {card.paramsSummary && (
          <span className="truncate font-mono text-[11px] text-faint-foreground">
            {card.paramsSummary}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-faint-foreground">
          {card.status === 'running' && card.progressText && (
            <span className="max-w-40 truncate">{card.progressText}</span>
          )}
          {card.durationMs !== undefined && card.status === 'ok' && (
            <span>{(card.durationMs / 1000).toFixed(1)}s</span>
          )}
          <ChevronRight
            className={cn('size-3 opacity-50 transition-transform', expanded && 'rotate-90')}
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 border-t border-border-soft px-3 py-2">
          {card.params !== undefined && (
            <section>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-faint-foreground">
                {t('tool.params')}
              </div>
              <pre className="max-h-40 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px] text-muted-foreground">
                {JSON.stringify(card.params, null, 2)}
              </pre>
            </section>
          )}
          {card.resultText && (
            <section>
              <div
                className={cn(
                  'mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide',
                  card.status === 'fail' ? 'text-destructive' : 'text-faint-foreground',
                )}
              >
                {card.status === 'fail' && <CircleAlert className="size-3" />}
                {card.status === 'fail' ? t('tool.error') : t('tool.result')}
              </div>
              <pre
                className={cn(
                  'max-h-60 overflow-auto whitespace-pre-wrap rounded-md p-2 font-mono text-[11px]',
                  card.status === 'fail' ? 'bg-destructive/5 text-destructive' : 'bg-muted',
                )}
              >
                {card.resultText}
              </pre>
            </section>
          )}
          {isActionEvidence(
            (card.details as { actionEvidence?: unknown } | undefined)?.actionEvidence,
          ) && (
            <ActionEvidenceDetails
              evidence={
                (
                  card.details as {
                    actionEvidence: import('../../tools/action/types').ActionEvidence;
                  }
                ).actionEvidence
              }
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolCallGroup({
  cards,
  historical,
}: {
  cards: ToolCardData[];
  historical?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  if (cards.length === 0) return null;
  // Historical turns fold at ANY size (completed work reads as one line);
  // the current turn only groups runs of ≥3 (visibility while it happens).
  if (!historical && cards.length < 3) {
    return (
      <div className="space-y-1">
        {cards.map((c) => (
          <ToolCallCard key={c.itemId} card={c} />
        ))}
      </div>
    );
  }

  const okCount = cards.filter((c) => c.status === 'ok').length;
  const failCount = cards.filter((c) => c.status === 'fail').length;
  const running = cards.some((c) => c.status === 'running' || c.status === 'pending');
  const tail = cards[cards.length - 1]!;
  const totalMs = cards.reduce((sum, c) => sum + (c.durationMs ?? 0), 0);

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl border border-border/30 px-3 py-2 text-left text-[13px] text-muted-foreground transition-colors hover:bg-muted',
          historical ? 'bg-transparent' : 'bg-card',
        )}
        aria-expanded={expanded}
      >
        <ChevronRight
          className={cn('size-3 opacity-60 transition-transform', expanded && 'rotate-90')}
        />
        <span className="flex items-center gap-1.5">
          {t('stream.steps', { n: cards.length })}
          <span className="flex items-center gap-0.5 text-success">
            <Check className="size-3" />
            {okCount}
          </span>
          {failCount > 0 && (
            <span className="flex items-center gap-0.5 text-destructive">
              <X className="size-3" />
              {failCount}
            </span>
          )}
          {running && <Loader2 className="size-3 animate-spin text-info" />}
          {historical && totalMs > 0 && (
            <span className="text-[11px] text-faint-foreground">
              · {(totalMs / 1000).toFixed(1)}s
            </span>
          )}
        </span>
      </button>
      {expanded && cards.map((c) => <ToolCallCard key={c.itemId} card={c} />)}
      {!expanded && running && <ToolCallCard card={tail} />}
    </div>
  );
}
