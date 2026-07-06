/**
 * Approval card (docs/09 §4.3, docs/06 §4): full-parameter display, Y/S/A/N
 * keyboard shortcuts, flag banners, queued display "1/3".
 * Rendered ONLY inside extension pages — never injected into web pages.
 * Shell uses shadcn/ui Button; the Y/S/A/N/Esc handler and mandatory
 * full-param <pre> are the safety contract and must not change.
 */

import { useEffect, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from './ui/button';
import { t } from '../i18n';
import type { ApprovalDecision, PendingApproval } from '../../messaging/protocol';

interface Props {
  approval: PendingApproval;
  queuePosition?: { index: number; total: number };
  onDecision: (approvalId: string, decision: ApprovalDecision) => void;
}

export function ApprovalCard({ approval, queuePosition, onDecision }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { request } = approval;

  // Focus lands on the card so Y/A/N work immediately (docs/09 §4.3).
  useEffect(() => {
    ref.current?.focus();
  }, [approval.approvalId]);

  const decide = (decision: ApprovalDecision) => onDecision(approval.approvalId, decision);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
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
    e.preventDefault();
  };

  const crossScope = request.flags.includes('cross_scope');
  const sensitive = request.flags.includes('sensitive_payload');
  const escalation = request.flags.includes('escalation_l2');

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="alertdialog"
      aria-label={t('approval.request', { label: request.label })}
      className="animate-[slide-in_200ms_ease-out] overflow-hidden rounded-xl border border-warning/50 bg-card shadow-pop outline-none focus:ring-1 focus:ring-warning"
    >
      {crossScope && (
        <div className="flex items-center gap-1.5 bg-warning/15 px-3 py-1 text-[11px] font-medium text-warning">
          <TriangleAlert className="size-3" /> {t('approval.crossScope')}
        </div>
      )}
      {sensitive && (
        <div className="flex items-center gap-1.5 bg-destructive/15 px-3 py-1 text-[11px] font-medium text-destructive">
          <TriangleAlert className="size-3" /> {t('approval.sensitive')}
        </div>
      )}
      {escalation && (
        <div className="bg-info/15 px-3 py-1 text-[11px] font-medium text-info">
          {t('approval.escalation')}
        </div>
      )}
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-semibold text-warning">{t('approval.allow')}</span>
          <span className="font-medium">{request.label}</span>
          {request.targetOrigin && <span className="font-mono text-[11px] text-muted-foreground">{request.targetOrigin}</span>}
          {queuePosition && queuePosition.total > 1 && (
            <span className="ml-auto text-[11px] text-muted-foreground">
              {queuePosition.index}/{queuePosition.total}
            </span>
          )}
        </div>
        {request.preview?.snapshotLine && (
          <div className="rounded-md bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
            {request.preview.snapshotLine}
          </div>
        )}
        {/* Full params — mandatory display (docs/06 §4). */}
        <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">
          {JSON.stringify(request.params, null, 2)}
        </pre>
        <div className="flex gap-2">
          <Button size="sm" className="h-7 px-3 text-[12px]" onClick={() => decide({ kind: 'accept' })}>
            {t('approval.allowOnce')} <kbd className="opacity-60">Y</kbd>
          </Button>
          <Button variant="secondary" size="sm" className="h-7 px-3 text-[12px]" onClick={() => decide({ kind: 'acceptForSession' })}>
            {t('approval.allowSession')} <kbd className="opacity-60">S</kbd>
          </Button>
          <Button variant="secondary" size="sm" className="h-7 px-3 text-[12px]" onClick={() => decide({ kind: 'acceptForSite' })}>
            {t('approval.allowSite')} <kbd className="opacity-60">A</kbd>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto h-7 border-destructive/40 px-3 text-[12px] text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => decide({ kind: 'decline' })}
          >
            {t('approval.decline')} <kbd className="opacity-60">N</kbd>
          </Button>
        </div>
      </div>
    </div>
  );
}
