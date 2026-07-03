/**
 * Tool call card + collapsible group (docs/09 §4.2).
 * pending(⏳) → running(progress text) → ok(✓ + duration) | fail(✗ + error).
 * ≥3 consecutive cards collapse into a group header "N 步浏览器操作 ✓m ✗k";
 * a running group auto-expands its tail card.
 */

import { useState, type ReactNode } from 'react';

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
  pending: <span className="text-text-dim">⏳</span>,
  running: <span className="animate-pulse text-agent">⏳</span>,
  ok: <span className="text-ok">✓</span>,
  fail: <span className="text-danger">✗</span>,
};

export function ToolCallCard({ card }: { card: ToolCardData }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-border-soft bg-surface text-[12.5px]">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-2"
        aria-expanded={expanded}
      >
        {STATUS_ICON[card.status]}
        <span className="font-medium text-text">{card.label}</span>
        {card.paramsSummary && (
          <span className="truncate font-mono text-[11px] text-text-faint">{card.paramsSummary}</span>
        )}
        <span className="ml-auto flex items-center gap-2 text-[11px] text-text-faint">
          {card.status === 'running' && card.progressText && <span>{card.progressText}</span>}
          {card.durationMs !== undefined && card.status === 'ok' && <span>{(card.durationMs / 1000).toFixed(1)}s</span>}
          <span className="opacity-50">{expanded ? '▾' : '▸'}</span>
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-border-soft px-3 py-2">
          {card.params !== undefined && (
            <pre className="max-h-40 overflow-auto rounded-lg bg-surface-2 p-2 font-mono text-[11px] text-text-dim">
              {JSON.stringify(card.params, null, 2)}
            </pre>
          )}
          {card.resultText && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-2 font-mono text-[11px]">
              {card.resultText}
            </pre>
          )}
        </div>
      )}
    </div>
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
        className="flex w-full items-center gap-2 rounded-xl border border-border-soft bg-surface px-3 py-2 text-left text-[12.5px] text-text-dim transition-colors hover:bg-surface-2"
        aria-expanded={expanded}
      >
        <span className="opacity-60">{expanded ? '▾' : '▸'}</span>
        <span>
          {cards.length} 步浏览器操作 <span className="text-ok">✓{okCount}</span>
          {failCount > 0 && <span className="text-danger"> ✗{failCount}</span>}
          {running && <span className="animate-pulse text-agent"> ⏳</span>}
        </span>
      </button>
      {expanded && cards.map((c) => <ToolCallCard key={c.itemId} card={c} />)}
      {!expanded && running && <ToolCallCard card={tail} />}
    </div>
  );
}
