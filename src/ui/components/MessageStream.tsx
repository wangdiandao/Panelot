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
import { ChevronRight, Paperclip } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Bubble, BubbleContent } from './ui/bubble';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Message, MessageContent, MessageFooter } from './ui/message';
import { Marker, MarkerContent, MarkerIcon } from './ui/marker';
import { Separator } from './ui/separator';
import { Spinner } from './ui/spinner';
import { Textarea } from './ui/textarea';
import { cn } from '../lib/utils';
import { t } from '../i18n';

// ---------------------------------------------------------------------------
// Row model: fold tool_call + tool_result pairs into cards, group runs
// ---------------------------------------------------------------------------

type AssistantMessageSegment = {
  kind: 'message';
  key: string;
  payload: AssistantMessagePayload;
  streaming?: boolean;
  liveText?: string;
  liveReasoning?: string;
  nodeId?: string;
  branch?: { index: number; count: number };
  citations?: { url: string }[];
};

type ToolSegment = {
  kind: 'tools';
  key: string;
  cards: ToolCardData[];
  historical?: boolean;
};

type AssistantSegment = AssistantMessageSegment | ToolSegment;

export type MessageStreamRow =
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
      segments: AssistantSegment[];
      historical?: boolean;
      startedAt?: number;
      endedAt?: number;
    }
  | { kind: 'notice'; key: string; text: string };

type Row = MessageStreamRow;

/** URLs the agent visited this turn — from navigate/open_tab tool params. */
function citationUrl(toolName: string, params: unknown): string | null {
  if (toolName !== 'navigate' && toolName !== 'open_tab') return null;
  const url = (params as { url?: unknown })?.url;
  return typeof url === 'string' && /^https?:/.test(url) ? url : null;
}

function assistantMessageHasContent(payload: AssistantMessagePayload): boolean {
  return (
    Boolean(payload.reasoning?.trim()) ||
    payload.content.some((content) => content.type === 'text' && content.text.trim() !== '')
  );
}

