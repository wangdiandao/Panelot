/**
 * Approval card (docs/09 §4.3, docs/06 §4): full-parameter display, Y/A/N
 * keyboard shortcuts, flag banners, queued display "1/3".
 * Rendered ONLY inside extension pages — never injected into web pages.
 */

import { useEffect, useRef } from 'react';
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
      aria-label={`审批请求：${request.label}`}
      className="animate-[slide-in_200ms_ease-out] rounded-[10px] border border-warn/50 bg-surface shadow-lg outline-none focus:ring-1 focus:ring-warn"
    >
      {crossScope && (
        <div className="rounded-t-[10px] bg-warn/15 px-3 py-1 text-[11px] font-medium text-warn">
          ⚠ 越出任务作用域 — 该操作的目标不在本任务已触达的站点内
        </div>
      )}
      {sensitive && (
        <div className={`bg-danger/15 px-3 py-1 text-[11px] font-medium text-danger ${crossScope ? '' : 'rounded-t-[10px]'}`}>
          ⚠ 检测到敏感内容外发 — 参数中含疑似凭据/卡号/邮箱
        </div>
      )}
      {escalation && (
        <div className="bg-agent/15 px-3 py-1 text-[11px] font-medium text-agent">
          将升级为调试模式 — 页面顶部会出现「正在调试此浏览器」横幅
        </div>
      )}
      <div className="space-y-2 p-3">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-semibold text-warn">允许</span>
          <span className="font-medium">{request.label}</span>
          {request.targetOrigin && <span className="font-mono text-[11px] text-text-dim">{request.targetOrigin}</span>}
          {queuePosition && queuePosition.total > 1 && (
            <span className="ml-auto text-[11px] text-text-dim">
              {queuePosition.index}/{queuePosition.total}
            </span>
          )}
        </div>
        {request.preview?.snapshotLine && (
          <div className="rounded bg-surface-2 px-2 py-1 font-mono text-[11px] text-text-dim">
            {request.preview.snapshotLine}
          </div>
        )}
        {/* Full params — mandatory display (docs/06 §4). */}
        <pre className="max-h-48 overflow-auto rounded bg-surface-2 p-2 font-mono text-[11px]">
          {JSON.stringify(request.params, null, 2)}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => decide({ kind: 'accept' })}
            className="rounded-md bg-accent px-3 py-1 text-[12px] font-medium text-black hover:brightness-110"
          >
            允许一次 <kbd className="opacity-60">Y</kbd>
          </button>
          <button
            type="button"
            onClick={() => decide({ kind: 'acceptForSite' })}
            className="rounded-md border border-border bg-surface-2 px-3 py-1 text-[12px] hover:bg-border"
          >
            本站始终 <kbd className="opacity-60">A</kbd>
          </button>
          <button
            type="button"
            onClick={() => decide({ kind: 'decline' })}
            className="ml-auto rounded-md border border-danger/40 px-3 py-1 text-[12px] text-danger hover:bg-danger/10"
          >
            拒绝 <kbd className="opacity-60">N</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
