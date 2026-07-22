/**
 * Approval card (docs/development/ui.md §4.3, docs/development/permissions.md §4): full-parameter display, Y/S/A/N
 * keyboard shortcuts, flag banners, queued display "1/3".
 * Rendered only inside extension pages, never injected into web pages.
 */

import { useEffect, useId, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ApprovalDecision, PendingApproval } from '../../messaging/protocol';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Kbd } from './ui/kbd';
import { Alert, AlertDescription } from './ui/alert';

interface Props {
  approval: PendingApproval;
  queuePosition?: { index: number; total: number };
  onDecision: (approvalId: string, decision: ApprovalDecision) => void;
}

export function ApprovalCard({ approval, queuePosition, onDecision }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const { request } = approval;

  useEffect(() => {
    ref.current?.focus();
  }, [approval.approvalId]);

  const decide = (decision: ApprovalDecision) => onDecision(approval.approvalId, decision);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key.toLowerCase()) {
      case 'y':
        decide({ kind: 'accept' });
        break;
      case 's':
        decide({ kind: 'acceptForSession' });
        break;
      case 'a':
        decide({ kind: 'acceptForSite' });
        break;
      case 'n':
        decide({ kind: 'decline' });
        break;
      case 'escape':
        decide({ kind: 'cancel' });
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const crossScope = request.flags.includes('cross_scope');
  const sensitive = request.flags.includes('sensitive_payload');
  const escalation = request.flags.includes('escalation_l2');
  const titleId = `${id}-title`;
  const paramsLabelId = `${id}-params-label`;
  const paramsId = `${id}-params`;
  const riskIds = [
    crossScope ? `${id}-cross-scope` : null,
    sensitive ? `${id}-sensitive` : null,
    escalation ? `${id}-escalation` : null,
  ].filter((value): value is string => value !== null);

  return (
    <Card
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={[...riskIds, paramsLabelId, paramsId].join(' ')}
      data-approval-focus-target="true"
      className="min-w-0 overflow-hidden"
    >
      <CardHeader className="min-w-0">
        <CardTitle id={titleId} className="flex min-w-0 flex-wrap items-center gap-2">
          <span>{t('approval.allow')}</span>
          <span className="min-w-0 break-words">{request.label}</span>
          {queuePosition && queuePosition.total > 1 && (
            <span className="ml-auto text-muted-foreground">
              {queuePosition.index}/{queuePosition.total}
            </span>
          )}
        </CardTitle>
        {request.targetOrigin && (
          <CardDescription className="break-all font-mono text-[11px]">
            {request.targetOrigin}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {crossScope && (
          <Alert id={`${id}-cross-scope`} variant="warning">
            <TriangleAlert aria-hidden />
            <AlertDescription>{t('approval.crossScope')}</AlertDescription>
          </Alert>
        )}
        {sensitive && (
          <Alert id={`${id}-sensitive`} variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertDescription>{t('approval.sensitive')}</AlertDescription>
          </Alert>
        )}
        {escalation && (
          <Alert id={`${id}-escalation`} variant="info">
            <AlertDescription>{t('approval.escalation')}</AlertDescription>
          </Alert>
        )}
        {request.preview?.snapshotLine && (
          <div className="break-words rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {request.preview.snapshotLine}
          </div>
        )}
        <div id={paramsLabelId} className="text-[11px] font-medium text-muted-foreground">
          {t('tool.params')}
        </div>
        <pre
          id={paramsId}
          className="max-h-48 w-full max-w-full overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]"
        >
          {JSON.stringify(request.params, null, 2)}
        </pre>
      </CardContent>
      <CardFooter className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Button
          type="button"
          size="sm"
          className="min-w-0 whitespace-normal"
          onClick={() => decide({ kind: 'accept' })}
        >
          {t('approval.allowOnce')} <Kbd>Y</Kbd>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-w-0 whitespace-normal"
          onClick={() => decide({ kind: 'acceptForSession' })}
        >
          {t('approval.allowSession')} <Kbd>S</Kbd>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="min-w-0 whitespace-normal"
          onClick={() => decide({ kind: 'acceptForSite' })}
        >
          {t('approval.allowSite')} <Kbd>A</Kbd>
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="min-w-0 whitespace-normal"
          onClick={() => decide({ kind: 'decline' })}
        >
          {t('approval.decline')} <Kbd>N</Kbd>
        </Button>
      </CardFooter>
    </Card>
  );
}
