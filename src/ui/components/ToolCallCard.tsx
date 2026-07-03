/**
 * Tool call card + collapsible group (docs/09 §4.2).
 * pending(⏳) → running(progress text) → ok(✓ + duration) | fail(✗ + error).
 * ≥3 consecutive cards collapse into a group header "N 步浏览器操作 ✓m ✗k";
 * a running group auto-expands its tail card. Built on shadcn/ui Collapsible
 * + lucide icons.
 */

import { useState, type ReactNode } from 'react';
import { Check, ChevronRight, Clock, Loader2, X } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui/collapsible';

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

export function ToolCallCard({ card }: { card: ToolCardData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="overflow-hidden rounded-xl border border-border-soft bg-card text-[12.5px]"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted">
        {STATUS_ICON[card.status]}
        <span className="font-medium text-foreground">{card.label}</span>
        {card.paramsSummary && (
          <span className="truncate font-mono text-[11px] text-faint-foreground">{card.paramsSummary}</span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-faint-foreground">
          {card.status === 'running' && card.progressText && <span>{card.progressText}</span>}
          {card.durationMs !== undefined && card.status === 'ok' && <span>{(card.durationMs / 1000).toFixed(1)}s</span>}
          <ChevronRight className={`size-3 opacity-50 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 border-t border-border-soft px-3 py-2">
          {card.params !== undefined && (
            <pre className="max-h-40 overflow-auto rounded-lg bg-muted p-2 font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(card.params, null, 2)}
            </pre>
          )}
          {card.resultText && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-2 font-mono text-[11px]">
              {card.resultText}
            </pre>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolCallGroup({ cards }: { cards: ToolCardData[] }) {
  const [expanded, setExpanded] = useState(false);
  if (cards.length === 0) return null;
  if (cards.length < 3) {
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

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 rounded-xl border border-border-soft bg-card px-3 py-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:bg-muted"
        aria-expanded={expanded}
      >
        <ChevronRight className={`size-3 opacity-60 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="flex items-center gap-1">
          {cards.length} 步浏览器操作
          <span className="flex items-center text-success"><Check className="size-3" />{okCount}</span>
          {failCount > 0 && <span className="flex items-center text-destructive"><X className="size-3" />{failCount}</span>}
          {running && <Loader2 className="size-3 animate-spin text-info" />}
        </span>
      </button>
      {expanded && cards.map((c) => <ToolCallCard key={c.itemId} card={c} />)}
      {!expanded && running && <ToolCallCard card={tail} />}
    </div>
  );
}
