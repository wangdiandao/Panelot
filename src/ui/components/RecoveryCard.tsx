import { CircleHelp, TriangleAlert } from 'lucide-react';
import type { RunRecoveryState } from '../../messaging/protocol';
import { t } from '../i18n';
import { Button } from './ui/button';

interface Props {
  run: RunRecoveryState;
  onResume: () => void;
  onResolve: (resolution: 'retry' | 'mark_done' | 'fail') => void;
}

export function RecoveryCard({ run, onResume, onResolve }: Props) {
  if (run.state === 'waiting_approval') return null;
  const uncertain = run.state === 'paused_uncertain';
  return (
    <section
      className="mx-4 mb-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-warning"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        {uncertain ? (
          <CircleHelp className="mt-0.5 size-4 shrink-0" />
        ) : (
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium">
            {uncertain
              ? t('recovery.uncertain')
              : run.state === 'paused_budget'
                ? t('recovery.budget')
                : t('recovery.interrupted')}
          </div>
          {run.pendingTool && (
            <div className="mt-1 break-words text-[11px] text-warning/80">
              {run.pendingTool.toolName}
              {run.pendingTool.target?.origin ? ` · ${run.pendingTool.target.origin}` : ''}
            </div>
          )}
          <div className="mt-2 flex flex-wrap justify-end gap-1.5">
            {uncertain ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => onResolve('fail')}
                >
                  {t('recovery.failed')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => onResolve('mark_done')}
                >
                  {t('recovery.completed')}
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => onResolve('retry')}
                >
                  {t('recovery.retry')}
                </Button>
              </>
            ) : (
              <Button size="sm" className="h-7 px-2 text-[11px]" onClick={onResume}>
                {t('recovery.continue')}
              </Button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
