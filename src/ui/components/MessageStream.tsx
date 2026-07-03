/**
 * Message stream (docs/09 §2): renders persisted snapshot items + live
 * streaming overlay. Virtualization arrives with long-session polish; the
 * structure (item → row mapping, tool grouping) is final.
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
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

// ---------------------------------------------------------------------------
// Row model: fold tool_call + tool_result pairs into cards, group runs
// ---------------------------------------------------------------------------

type Row =
  | { kind: 'user'; key: string; payload: UserMessagePayload }
  | { kind: 'assistant'; key: string; payload: AssistantMessagePayload; streaming?: boolean; liveText?: string; liveReasoning?: string }
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
        rows.push({ kind: 'user', key: item.nodeId, payload: item.payload as UserMessagePayload });
        break;
      case 'assistant_message': {
        const p = item.payload as AssistantMessagePayload;
        // Skip empty assistant shells (tool-call-only responses).
        if (p.content.some((c) => c.type === 'text' && c.text.trim() !== '')) {
          rows.push({ kind: 'assistant', key: item.nodeId, payload: p });
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
}

export function MessageStream({ items, liveItems }: Props) {
  const rows = useMemo(() => buildRows(items, liveItems), [items, liveItems]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [followTail, setFollowTail] = useState(true);

  // Auto-scroll unless the user scrolled up (docs/09 §4.1 rule 3).
  useEffect(() => {
    if (followTail) containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [rows, followTail]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setFollowTail(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  return (
    <div className="relative flex-1 overflow-hidden">
      <div ref={containerRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-6">
        {rows.length === 0 && <EmptyState />}
        <div className="space-y-6">
          {rows.map((row) => (
            <Fragment key={row.key}>{renderRow(row)}</Fragment>
          ))}
        </div>
      </div>
      {!followTail && (
        <button
          type="button"
          onClick={() => {
            setFollowTail(true);
            containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight, behavior: 'smooth' });
          }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border bg-surface px-3 py-1 text-[11px] text-text-dim shadow-pop transition-colors hover:bg-surface-2"
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/15 text-[22px] text-accent">✦</div>
      <div className="text-[15px] font-medium">今天想做点什么？</div>
      <div className="max-w-xs text-[12.5px] leading-relaxed text-text-faint">
        直接提问，或用 <span className="rounded bg-surface-2 px-1 font-mono">@</span> 引用当前页面，
        让 Panelot 帮你在浏览器里动手。
      </div>
    </div>
  );
}

function renderRow(row: Row) {
  switch (row.kind) {
    case 'user': {
      const text = row.payload.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-user-bubble px-4 py-2.5 text-[14.5px] leading-[1.65]">
            {row.payload.attachedContext && row.payload.attachedContext.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {row.payload.attachedContext.map((ctx, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full bg-black/20 px-2 py-0.5 text-[11px] text-text-dim">
                    📎 {ctx.label}
                  </span>
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap">{text}</div>
          </div>
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
          <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-[13px] text-accent">✦</div>
          <div className="min-w-0 flex-1 pt-0.5">
            {reasoning && <ReasoningBlock text={reasoning} streaming={row.streaming} />}
            <Markdown content={text} streaming={row.streaming} />
            {row.streaming && !text && <span className="inline-block h-4 w-[3px] animate-[blink_1s_ease-in-out_infinite] rounded-full bg-accent align-middle" />}
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
          <div className="rounded-full border border-border-soft bg-surface px-3 py-1 text-[11px] text-text-faint">{row.text}</div>
        </div>
      );
    case 'compaction':
      return (
        <div className="flex justify-center">
          <div className="rounded-full border border-dashed border-border px-3 py-1 text-[11px] text-text-faint">
            ⧉ 上下文已压缩（{row.payload.tokensBefore} → {row.payload.tokensAfter} tokens）
          </div>
        </div>
      );
    case 'branch_summary':
      return (
        <div className="rounded-xl border border-dashed border-border bg-surface px-3 py-2 text-[12px] text-text-dim">
          <div className="mb-1 font-medium">已弃分支摘要</div>
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
        className="text-[11px] text-text-dim hover:text-text"
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} {streaming ? '思考中…' : '思考过程'}
      </button>
      {open && (
        <div className="mt-1 whitespace-pre-wrap rounded-md border-l-2 border-agent/40 bg-surface px-3 py-2 text-[12px] text-text-dim">
          {text}
        </div>
      )}
    </div>
  );
}
