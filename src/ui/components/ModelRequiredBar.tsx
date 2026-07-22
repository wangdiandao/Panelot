import { Bot } from 'lucide-react';
import { t } from '../i18n';
import { Button } from './ui/button';

interface Props {
  onOpenSettings?: () => void;
}

export function ModelRequiredBar({ onOpenSettings }: Props) {
  return (
    <div
      role="status"
      className="mx-3 mb-3 flex min-w-0 items-center gap-3 rounded-3xl border bg-muted px-3 py-2 shadow-soft sm:mx-4 sm:mb-4"
    >
      <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('input.modelRequired')}</div>
        <div className="truncate text-xs text-muted-foreground">{t('input.modelRequiredHint')}</div>
      </div>
      <Button type="button" size="sm" className="shrink-0" onClick={onOpenSettings}>
        {t('input.addModel')}
      </Button>
    </div>
  );
}
