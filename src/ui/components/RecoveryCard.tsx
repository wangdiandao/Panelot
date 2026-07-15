import { CircleHelp, TriangleAlert } from 'lucide-react';
import type { RunRecoveryState } from '../../messaging/protocol';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Alert, AlertAction, AlertDescription, AlertTitle } from './ui/alert';

interface Props {
  run: RunRecoveryState;
  onResume: () => void;
  onResolve: (resolution: 'retry' | 'mark_done' | 'fail') => void;
}

export function RecoveryCard({ run, onResume, onResolve }: Props) {
  if (run.state === 'waiting_approval') return null;
  const uncertain = run.state === 'paused_uncertain';
  return (
    <Alert variant="warning" className="mx-4 mb-2" aria-live="polite">
      {uncertain ? <CircleHelp /> : <TriangleAlert />}
      <AlertTitle>
        {uncertain
          ? t('recovery.uncertain')
          : run.state === 'paused_budget'
            ? t('recovery.budget')
            : t('recovery.interrupted')}
      </AlertTitle>
      <AlertDescription>
        {run.pendingTool && (
          <div className="break-words">
            {run.pendingTool.toolName}
            {run.pendingTool.target?.origin ? ` · ${run.pendingTool.target.origin}` : ''}
          </div>
        )}
      </AlertDescription>
      <AlertAction placement="footer">
        {uncertain ? (
          <>
            <Button variant="outline" size="xs" onClick={() => onResolve('fail')}>
              {t('recovery.failed')}
            </Button>
            <Button variant="outline" size="xs" onClick={() => onResolve('mark_done')}>
              {t('recovery.completed')}
            </Button>
            <Button size="xs" onClick={() => onResolve('retry')}>
              {t('recovery.retry')}
            </Button>
          </>
        ) : (
          <Button size="xs" onClick={onResume}>
            {t('recovery.continue')}
          </Button>
        )}
      </AlertAction>
    </Alert>
  );
}
