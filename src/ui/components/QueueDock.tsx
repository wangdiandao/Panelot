import { Check, ListOrdered, PauseCircle, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { ThreadSnapshot } from '../../messaging/protocol';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { ScrollArea } from './ui/scroll-area';
import { Field } from './ui/field';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup } from './ui/item';

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
    <Card className="mx-4 mb-1.5 gap-2 py-2" aria-label={t('queue.title', { n: runs.length })}>
      <CardHeader className="px-3">
        <CardTitle className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ListOrdered />
          {t('queue.title', { n: runs.length })}
          {paused && (
            <span className="ml-auto flex items-center gap-1 text-warning">
              <PauseCircle className="size-3" /> {t('queue.paused')}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3">
        <ScrollArea className="max-h-32">
          <ItemGroup className="gap-1 pr-2">
            {runs.map((run) => {
              const isEditing = editing?.runId === run.runId;
              return (
                <Item key={run.runId} size="sm" variant="muted" className="group">
                  {isEditing ? (
                    <ItemContent>
                      <Field>
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
                          aria-label={t('queue.edit')}
                        />
                      </Field>
                    </ItemContent>
                  ) : (
                    <ItemContent>
                      <ItemDescription className="line-clamp-2">
                        {run.input.text || t('queue.placeholder')}
                      </ItemDescription>
                    </ItemContent>
                  )}
                  <ItemActions>
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
                          <Check data-icon="inline-start" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('app.cancel')}
                          onClick={() => setEditing(null)}
                        >
                          <X data-icon="inline-start" />
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
                          <Pencil data-icon="inline-start" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-70 sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100"
                          aria-label={t('queue.remove')}
                          onClick={() => onRemove(run.runId)}
                        >
                          <Trash2 data-icon="inline-start" />
                        </Button>
                      </>
                    )}
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
