/**
 * Message stream (docs/09 §2): renders persisted snapshot items + live
 * streaming overlay. Virtualized with react-virtuoso (RL-2: 2000 nodes at
 * 60fps); followOutput replaces the hand-rolled auto-scroll while keeping
 * the same "stop following when the user scrolls up" contract.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { BranchSwitcher, useBranchShortcuts } from './BranchSwitcher';
import type { SnapshotItem } from '../../messaging/protocol';
import type {
  AssistantMessagePayload,
  SystemNoticePayload,
  ToolCallPayload,
  ToolResultPayload,
  UserMessagePayload,
} from '../../db/types';
import type { LiveItem } from '../engineClient';
import { Markdown } from './Markdown';
import { MessageActions } from './MessageActions';
import { CitationsPill } from './CitationsPill';
import { ReasoningBlock } from './ReasoningBlock';
import { ToolCallGroup, type ToolCardData } from './ToolCallCard';
import { Button } from './ui/button';
import { t } from '../i18n';

// ---------------------------------------------------------------------------
// Row model: fold tool_call + tool_result pairs into cards, group runs
// ---------------------------------------------------------------------------

type Row =
  | {
      kind: 'user';
      key: string;
      payload: UserMessagePayload;
      nodeId?: string;
      branch?: { index: number; count: number };
    }
  | {
      kind: 'assistant';
      key: string;
      payload: AssistantMessagePayload;
      streaming?: boolean;
      liveText?: string;
      liveReasoning?: string;
      nodeId?: string;
      branch?: { index: number; count: number };
      citations?: { url: string }[];
    }
  | { kind: 'tools'; key: string; cards: ToolCardData[]; historical?: boolean }
  | { kind: 'notice'; key: string; text: string };

/** URLs the agent visited this turn — from navigate/open_tab tool params. */
function citationUrl(toolName: string, params: unknown): string | null {
  if (toolName !== 'navigate' && toolName !== 'open_tab') return null;
  const url = (params as { url?: unknown })?.url;
  return typeof url === 'string' && /^https?:/.test(url) ? url : null;
}

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

  // Visited URLs accumulate per turn; the turn's closing assistant message
  // wears them as a citations pill (reset at each user message).
  let turnUrls: string[] = [];

  for (const item of items) {
    switch (item.kind) {
      case 'user_message':
        turnUrls = [];
        rows.push({
          kind: 'user',
          key: item.nodeId,
          payload: item.payload as UserMessagePayload,
          nodeId: item.nodeId,
          branch: item.branch,
        });
        break;
      case 'assistant_message': {
        const p = item.payload as AssistantMessagePayload;
        // Skip empty assistant shells (tool-call-only responses).
        if (p.content.some((c) => c.type === 'text' && c.text.trim() !== '')) {
          const citations = [...new Set(turnUrls)].map((url) => ({ url }));
          rows.push({
            kind: 'assistant',
            key: item.nodeId,
            payload: p,
            nodeId: item.nodeId,
            branch: item.branch,
            citations: citations.length > 0 ? citations : undefined,
          });
        }
        break;
      }
      case 'tool_call': {
        const p = item.payload as ToolCallPayload;
        const visited = citationUrl(p.toolName, p.params);
        if (visited) turnUrls.push(visited);
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
        rows.push({
          kind: 'notice',
          key: item.nodeId,
          text: (item.payload as SystemNoticePayload).text,
        });
        break;
      // tool_result folded above; approval_decision rendered via tool flow.
      default:
        break;
    }
  }

  // Historical-turn tool fold (LobeChat process-fold, docs/09 §4.2): tools
  // rows BEFORE the last user message belong to completed turns — collapse
  // them to a one-line summary. The latest turn's cards stay expanded
  // (safety-visibility posture); approval rows never participate.
  let lastUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  for (let i = 0; i < lastUserIdx; i++) {
    const row = rows[i]!;
    if (row.kind === 'tools') row.historical = true;
  }

  // Live overlay: user echo / streaming assistant text / running tools.
  // Completed live items stay visible until the next snapshot refresh
  // (applySnapshot clears liveItems atomically) — hiding them on completion
  // made the streamed text vanish for the rest of a multi-step turn.
  for (const live of liveItems) {
    if (live.kind === 'user_message') {
      if (live.text || live.attachedContext?.length) {
        rows.push({
          kind: 'user',
          key: live.itemId,
          payload: {
            content: [{ type: 'text', text: live.text }],
            attachedContext: live.attachedContext,
          },
        });
      }
    } else if (live.kind === 'assistant_message') {
      if (live.text || live.reasoning) {
        rows.push({
          kind: 'assistant',
          key: live.itemId,
          payload: { content: [], model: '', connectionId: '' },
          streaming: live.status === 'streaming',
          liveText: live.text,
          liveReasoning: live.reasoning,
        });
      }
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
  /** Branch-and-run: fork at the node with the given input text (turn.fork). */
  onForkAt?: (siblingOfNodeId: string, text: string) => void;
  /** A turn is running — regenerate/edit are disabled (fork rejects busy). */
  turnActive?: boolean;
  /**
   * Row content max-width (full page: 768). The scroll container itself
   * always spans the surface so the scrollbar sits at the far right edge
   * (OpenWebUI layout); only row CONTENT is centered and capped.
   */
  contentMaxWidth?: number;
}

export function MessageStream({
  items,
  liveItems,
  threadId,
  onSelectBranch,
  onForkAt,
  turnActive,
  contentMaxWidth,
}: Props) {
  const rows = useMemo(() => buildRows(items, liveItems), [items, liveItems]);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);

  // Ctrl/Cmd+↑↓ operates on the last branchable message (docs/09 §6).
  const lastBranchNodeId = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (
        (r.kind === 'user' || r.kind === 'assistant') &&
        r.branch &&
        r.branch.count > 1 &&
        r.nodeId
      )
        return r.nodeId;
    }
    return null;
  }, [rows]);
  useBranchShortcuts(threadId ?? null, lastBranchNodeId, onSelectBranch ?? (() => {}));

  // Regenerate re-runs the turn: fork at the PRECEDING USER node with its
  // original text (turns are atomic here — the engine always appends
  // turn_context + user_message, so assistant-level siblings don't exist;
  // the branch switcher appears on the user message, n/m switches the turn).
  const precedingUser = useMemo(() => {
    const map = new Map<string, { nodeId: string; text: string }>();
    let last: { nodeId: string; text: string } | null = null;
    for (const r of rows) {
      if (r.kind === 'user' && r.nodeId) last = { nodeId: r.nodeId, text: userText(r.payload) };
      else if (r.kind === 'assistant' && r.nodeId && last) map.set(r.nodeId, last);
    }
    return map;
  }, [rows]);

  // Last message-like row: its action bar stays permanently visible.
  const lastMessageKey = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      if (r.kind === 'user' || r.kind === 'assistant') return r.key;
    }
    return null;
  }, [rows]);

  const ctx: RowCtx = {
    threadId: threadId ?? null,
    onSelectBranch,
    onForkAt: turnActive ? undefined : onForkAt,
    precedingUser,
    lastMessageKey,
    editingNodeId,
    setEditingNodeId,
  };

  // Zero-row case is handled by ThreadView's <EmptyState> before this
  // component renders; an empty stream can still appear transiently mid-swap.
  if (rows.length === 0) {
    return <div className="relative flex-1 overflow-hidden" />;
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
        components={{
          Header: () => <div className="h-3" />,
          Footer: () => <div className="h-2" />,
        }}
        className="h-full"
        itemContent={(_, row) => (
          <div
            className="mx-auto w-full px-4 py-3"
            style={contentMaxWidth ? { maxWidth: contentMaxWidth } : undefined}
          >
            {renderRow(row, ctx)}
          </div>
        )}
      />
      {!atBottom && (
        <button
          type="button"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({
              index: rows.length - 1,
              align: 'end',
              behavior: 'smooth',
            })
          }
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-border-soft bg-card px-3 py-1 text-[11px] text-muted-foreground shadow-pop transition-colors hover:bg-muted"
        >
          {t('stream.backToBottom')}
        </button>
      )}
    </div>
  );
}

