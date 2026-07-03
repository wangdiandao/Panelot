/**
 * Prompt input (docs/09 §2/§4.4): running-state Enter=steer / Esc=stop,
 * Shift+Alt+Enter=explicit enqueue, context chips, send/stop toggle.
 * The @ / slash trigger menu lands with the ecosystem phase; the input
 * contract (send/steer/enqueue routing) is final here.
 * Shell uses shadcn/ui Button + cn(); the keyboard state machine is the
 * crown-jewel contract and must not change.
 */

import { useRef, useState, type RefObject } from 'react';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import type { ContextBlock } from '../../messaging/protocol';

interface Props {
  running: boolean;
  steerable: boolean;
  queuedInputs: number;
  disabled?: boolean;
  disabledHint?: string;
  contextChips: ContextBlock[];
  onRemoveChip: (index: number) => void;
  onSend: (text: string) => void;
  onEnqueue: (text: string) => void;
  onStop: () => void;
  /** Optional external ref so parents can restore focus (e.g. post-approval). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

export function PromptInput({
  running,
  steerable,
  queuedInputs,
  disabled,
  disabledHint,
  contextChips,
  onRemoveChip,
  onSend,
  onEnqueue,
  onStop,
  textareaRef,
}: Props) {
  const [text, setText] = useState('');
  const [steerHint, setSteerHint] = useState<string | null>(null);
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const taRef = textareaRef ?? innerRef;

  const submit = (explicit: 'send' | 'enqueue') => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (explicit === 'enqueue') {
      onEnqueue(trimmed);
    } else {
      onSend(trimmed);
      if (running) {
        setSteerHint(steerable ? '已插话，将在下次模型调用前生效' : '当前轮不可插话，已加入队列');
        setTimeout(() => setSteerHint(null), 3000);
      }
    }
    setText('');
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && running) {
      e.preventDefault();
      onStop();
      return;
    }
    if (e.key !== 'Enter') return;
    if (e.shiftKey && e.altKey) {
      e.preventDefault();
      submit('enqueue');
      return;
    }
    if (!e.shiftKey) {
      e.preventDefault();
      submit('send');
    }
  };

  return (
    <div className="px-4 pb-4 pt-1">
      {steerHint && <div className="mb-1.5 px-1 text-[11px] text-info">{steerHint}</div>}
      {queuedInputs > 0 && <div className="mb-1.5 px-1 text-[11px] text-muted-foreground">队列中 {queuedInputs} 条消息</div>}

      <div
        className={cn(
          'flex flex-col rounded-3xl border border-border bg-muted px-2 py-1.5 shadow-soft transition-colors',
          disabled ? 'opacity-70' : 'focus-within:border-primary/60',
        )}
      >
        {contextChips.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2 pb-1.5 pt-1">
            {contextChips.map((chip, i) => (
              <span key={i} className="flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px]">
                <Paperclip className="size-3" /> {chip.label}
                {chip.approxTokens !== undefined && <span className="text-faint-foreground">~{chip.approxTokens}tok</span>}
                <button type="button" onClick={() => onRemoveChip(i)} className="text-faint-foreground hover:text-destructive" aria-label={`移除 ${chip.label}`}>
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            placeholder={disabled ? (disabledHint ?? '先在设置中添加模型 →') : running ? '输入以插话，Esc 停止…' : '给 Panelot 发消息…'}
            rows={Math.min(8, Math.max(1, text.split('\n').length))}
            className="max-h-48 min-h-[36px] flex-1 resize-none bg-transparent px-2.5 py-1.5 text-[14.5px] leading-[1.5] outline-none placeholder:text-faint-foreground disabled:cursor-not-allowed"
          />
          {running ? (
            <Button
              size="icon"
              aria-label="停止"
              title="停止 (Esc)"
              className="size-8 shrink-0 rounded-full bg-foreground text-background transition-transform hover:scale-105 hover:bg-foreground"
              onClick={onStop}
            >
              <Square className="size-2.5 fill-current" />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label="发送"
              title="发送 (Enter)"
              disabled={disabled || !text.trim()}
              className="size-8 shrink-0 rounded-full disabled:bg-accent disabled:text-faint-foreground disabled:opacity-100"
              onClick={() => submit('send')}
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
      </div>
      <div className="mt-1.5 px-2 text-center text-[10.5px] text-faint-foreground">
        {running ? 'Enter 插话 · Shift+Alt+Enter 排队 · Esc 停止' : 'Enter 发送 · Shift+Enter 换行'}
      </div>
    </div>
  );
}
