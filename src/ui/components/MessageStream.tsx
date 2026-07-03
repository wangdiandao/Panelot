/**
 * Message stream (docs/09 §2): renders persisted snapshot items + live
 * streaming overlay. Virtualized with react-virtuoso (RL-2: 2000 nodes at
 * 60fps); followOutput replaces the hand-rolled auto-scroll while keeping
 * the same "stop following when the user scrolls up" contract.
 */

import { useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { BranchSwitcher, useBranchShortcuts } from './BranchSwitcher';
import type { SnapshotItem } from '../../messaging/protocol';
import type {
  AssistantMessagePayload,
  BranchSummaryPayload,
  CompactionPayload,
  SystemNoticePayload,
  ToolCallPayload,
  ToolResultPayload,
  UserMessagePayload,
} from '../../db/types';
import type { LiveItem } from '../engineClient';
import { Markdown } from './Markdown';
import { ToolCallGroup, type ToolCardData } from './ToolCallCard';
import { t } from '../i18n';

// ---------------------------------------------------------------------------
// Row model: fold tool_call + tool_result pairs into cards, group runs
// ---------------------------------------------------------------------------

type Row =
  | { kind: 'user'; key: string; payload: UserMessagePayload; nodeId?: string; branch?: { index: number; count: number } }
  | { kind: 'assistant'; key: string; payload: AssistantMessagePayload; streaming?: boolean; liveText?: string; liveReasoning?: string; nodeId?: string; branch?: { index: number; count: number } }
  | { kind: 'tools'; key: string; cards: ToolCardData[] }
  | { kind: 'notice'; key: string; text: string }
  | { kind: 'compaction'; key: string; payload: CompactionPayload }
  | { kind: 'branch_summary'; key: string; payload: BranchSummaryPayload };

export function buildRows(items: SnapshotItem[], liveItems: LiveItem[]): Row[] {
  const rows: Row[] = [];
  const resultByItemId = new Map<string, ToolResultPayload>();
  for (const item of items) {
    if (item.kind === 'tool_result') {
      const p = item.payload as ToolResultPayload;
      resultByItemId.set(p.itemId, p);
    }
  }

  const pushCard = (card: ToolCardData) => {
    const last = rows[rows.length - 1];
    if (last?.kind === 'tools') last.cards.push(card);
    else rows.push({ kind: 'tools', key: card.itemId, cards: [card] });
  };

  for (const item of items) {
    switch (item.kind) {
      case 'user_message':
        rows.push({ kind: 'user', key: item.nodeId, payload: item.payload as UserMessagePayload, nodeId: item.nodeId, branch: item.branch });
        break;
      case 'assistant_message': {
        const p = item.payload as AssistantMessagePayload;
        // Skip empty assistant shells (tool-call-only responses).
        if (p.content.some((c) => c.type === 'text' && c.text.trim() !== '')) {
          rows.push({ kind: 'assistant', key: item.nodeId, payload: p, nodeId: item.nodeId, branch: item.branch });
        }
        break;
      }
      case 'tool_call': {
        const p = item.payload as ToolCallPayload;
        const result = resultByItemId.get(p.itemId);
        pushCard({
          itemId: p.itemId,
          toolName: p.toolName,
          label: p.toolName,
          status: result ? (result.ok ? 'ok' : 'fail') : 'pending',
          params: p.params,
          paramsSummary: summarizeParams(p.params),
          resultText: result
            ? result.contentForLlm.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n')
            : undefined,
          details: result?.details,
        });
        break;
      }
      case 'system_notice':
        rows.push({ kind: 'notice', key: item.nodeId, text: (item.payload as SystemNoticePayload).text });
        break;
      case 'compaction':
        rows.push({ kind: 'compaction', key: item.nodeId, payload: item.payload as CompactionPayload });
        break;
      case 'branch_summary':
        rows.push({ kind: 'branch_summary', key: item.nodeId, payload: item.payload as BranchSummaryPayload });
        break;
      // tool_result folded above; approval_decision rendered via tool flow.
      default:
        break;
    }
  }

  // Live overlay: streaming assistant text / running tools.
  for (const live of liveItems) {
    if (live.kind === 'assistant_message') {
      if (live.status === 'streaming' && (live.text || live.reasoning)) {
        rows.push({
          kind: 'assistant',
          key: live.itemId,
          payload: { content: [], model: '', connectionId: '' },
          streaming: true,
          liveText: live.text,
          liveReasoning: live.reasoning,
        });
      }
      // Completed live assistant items will appear in the next snapshot refresh.
    } else if (live.kind === 'tool_call' && live.status === 'streaming') {
      pushCard({
        itemId: live.itemId,
        toolName: live.meta.toolName ?? '',
        label: live.meta.label ?? live.meta.toolName ?? 'tool',
        status: 'running',
        progressText:
          typeof live.toolProgress === 'object' && live.toolProgress !== null
            ? String((live.toolProgress as { progressText?: string }).progressText ?? '')
            : undefined,
      });
    }
  }

  return rows;
}

function summarizeParams(params: unknown): string {
  if (params === null || params === undefined) return '';
  const s = typeof params === 'string' ? params : JSON.stringify(params);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// ---------------------------------------------------------------------------

interface Props {
  items: SnapshotItem[];
  liveItems: LiveItem[];
  threadId?: string | null;
  /** Branch switch handler (thread.selectBranch); absent in previews. */
  onSelectBranch?: (nodeId: string) => void;
}

export function MessageStream({ items, liveItems, threadId, onSelectBranch }: Props) {
  const rows = useMemo(() => buildRows(items, liveItems), [items, liveItems]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);

  // Ctrl/Cmd+↑↓ operates on the last branchable message (docs/09 §6).
  const lastBranchNodeId = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if ((r.kind === 'user' || r.kind === 'assistant') && r.branch && r.branch.count > 1 && r.nodeId) return r.nodeId;
    }
    return null;
  }, [rows]);
  useBranchShortcuts(threadId ?? null, lastBranchNodeId, onSelectBranch ?? (() => {}));

  if (rows.length === 0) {
    return (
      <div className="relative flex-1 overflow-hidden px-4 py-6">
        <EmptyState />
      </div>
    );
  }

  return (
    <div className="relative flex-1 overflow-hidden">
      <Virtuoso
        ref={virtuosoRef}
        data={rows}
        computeItemKey={(_, row) => row.key}
        // Follow the tail while streaming unless the user scrolled up
        // (docs/09 §4.1 rule 3) — virtuoso's followOutput models exactly this.
        followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
        atBottomStateChange={setAtBottom}
        atBottomThreshold={40}
        increaseViewportBy={{ top: 400, bottom: 400 }}
        className="h-full"
        itemContent={(_, row) => (
          <div className="px-4 py-3">{renderRow(row, threadId ?? null, onSelectBranch)}</div>
        )}
      />
      {!atBottom && (
        <button
          type="button"
          onClick={() => virtuosoRef.current?.scrollToIndex({ index: rows.length - 1, align: 'end', behavior: 'smooth' })}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-pop transition-colors hover:bg-muted"
        >
          {t('stream.backToBottom')}
        </button>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/15 text-[22px] text-primary">✦</div>
      <div className="text-[15px] font-medium">{t('empty.title')}</div>
      <div className="max-w-xs text-[12.5px] leading-relaxed text-faint-foreground">
        直接提问，或用 <span className="rounded bg-muted px-1 font-mono">@</span> 引用当前页面，
        让 Panelot 帮你在浏览器里动手。
      </div>
    </div>
  );
}

function renderRow(row: Row, threadId: string | null, onSelectBranch?: (nodeId: string) => void) {
  const branchSwitcher = (r: Extract<Row, { kind: 'user' | 'assistant' }>) =>
    r.branch && r.branch.count > 1 && r.nodeId && threadId && onSelectBranch ? (
      <BranchSwitcher threadId={threadId} nodeId={r.nodeId} branch={r.branch} onSelectBranch={onSelectBranch} />
    ) : null;

  switch (row.kind) {
    case 'user': {
      const text = row.payload.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
      return (
        <div className="flex flex-col items-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-user-bubble px-4 py-2.5 text-[14.5px] leading-[1.65]">
            {row.payload.attachedContext && row.payload.attachedContext.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {row.payload.attachedContext.map((ctx, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full bg-black/20 px-2 py-0.5 text-[11px] text-muted-foreground">
                    📎 {ctx.label}
                  </span>
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap">{text}</div>
          </div>
          {branchSwitcher(row)}
        </div>
      );
    }
    case 'assistant': {
      const text = row.streaming
        ? (row.liveText ?? '')
        : row.payload.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      const reasoning = row.streaming ? row.liveReasoning : row.payload.reasoning;
      return (
        <div className="flex gap-3">
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-[13px] text-primary">✦</div>
          <div className="min-w-0 flex-1 pt-0.5">
            {reasoning && <ReasoningBlock text={reasoning} streaming={row.streaming} />}
            <Markdown content={text} streaming={row.streaming} />
            {row.streaming && !text && <span className="inline-block h-4 w-[3px] animate-[blink_1s_ease-in-out_infinite] rounded-full bg-primary align-middle" />}
            {branchSwitcher(row)}
          </div>
        </div>
      );
    }
    case 'tools':
      return (
        <div className="pl-10">
          <ToolCallGroup cards={row.cards} />
        </div>
      );
    case 'notice':
      return (
        <div className="flex justify-center">
          <div className="rounded-full border border-border-soft bg-card px-3 py-1 text-[11px] text-faint-foreground">{row.text}</div>
        </div>
      );
    case 'compaction':
      return (
        <div className="flex justify-center">
          <div className="rounded-full border border-dashed border-border px-3 py-1 text-[11px] text-faint-foreground">
            ⧉ {t('stream.compacted', { before: row.payload.tokensBefore, after: row.payload.tokensAfter })}
          </div>
        </div>
      );
    case 'branch_summary':
      return (
        <div className="rounded-xl border border-dashed border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
          <div className="mb-1 font-medium">{t('stream.branchSummary')}</div>
          {row.payload.summary}
        </div>
      );
  }
}

function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-[11px] text-muted-foreground hover:text-foreground"
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} {streaming ? t('stream.reasoningLive') : t('stream.reasoning')}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap rounded-md border-l-2 border-info/40 bg-card px-3 py-2 text-[12px] text-muted-foreground">
          {text}
        </div>
      )}
    </div>
  );
}
