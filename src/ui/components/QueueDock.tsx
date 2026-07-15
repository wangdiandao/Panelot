import { Check, ListOrdered, PauseCircle, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { ThreadSnapshot } from '../../messaging/protocol';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface Props {
  runs: ThreadSnapshot['queuedRuns'];
  paused: boolean;
  onUpdate: (runId: string, text: string) => void;
  onRemove: (runId: string) => void;
}

export function QueueDock({ runs, paused, onUpdate, onRemove }: Props) {
  const [editing, setEditing] = useState<{ runId: string; text: string } | null>(null);
  if (runs.length === 0) return null;
  return (
    <section
      className="mx-4 mb-1.5 rounded-xl border border-border/30 bg-card px-3 py-2"
      aria-label={t('queue.title', { n: runs.length })}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        <ListOrdered className="size-3" />
        {t('queue.title', { n: runs.length })}
        {paused && (
          <span className="ml-auto flex items-center gap-1 text-warning">
            <PauseCircle className="size-3" /> {t('queue.paused')}
          </span>
        )}
      </div>
      <div className="mt-1 flex max-h-32 flex-col gap-1 overflow-y-auto">
        {runs.map((run) => {
          const isEditing = editing?.runId === run.runId;
          return (
            <div
              key={run.runId}
              className="group flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-muted/60"
            >
              {isEditing ? (
                <Input
                  autoFocus
                  value={editing.text}
                  onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setEditing(null);
                    if (event.key === 'Enter' && editing.text.trim()) {
                      onUpdate(run.runId, editing.text.trim());
                      setEditing(null);
                    }
                  }}
                  className="h-7 flex-1 text-[12px]"
                  aria-label={t('queue.edit')}
                />
              ) : (
                <span className="min-w-0 flex-1 line-clamp-2 text-[12px] text-muted-foreground">
                  {run.input.text || t('queue.placeholder')}
                </span>
              )}
              {isEditing ? (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('app.save')}
                    disabled={!editing.text.trim()}
                    onClick={() => {
                      onUpdate(run.runId, editing.text.trim());
                      setEditing(null);
                    }}
                  >
                    <Check />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('app.cancel')}
                    onClick={() => setEditing(null)}
                  >
                    <X />
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                    aria-label={t('queue.edit')}
                    onClick={() => setEditing({ runId: run.runId, text: run.input.text })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                    aria-label={t('queue.remove')}
                    onClick={() => onRemove(run.runId)}
                  >
                    <Trash2 />
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