function userText(payload: UserMessagePayload): string {
  return payload.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
}

interface RowCtx {
  threadId: string | null;
  onSelectBranch?: (nodeId: string) => void;
  /** undefined while a turn is active (fork rejects busy threads). */
  onForkAt?: (siblingOfNodeId: string, text: string) => void;
  precedingUser: Map<string, { nodeId: string; text: string }>;
  lastMessageKey: string | null;
  editingNodeId: string | null;
  setEditingNodeId: (id: string | null) => void;
}

function renderRow(row: Row, ctx: RowCtx) {
  const { threadId, onSelectBranch, onForkAt } = ctx;
  const branchSwitcher = (r: Extract<Row, { kind: 'user' | 'assistant' }>) =>
    r.branch && r.branch.count > 1 && r.nodeId && threadId && onSelectBranch ? (
      <BranchSwitcher
        threadId={threadId}
        nodeId={r.nodeId}
        branch={r.branch}
        onSelectBranch={onSelectBranch}
      />
    ) : null;

  switch (row.kind) {
    case 'user': {
      const text = userText(row.payload);
      if (row.nodeId && ctx.editingNodeId === row.nodeId && onForkAt) {
        return (
          <EditInPlace
            initial={text}
            onCancel={() => ctx.setEditingNodeId(null)}
            onResend={(edited) => {
              ctx.setEditingNodeId(null);
              onForkAt(row.nodeId!, edited);
            }}
          />
        );
      }
      return (
        <div className="group/msg flex flex-col items-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-user-bubble px-4 py-2.5 text-[14.5px] leading-[1.65]">
            {row.payload.attachedContext && row.payload.attachedContext.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-1">
                {row.payload.attachedContext.map((block, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 rounded-full bg-foreground/10 px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    📎 {block.label}
                  </span>
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap">{text}</div>
          </div>
          <div className="flex items-center gap-1">
            {branchSwitcher(row)}
            <MessageActions
              role="user"
              text={text}
              align="end"
              isLast={row.key === ctx.lastMessageKey}
              onEdit={row.nodeId && onForkAt ? () => ctx.setEditingNodeId(row.nodeId!) : undefined}
            />
          </div>
        </div>
      );
    }
    case 'assistant': {
      // Live rows (streaming or completed-awaiting-snapshot) carry their text
      // in liveText; persisted rows in payload.content.
      // Codex-style flat turn: no per-message avatar — the user bubble on the
      // right already marks turn boundaries; repeating an agent icon beside
      // every reasoning/answer block is noise in multi-step turns.
      const text =
        row.liveText ?? row.payload.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      const reasoning = row.liveReasoning || row.payload.reasoning;
      // Reasoning precedes text in the stream: once answer text arrives the
      // thinking phase is OVER — collapse it even though the row still streams.
      const reasoningLive = Boolean(row.streaming) && !text;
      return (
        <div className="group/msg min-w-0">
          {reasoning && <ReasoningBlock text={reasoning} streaming={reasoningLive} />}
          <Markdown content={text} streaming={row.streaming} />
          {row.streaming && !text && (
            <span className="inline-block h-4 w-[3px] animate-[blink_1s_ease-in-out_infinite] rounded-full bg-primary align-middle" />
          )}
          {!row.streaming && row.citations && <CitationsPill citations={row.citations} />}
          {!row.streaming && (
            <div className="flex items-center gap-1">
              <MessageActions
                role="assistant"
                text={text}
                isLast={row.key === ctx.lastMessageKey}
                usage={row.payload.usage}
                model={row.payload.model || undefined}
                onRegenerate={
                  row.nodeId && onForkAt && ctx.precedingUser.get(row.nodeId)
                    ? () => {
                        const u = ctx.precedingUser.get(row.nodeId!)!;
                        onForkAt(u.nodeId, u.text);
                      }
                    : undefined
                }
              />
              {branchSwitcher(row)}
            </div>
          )}
        </div>
      );
    }
    case 'tools':
      // Full-width with the flat assistant turns (avatar indent is gone).
      return <ToolCallGroup cards={row.cards} historical={row.historical} />;
    case 'notice':
      return (
        <div className="flex justify-center">
          <div className="rounded-full border border-border-soft bg-card px-3 py-1 text-[11px] text-faint-foreground">
            {row.text}
          </div>
        </div>
      );
  }
}

/**
 * Edit-in-place (OpenWebUI UserMessage): the bubble swaps for a full-width
 * panel; Resend forks a sibling branch (history preserved, BranchSwitcher
 * appears). Esc cancels, Ctrl+Enter resends. IME-guarded for zh-CN.
 */
function EditInPlace({
  initial,
  onCancel,
  onResend,
}: {
  initial: string;
  onCancel: () => void;
  onResend: (text: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(value.length, value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const resend = () => {
    if (value.trim()) onResend(value.trim());
  };
  return (
    <div className="w-full rounded-2xl bg-muted px-4 py-3">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Escape') onCancel();
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            resend();
          }
        }}
        rows={Math.min(10, Math.max(2, value.split('\n').length))}
        className="w-full resize-none bg-transparent text-[14.5px] leading-[1.65] outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <span className="mr-auto text-[11px] text-faint-foreground">{t('actions.editHint')}</span>
        <Button variant="outline" size="sm" className="h-7 text-[12px]" onClick={onCancel}>
          {t('app.cancel')}
        </Button>
        <Button size="sm" className="h-7 text-[12px]" disabled={!value.trim()} onClick={resend}>
          {t('actions.resend')}
        </Button>
      </div>
    </div>
  );
}