export function buildRows(items: SnapshotItem[], liveItems: LiveItem[]): Row[] {
  const rows: Row[] = [];
  const cardByItemId = new Map<string, ToolCardData>();
  const resultByItemId = new Map<string, { payload: ToolResultPayload; ts: number }>();
  for (const item of items) {
    if (item.kind === 'tool_result') {
      const p = item.payload as ToolResultPayload;
      resultByItemId.set(p.itemId, { payload: p, ts: item.ts });
    }
  }

  const ensureAssistantRow = (
    key: string,
    startedAt?: number,
    endedAt = startedAt,
  ): Extract<Row, { kind: 'assistant' }> => {
    const last = rows[rows.length - 1];
    if (last?.kind === 'assistant') {
      if (startedAt !== undefined)
        last.startedAt = Math.min(last.startedAt ?? startedAt, startedAt);
      if (endedAt !== undefined) last.endedAt = Math.max(last.endedAt ?? endedAt, endedAt);
      return last;
    }
    const row: Extract<Row, { kind: 'assistant' }> = {
      kind: 'assistant',
      key: `assistant:${key}`,
      segments: [],
      startedAt,
      endedAt,
    };
    rows.push(row);
    return row;
  };

  const pushMessage = (segment: AssistantMessageSegment, ts?: number) => {
    ensureAssistantRow(segment.key, ts).segments.push(segment);
  };

  const pushCard = (card: ToolCardData, startedAt?: number, endedAt = startedAt) => {
    const assistant = ensureAssistantRow(card.itemId, startedAt, endedAt);
    const last = assistant.segments[assistant.segments.length - 1];
    if (last?.kind === 'tools') last.cards.push(card);
    else assistant.segments.push({ kind: 'tools', key: card.itemId, cards: [card] });
    cardByItemId.set(card.itemId, card);
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
        if (assistantMessageHasContent(p)) {
          const citations = [...new Set(turnUrls)].map((url) => ({ url }));
          pushMessage(
            {
              kind: 'message',
              key: item.nodeId,
              payload: p,
              nodeId: item.nodeId,
              branch: item.branch,
              citations: citations.length > 0 ? citations : undefined,
            },
            item.ts,
          );
        }
        break;
      }
      case 'tool_call': {
        const p = item.payload as ToolCallPayload;
        const visited = citationUrl(p.toolName, p.params);
        if (visited) turnUrls.push(visited);
        const result = resultByItemId.get(p.itemId);
        pushCard(
          {
            itemId: p.itemId,
            toolName: p.toolName,
            label: p.toolName,
            status: result ? (result.payload.ok ? 'ok' : 'fail') : 'pending',
            params: p.params,
            paramsSummary: summarizeParams(p.params),
            resultText: result
              ? result.payload.contentForLlm
                  .map((c) => (c.type === 'text' ? c.text : '[image]'))
                  .join('\n')
              : undefined,
            details: result?.payload.details,
          },
          item.ts,
          result?.ts ?? item.ts,
        );
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

  // Tool activity inside completed turns folds to a summary. The latest turn
  // remains inspectable while it is active; approval rows never participate.
  let lastUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]!.kind === 'user') {
      lastUserIdx = i;
      break;
    }
  }
  for (let i = 0; i < lastUserIdx; i++) {
    const row = rows[i]!;
    if (row.kind === 'assistant') {
      row.historical = true;
      for (const segment of row.segments) {
        if (segment.kind === 'tools') segment.historical = true;
      }
    }
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
        pushMessage({
          kind: 'message',
          key: live.itemId,
          payload: { content: [], model: '', connectionId: '' },
          streaming: live.status === 'streaming',
          liveText: live.text,
          liveReasoning: live.reasoning,
        });
      }
    } else if (live.kind === 'tool_call') {
      const status = live.status === 'streaming' ? 'running' : live.status;
      const progressText =
        typeof live.toolProgress === 'object' && live.toolProgress !== null
          ? String((live.toolProgress as { progressText?: string }).progressText ?? '')
          : undefined;
      const persisted = cardByItemId.get(live.itemId);
      if (persisted) {
        persisted.status = status;
        persisted.live = true;
        persisted.label = live.meta.label ?? live.meta.toolName ?? persisted.label;
        persisted.toolName = live.meta.toolName ?? persisted.toolName;
        persisted.progressText = progressText;
        persisted.details = live.details ?? persisted.details;
        continue;
      }
      pushCard({
        itemId: live.itemId,
        toolName: live.meta.toolName ?? '',
        label: live.meta.label ?? live.meta.toolName ?? 'tool',
        status,
        live: true,
        progressText,
        details: live.details,
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
  onSelectBranch?: (expectedThreadId: string, nodeId: string) => void;
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
      if (r.kind === 'user' && r.branch && r.branch.count > 1 && r.nodeId) return r.nodeId;
      if (r.kind === 'assistant') {
        for (let j = r.segments.length - 1; j >= 0; j--) {
          const segment = r.segments[j]!;
          if (
            segment.kind === 'message' &&
            segment.branch &&
            segment.branch.count > 1 &&
            segment.nodeId
          ) {
            return segment.nodeId;
          }
        }
      }
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
      else if (r.kind === 'assistant' && last) {
        for (const segment of r.segments) {
          if (segment.kind === 'message' && segment.nodeId) map.set(segment.nodeId, last);
        }
      }
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
    turnActive: Boolean(turnActive),
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
            className={cn(
              'mx-auto w-full px-4',
              row.kind === 'user' && 'pb-2 pt-5',
              row.kind === 'assistant' && 'pb-5 pt-2',
              row.kind === 'notice' && 'py-2',
            )}
            style={contentMaxWidth ? { maxWidth: contentMaxWidth } : undefined}
          >
            {renderRow(row, ctx)}
          </div>
        )}
      />
      {!atBottom && (
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={() =>
            virtuosoRef.current?.scrollToIndex({
              index: rows.length - 1,
              align: 'end',
              behavior: 'smooth',
            })
          }
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full"
        >
          {t('stream.backToBottom')}
        </Button>
      )}
    </div>
  );
}

function userText(payload: UserMessagePayload): string {
  return payload.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n');
}

interface RowCtx {
  threadId: string | null;
  onSelectBranch?: (expectedThreadId: string, nodeId: string) => void;
  /** undefined while a turn is active (fork rejects busy threads). */
  onForkAt?: (siblingOfNodeId: string, text: string) => void;
  precedingUser: Map<string, { nodeId: string; text: string }>;
  lastMessageKey: string | null;
  editingNodeId: string | null;
  setEditingNodeId: (id: string | null) => void;
  turnActive: boolean;
}

