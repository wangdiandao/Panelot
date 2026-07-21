/**
 * EmptyState — the zero-message conversation view (docs/09 §7, OB-3).
 *
 * OpenWebUI Placeholder semantics adapted for an agent product:
 *  - time-of-day greeting + one-line capability hint;
 *  - a SHORT static suggestion list (max 4, no scrollbar, no draft-filtering
 *    — owner decision 2026-07-05: suggestions are a calm menu, not a live
 *    search surface);
 *  - clicking a suggestion PREFILLS the composer, never auto-sends — Panelot
 *    actions have side effects on real pages (deliberate delta from OpenWebUI);
 *  - side panel variant swaps in page-type-aware suggestions (URL heuristics);
 *  - no shuffle / stagger animation (no-decorative-animation constraint).
 */

import { Sparkles } from 'lucide-react';
import { t } from '../i18n';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './ui/empty';

export interface Suggestion {
  title: string;
  hint?: string;
  /** Text placed into the composer on click. */
  text: string;
}

export function greetingKey(hour: number): string {
  if (hour >= 5 && hour < 12) return 'empty.morning';
  if (hour >= 12 && hour < 18) return 'empty.afternoon';
  return 'empty.evening';
}

/** Page-type heuristics for the side panel (cheap URL sniffing, OB-3). */
export function pageSuggestion(url: string | undefined): Suggestion {
  const u = (url ?? '').toLowerCase();
  if (/youtube\.com\/watch|bilibili\.com\/video/.test(u))
    return { title: t('empty.sugVideo'), text: t('empty.sugVideo') };
  if (/\.pdf(\?|#|$)/.test(u)) return { title: t('empty.sugPdf'), text: t('empty.sugPdf') };
  if (/github\.com\/[^/]+\/[^/]+/.test(u))
    return { title: t('empty.sugRepo'), text: t('empty.sugRepo') };
  return { title: t('empty.sugPage'), text: t('empty.sugPage') };
}

function builtinSuggestions(): Suggestion[] {
  return [
    {
      title: t('empty.sugSummarize'),
      hint: t('empty.sugSummarizeHint'),
      text: t('empty.sugSummarize'),
    },
    { title: t('empty.sugCompare'), hint: t('empty.sugCompareHint'), text: t('empty.sugCompare') },
    { title: t('empty.sugForm'), hint: t('empty.sugFormHint'), text: t('empty.sugForm') },
    { title: t('empty.sugExtract'), hint: t('empty.sugExtractHint'), text: t('empty.sugExtract') },
  ];
}

/** At most 4 suggestions — everything renders, nothing scrolls. */
const MAX_SUGGESTIONS = 4;

interface Props {
  variant: 'page' | 'panel';
  /** Prefill the composer (never sends). */
  onPick: (text: string) => void;
  /** Active tab URL (side panel variant). */
  pageUrl?: string;
}

export function EmptyState({ variant, onPick, pageUrl }: Props) {
  const suggestions = (
    variant === 'panel'
      ? [pageSuggestion(pageUrl), ...builtinSuggestions().slice(0, 2)]
      : builtinSuggestions()
  ).slice(0, MAX_SUGGESTIONS);

  return (
    <Empty className={cn('h-full min-w-0', variant === 'panel' ? 'px-3 py-5' : 'px-4 py-6')}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Sparkles />
        </EmptyMedia>
        <EmptyTitle>{t(greetingKey(new Date().getHours()))}</EmptyTitle>
        <EmptyDescription>{t('empty.hint')}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full max-w-md">
        {suggestions.map((s, i) => (
          <Button
            key={`${s.title}-${i}`}
            variant="ghost"
            onClick={() => onPick(s.text)}
            className="h-auto min-w-0 w-full flex-col items-start justify-start gap-0.5 rounded-xl px-3 py-2 text-left whitespace-normal"
          >
            <div className="max-w-full break-words text-[13px] font-medium [overflow-wrap:anywhere]">
              {s.title}
            </div>
            {s.hint && (
              <div className="max-w-full break-words text-[12px] text-faint-foreground [overflow-wrap:anywhere]">
                {s.hint}
              </div>
            )}
          </Button>
        ))}
      </EmptyContent>
    </Empty>
  );
}
