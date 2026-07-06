/**
 * QueueDock (Cherry Studio QueuedFollowupsDock, simplified): while a turn is
 * running, enqueued drafts are listed above the composer so queued messages
 * are never invisible state. Read-only in v1 — the protocol has no
 * queue.remove op, so rows can't be edited/removed remotely; texts are a
 * local echo (placeholders after a reconnect). Pauses honestly while an
 * approval card is pending (the engine's queue never crosses an approval).
 */

import { ListOrdered, PauseCircle } from 'lucide-react';
import { t } from '../i18n';

interface Props {
  /** Authoritative queue length (queue.updated). */
  count: number;
  /** Locally echoed texts, tail-aligned with the count. */
  texts: string[];
  /** An approval card is blocking — the queue won't drain past it. */
  paused: boolean;
}

export function QueueDock({ count, texts, paused }: Props) {
  if (count === 0) return null;
  const placeholders = Math.max(0, count - texts.length);
  return (
    <div className="mx-4 mb-1.5 rounded-xl border border-border/30 bg-card px-3 py-2">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <ListOrdered className="size-3" />
        {t('queue.title', { n: count })}
        {paused && (
          <span className="ml-auto flex items-center gap-1 text-warning">
            <PauseCircle className="size-3" /> {t('queue.paused')}
          </span>
        )}
      </div>
      <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
        {Array.from({ length: placeholders }, (_, i) => (
          <div key={`ph-${i}`} className="truncate text-[12px] italic text-faint-foreground">
            {t('queue.placeholder')}
          </div>
        ))}
        {texts.map((text, i) => (
          <div key={i} className="line-clamp-2 text-[12px] text-muted-foreground">
            {text}
          </div>
        ))}
      </div>
    </div>
  );
}