function renderRow(row: Row, ctx: RowCtx) {
  const { threadId, onSelectBranch, onForkAt } = ctx;
  const branchSwitcher = (r: Extract<Row, { kind: 'user' }> | AssistantMessageSegment) =>
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
        <Message align="end" className="group/msg">
          <MessageContent className="max-w-[88%] gap-1.5">
            <Bubble variant="tinted" align="end" className="max-w-full">
              <BubbleContent className="rounded-br-sm px-4 py-2.5 text-[14.5px] leading-[1.65]">
                {row.payload.attachedContext && row.payload.attachedContext.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {row.payload.attachedContext.map((block, i) => (
                      <Badge key={i} variant="secondary" className="max-w-full">
                        <Paperclip />
                        <span className="truncate">{block.label}</span>
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
                  {text}
                </div>
              </BubbleContent>
            </Bubble>
            <MessageFooter className="gap-1 px-1">
              {branchSwitcher(row)}
              <MessageActions
                role="user"
                text={text}
                align="end"
                isLast={row.key === ctx.lastMessageKey}
                onEdit={
                  row.nodeId && onForkAt ? () => ctx.setEditingNodeId(row.nodeId!) : undefined
                }
              />
            </MessageFooter>
          </MessageContent>
        </Message>
      );
    }
    case 'assistant': {
      return <AssistantResponse row={row} ctx={ctx} branchSwitcher={branchSwitcher} />;
    }
    case 'notice':
      return (
        <div className="flex justify-center">
          <Badge variant="outline" className="max-w-full whitespace-normal text-center">
            {row.text}
          </Badge>
        </div>
      );
  }
}

function segmentText(segment: AssistantMessageSegment): string {
  return (
    segment.liveText ??
    segment.payload.content.map((content) => (content.type === 'text' ? content.text : '')).join('')
  );
}

function segmentReasoning(segment: AssistantMessageSegment): string {
  return segment.liveReasoning ?? segment.payload.reasoning ?? '';
}

function formatTurnDuration(startedAt?: number, endedAt?: number): string | null {
  if (startedAt === undefined || endedAt === undefined || endedAt - startedAt < 1000) return null;
  const totalSeconds = Math.round((endedAt - startedAt) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 ? `${hours}h` : '', minutes > 0 ? `${minutes}m` : '', `${seconds}s`]
    .filter(Boolean)
    .join(' ');
}

export function partitionAssistantSegments(
  row: Extract<MessageStreamRow, { kind: 'assistant' }>,
  running: boolean,
) {
  const displaySegments = row.segments.filter(
    (segment) =>
      segment.kind === 'tools' ||
      segmentText(segment).length > 0 ||
      segmentReasoning(segment).length > 0,
  );
  const messages = displaySegments.filter(
    (segment): segment is AssistantMessageSegment => segment.kind === 'message',
  );
  const resultMessage = running
    ? undefined
    : [...messages].reverse().find((message) => segmentText(message).trim().length > 0);
  const processSegments = displaySegments.filter(
    (segment) =>
      segment.kind === 'tools' ||
      segment !== resultMessage ||
      segmentReasoning(segment).trim().length > 0,
  );

  return { processSegments, resultMessage };
}

export function isAssistantRowRunning(
  row: Extract<MessageStreamRow, { kind: 'assistant' }>,
  turnActive: boolean,
  lastMessageKey: string | null,
): boolean {
  return (
    (turnActive && row.key === lastMessageKey) ||
    row.segments.some(
      (segment) =>
        (segment.kind === 'message' && segment.streaming) ||
        (segment.kind === 'tools' &&
          segment.cards.some(
            (card) => card.live || card.status === 'pending' || card.status === 'running',
          )),
    )
  );
}

function AssistantResponse({
  row,
  ctx,
  branchSwitcher,
}: {
  row: Extract<Row, { kind: 'assistant' }>;
  ctx: RowCtx;
  branchSwitcher: (segment: AssistantMessageSegment) => React.ReactNode;
}) {
  const messages = row.segments.filter(
    (segment): segment is AssistantMessageSegment => segment.kind === 'message',
  );
  const finalMessage = messages[messages.length - 1];
  const responseText = messages.map(segmentText).filter(Boolean).join('\n\n');
  const running = isAssistantRowRunning(row, ctx.turnActive, ctx.lastMessageKey);
  const citations = Array.from(
    new Map(
      messages
        .flatMap((message) => message.citations ?? [])
        .map((citation) => [citation.url, citation]),
    ).values(),
  );
  const regenerateFrom =
    finalMessage?.nodeId && ctx.onForkAt ? ctx.precedingUser.get(finalMessage.nodeId) : undefined;
  const { processSegments, resultMessage } = partitionAssistantSegments(row, running);
  const durationLabel = running ? null : formatTurnDuration(row.startedAt, row.endedAt);
  const [manualProcessOpen, setManualProcessOpen] = useState<boolean | null>(null);
  const processOpen = manualProcessOpen ?? running;

  return (
    <Message className="group/msg">
      <MessageContent className="gap-1.5">
        <Bubble variant="ghost" className="w-full max-w-full">
          <BubbleContent className="w-full px-0 py-0">
            <div className="flex min-w-0 flex-col">
              {processSegments.length > 0 && (
                <Collapsible open={processOpen} onOpenChange={setManualProcessOpen}>
                  <CollapsibleTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="group/process w-full justify-start"
                    >
                      {running && <Spinner data-icon="inline-start" />}
                      <span>{running ? t('stream.working') : t('stream.completed')}</span>
                      {durationLabel && <span className="text-xs opacity-70">{durationLabel}</span>}
                      <ChevronRight
                        data-icon="inline-end"
                        className="opacity-60 transition-transform group-data-[state=open]/process:rotate-90"
                      />
                    </Button>
                  </CollapsibleTrigger>
                  <Separator />
                  <CollapsibleContent>
                    <div className="flex min-w-0 flex-col gap-4 py-4">
                      {processSegments.map((segment) => (
                        <div key={segment.key} className="min-w-0">
                          {segment.kind === 'tools' ? (
                            <ToolCallGroup
                              cards={segment.cards}
                              historical={!running || segment.historical}
                            />
                          ) : (
                            <AssistantTimelineMessage
                              segment={segment}
                              showText={segment !== resultMessage}
                            />
                          )}
                        </div>
                      ))}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              )}
              {running && processSegments.length === 0 && (
                <Marker role="status" className="py-2">
                  <MarkerIcon>
                    <Spinner />
                  </MarkerIcon>
                  <MarkerContent>{t('stream.working')}</MarkerContent>
                </Marker>
              )}
              {resultMessage && (
                <div className={cn('min-w-0', processSegments.length > 0 && 'pt-4')}>
                  <AssistantMessageContent segment={resultMessage} />
                </div>
              )}
            </div>
          </BubbleContent>
        </Bubble>
        {!running && finalMessage && (
          <MessageFooter className="min-h-7 justify-between gap-2 px-0">
            <div className="min-w-0">
              {citations.length > 0 && <CitationsPill citations={citations} />}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <MessageActions
                role="assistant"
                text={responseText}
                isLast={row.key === ctx.lastMessageKey}
                usage={finalMessage.payload.usage}
                model={finalMessage.payload.model || undefined}
                onRegenerate={
                  regenerateFrom && ctx.onForkAt
                    ? () => ctx.onForkAt!(regenerateFrom.nodeId, regenerateFrom.text)
                    : undefined
                }
              />
              {branchSwitcher(finalMessage)}
            </div>
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

function AssistantTimelineMessage({
  segment,
  showText = true,
}: {
  segment: AssistantMessageSegment;
  showText?: boolean;
}) {
  const reasoning = segmentReasoning(segment);
  const text = segmentText(segment);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {reasoning && (
        <ReasoningBlock
          text={reasoning}
          streaming={Boolean(segment.streaming) && text.length === 0}
        />
      )}
      {showText && text && <AssistantMessageContent segment={segment} />}
    </div>
  );
}

function AssistantMessageContent({ segment }: { segment: AssistantMessageSegment }) {
  const text = segmentText(segment);

  return (
    <div className="min-w-0">
      {text && <Markdown content={text} streaming={segment.streaming} />}
      {segment.streaming && !text && (
        <Marker role="status">
          <MarkerIcon>
            <Spinner />
          </MarkerIcon>
          <MarkerContent>{t('stream.working')}</MarkerContent>
        </Marker>
      )}
    </div>
  );
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
    <Card className="w-full gap-0 overflow-hidden py-0 shadow-soft">
      <CardHeader className="sr-only">
        <CardTitle>{t('actions.edit')}</CardTitle>
        <CardDescription>{t('actions.editHint')}</CardDescription>
      </CardHeader>
      <CardContent className="px-3 py-3">
        <Textarea
          ref={ref}
          value={value}
          aria-label={t('actions.edit')}
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
          className="w-full resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
        />
      </CardContent>
      <CardFooter className="justify-end gap-2 border-t border-border-soft bg-muted/40 px-3 py-2">
        <span className="mr-auto text-[11px] text-faint-foreground">{t('actions.editHint')}</span>
        <Button variant="outline" size="sm" onClick={onCancel}>
          {t('app.cancel')}
        </Button>
        <Button size="sm" disabled={!value.trim()} onClick={resend}>
          {t('actions.resend')}
        </Button>
      </CardFooter>
    </Card>
  );
}
