/**
 * Approval card (docs/09 §4.3, docs/06 §4): full-parameter display, Y/S/A/N
 * keyboard shortcuts, flag banners, queued display "1/3".
 * Rendered only inside extension pages, never injected into web pages.
 */

import { useEffect, useId, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ApprovalDecision, PendingApproval } from '../../messaging/protocol';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';

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
      className="min-w-0 animate-[slide-in_200ms_ease-out] gap-0 overflow-hidden border-warning/50 py-0 shadow-pop outline-none focus:ring-1 focus:ring-warning"
    >
      {crossScope && (
        <div
          id={`${id}-cross-scope`}
          className="flex items-center gap-1.5 bg-warning/15 px-3 py-1 text-[11px] font-medium text-warning [&_svg]:size-3"
        >
          <TriangleAlert aria-hidden /> {t('approval.crossScope')}
        </div>
      )}
      {sensitive && (
        <div
          id={`${id}-sensitive`}
          className="flex items-center gap-1.5 bg-destructive/15 px-3 py-1 text-[11px] font-medium text-destructive [&_svg]:size-3"
        >
          <TriangleAlert aria-hidden /> {t('approval.sensitive')}
        </div>
      )}
      {escalation && (
        <div
          id={`${id}-escalation`}
          className="bg-info/15 px-3 py-1 text-[11px] font-medium text-info"
        >
          {t('approval.escalation')}
        </div>
      )}
      <CardHeader className="min-w-0 gap-1 px-3 pt-3">
        <CardTitle
          id={titleId}
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]"
        >
          <span className="font-semibold text-warning">{t('approval.allow')}</span>
          <span className="min-w-0 break-words font-medium">{request.label}</span>
          {queuePosition && queuePosition.total > 1 && (
            <span className="ml-auto text-[11px] text-muted-foreground">
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
      <CardContent className="flex min-w-0 flex-col gap-2 px-3 py-2">
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
      <CardFooter className="grid grid-cols-2 gap-2 px-3 pb-3 sm:grid-cols-4">
        <Button
          type="button"
          size="sm"
          className="h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5"
          onClick={() => decide({ kind: 'accept' })}
        >
          {t('approval.allowOnce')} <kbd className="opacity-60">Y</kbd>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5"
          onClick={() => decide({ kind: 'acceptForSession' })}
        >
          {t('approval.allowSession')} <kbd className="opacity-60">S</kbd>
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5"
          onClick={() => decide({ kind: 'acceptForSite' })}
        >
          {t('approval.allowSite')} <kbd className="opacity-60">A</kbd>
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="h-auto min-h-8 min-w-0 whitespace-normal px-2 py-1.5"
          onClick={() => decide({ kind: 'decline' })}
        >
          {t('approval.decline')} <kbd className="opacity-60">N</kbd>
        </Button>
      </CardFooter>
    </Card>
  );
}
