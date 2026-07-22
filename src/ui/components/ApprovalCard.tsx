/**
 * Compact approval action bar. It replaces the composer while a decision is
 * pending, keeps request details available on demand, and preserves Y/S/A/N
 * keyboard shortcuts.
 */

import { useEffect, useId, useRef } from 'react';
import { ChevronDown, ListTree, TriangleAlert } from 'lucide-react';
import type { ApprovalDecision, PendingApproval } from '../../messaging/protocol';
import { t } from '../i18n';
import { Button } from './ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { Kbd } from './ui/kbd';

interface Props {
  approval: PendingApproval;
  queuePosition?: { index: number; total: number };
  onDecision: (approvalId: string, decision: ApprovalDecision) => void;
}

const REVIEW_TARGET_KEYS = ['element', 'text', 'url', 'query', 'path', 'name', 'label', 'command'];

function approvalTargetLabel(params: unknown): string | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const record = params as Record<string, unknown>;
  for (const key of REVIEW_TARGET_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
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

  const risks = [
    request.flags.includes('cross_scope') ? t('approval.crossScope') : null,
    request.flags.includes('sensitive_payload') ? t('approval.sensitive') : null,
    request.flags.includes('escalation_l2') ? t('approval.escalation') : null,
  ].filter((value): value is string => value !== null);
  const titleId = `${id}-title`;
  const riskId = `${id}-risks`;
  const detailsId = `${id}-details`;
  const primaryLabel = request.preview?.snapshotLine ?? approvalTargetLabel(request.params);
  const targetSummary = [primaryLabel ? request.label : null, request.targetOrigin]
    .filter((value): value is string => Boolean(value))
    .join(' · ');

  return (
    <Card
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={risks.length > 0 ? riskId : undefined}
      data-approval-focus-target="true"
      className="mx-3 mb-3 min-w-0 gap-2 overflow-hidden py-2 shadow-soft sm:mx-4 sm:mb-4"
    >
      <CardHeader className="min-w-0 gap-1 px-3">
        <CardTitle id={titleId} className="flex min-w-0 items-center gap-2 text-sm">
          <span className="shrink-0 text-muted-foreground">{t('approval.allow')}</span>
          <span className="min-w-0 flex-1 truncate">{primaryLabel ?? request.label}</span>
          {queuePosition && queuePosition.total > 1 && (
            <span className="shrink-0 text-xs font-normal text-muted-foreground">
              {queuePosition.index}/{queuePosition.total}
            </span>
          )}
        </CardTitle>
        {targetSummary && (
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {targetSummary}
          </div>
        )}
      </CardHeader>

      <CardContent className="min-w-0 px-3">
        {risks.length > 0 && (
          <div id={riskId} className="flex min-w-0 items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-2">{risks.join(' · ')}</span>
          </div>
        )}
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="xs" className="group mt-1 -ml-2">
              <ListTree data-icon="inline-start" />
              {t('approval.details')}
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent
            id={detailsId}
            className="mt-1 space-y-1.5 data-[state=closed]:hidden"
          >
            <div className="text-[11px] font-medium text-muted-foreground">{t('tool.params')}</div>
            <pre className="max-h-32 w-full max-w-full overflow-auto rounded-md bg-muted p-2 font-mono text-[11px]">
              {JSON.stringify(request.params, null, 2)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>

      <CardFooter className="flex flex-wrap justify-end gap-1 px-3">
        <Button
          type="button"
          variant="destructive"
          size="xs"
          onClick={() => decide({ kind: 'decline' })}
        >
          {t('approval.decline')} <Kbd>N</Kbd>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="secondary" size="xs">
              {t('approval.moreAccess')} <ChevronDown data-icon="inline-end" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuItem onSelect={() => decide({ kind: 'acceptForSession' })}>
              {t('approval.allowSession')} <Kbd className="ml-auto">S</Kbd>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => decide({ kind: 'acceptForSite' })}>
              {t('approval.allowSite')} <Kbd className="ml-auto">A</Kbd>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button type="button" size="xs" onClick={() => decide({ kind: 'accept' })}>
          {t('approval.allowOnce')} <Kbd>Y</Kbd>
        </Button>
      </CardFooter>
    </Card>
  );
}
