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

import { useState } from 'react';
import { Check, ChevronRight, CircleAlert, Clock, X } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Spinner } from './ui/spinner';
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

export function ToolCallCard({ card }: { card: ToolCardData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="text-[13px]">
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto w-full justify-start px-0 py-1.5 text-left text-muted-foreground hover:bg-transparent hover:text-foreground"
        >
          {card.status === 'running' ? (
            <Spinner data-icon="inline-start" />
          ) : card.status === 'ok' ? (
            <Check data-icon="inline-start" className="text-success" />
          ) : card.status === 'fail' ? (
            <X data-icon="inline-start" className="text-destructive" />
          ) : (
            <Clock data-icon="inline-start" />
          )}
          <span className="sr-only">{t(`tool.status.${card.status}`)}</span>
          <span className="font-medium text-foreground">{card.label}</span>
          {card.toolName && card.toolName !== card.label && (
            <Badge variant="secondary" className="font-mono font-normal">
              {card.toolName}
            </Badge>
          )}
          {card.paramsSummary && (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {card.paramsSummary}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {card.status === 'running' && card.progressText && (
              <span className="max-w-40 truncate">{card.progressText}</span>
            )}
            {card.durationMs !== undefined && card.status === 'ok' && (
              <span>{(card.durationMs / 1000).toFixed(1)}s</span>
            )}
            <ChevronRight
              data-icon="inline-end"
              className={cn('opacity-50 transition-transform', expanded && 'rotate-90')}
            />
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 flex flex-col gap-3 border-l border-border-soft py-2 pl-4">
          {card.params !== undefined && (
            <section>
              <div className="mb-1 text-xs font-medium text-muted-foreground">
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
                  'mb-1 flex items-center gap-1 text-xs font-medium',
                  card.status === 'fail' ? 'text-destructive' : 'text-faint-foreground',
                )}
              >
                {card.status === 'fail' && <CircleAlert />}
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
      <div className="flex flex-col gap-1">
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
    <div className="flex flex-col gap-1">
      <Button
        variant="ghost"
        size="sm"
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="h-auto w-full justify-start px-0 py-1.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
        aria-expanded={expanded}
      >
        <ChevronRight
          data-icon="inline-start"
          className={cn('opacity-60 transition-transform', expanded && 'rotate-90')}
        />
        <span className="flex items-center gap-1.5">
          {t('stream.steps', { n: cards.length })}
          <span className="flex items-center gap-0.5 text-success">
            <Check data-icon="inline-start" />
            {okCount}
          </span>
          {failCount > 0 && (
            <span className="flex items-center gap-0.5 text-destructive">
              <X data-icon="inline-start" />
              {failCount}
            </span>
          )}
          {running && <Spinner className="text-info" />}
          {historical && totalMs > 0 && (
            <span className="text-[11px] text-faint-foreground">
              · {(totalMs / 1000).toFixed(1)}s
            </span>
          )}
        </span>
      </Button>
      {expanded && cards.map((c) => <ToolCallCard key={c.itemId} card={c} />)}
      {!expanded && running && <ToolCallCard card={tail} />}
    </div>
  );
}
