/**
 * ReasoningBlock — the model's chain-of-thought (docs/09 §4.1).
 *
 * Follows the Vercel AI Elements / Claude.ai "Reasoning" pattern:
 *  - streaming: shimmer "Thinking…" label, auto-open peek window that follows
 *    the tail;
 *  - done: auto-collapse to one line with the thinking duration ("思考了 Ns",
 *    Claude's "Thought for Ns");
 *  - a manual toggle always wins over the auto behavior afterwards.
 * Built on shadcn Collapsible; duration is measured client-side from the
 * streaming window (the provider does not report reasoning time).
 */

import { useEffect, useRef, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { cn } from '../lib/utils';
import { t } from '../i18n';

export function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  // Auto state: open while streaming, closed when done — unless the user
  // toggled manually, which pins their choice for this block's lifetime.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? Boolean(streaming);

  // Client-side duration: first streaming render → last streaming render.
  const startRef = useRef<number | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  useEffect(() => {
    if (streaming) {
      startRef.current ??= Date.now();
    } else if (startRef.current !== null && durationMs === null) {
      setDurationMs(Date.now() - startRef.current);
    }
  }, [streaming, durationMs]);

  // Peek window follows the tail while thinking streams.
  const peekRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (streaming && open && peekRef.current) {
      peekRef.current.scrollTop = peekRef.current.scrollHeight;
    }
  }, [text, streaming, open]);

  const label = streaming
    ? t('stream.reasoningLive')
    : durationMs !== null && durationMs >= 1000
      ? t('stream.thoughtFor', { s: Math.round(durationMs / 1000) })
      : t('stream.reasoning');

  return (
    <Collapsible open={open} onOpenChange={(v) => setManualOpen(v)} className="mb-2">
      <CollapsibleTrigger
        className={cn(
          'group/reason inline-flex items-center gap-1.5 rounded-md py-0.5 pr-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground',
        )}
      >
        <Brain className={cn('size-3.5', streaming && 'text-info')} />
        <span className={cn(streaming && 'animate-shimmer bg-[linear-gradient(110deg,var(--color-muted-foreground)_35%,var(--color-foreground)_50%,var(--color-muted-foreground)_65%)] bg-[length:200%_100%] bg-clip-text text-transparent')}>
          {label}
        </span>
        <ChevronRight className="size-3 opacity-50 transition-transform group-data-[state=open]/reason:rotate-90" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          ref={peekRef}
          className={cn(
            'mt-1 overflow-y-auto whitespace-pre-wrap rounded-md border-l-2 border-info/40 bg-card px-3 py-2 text-[12px] leading-relaxed text-muted-foreground',
            streaming ? 'max-h-32' : 'max-h-72',
          )}
        >
          {text}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
