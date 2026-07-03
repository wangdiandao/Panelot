/**
 * Prompt input (docs/09 §2/§4.4): running-state Enter=steer / Esc=stop,
 * Shift+Alt+Enter=explicit enqueue, context chips, send/stop toggle.
 * The @ / slash trigger menu lands with the ecosystem phase; the input
 * contract (send/steer/enqueue routing) is final here.
 */

import { useRef, useState } from 'react';
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
}: Props) {
  const [text, setText] = useState('');
  const [steerHint, setSteerHint] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      {steerHint && <div className="mb-1.5 px-1 text-[11px] text-agent">{steerHint}</div>}
      {queuedInputs > 0 && <div className="mb-1.5 px-1 text-[11px] text-text-dim">队列中 {queuedInputs} 条消息</div>}

      <div
        className={`flex flex-col rounded-[24px] border bg-surface-2 px-2 py-1.5 shadow-soft transition-colors ${
          disabled ? 'border-border opacity-70' : 'border-border focus-within:border-accent/60'
        }`}
      >
        {contextChips.length > 0 && (
          <div className="flex flex-wrap gap-1 px-2 pb-1.5 pt-1">
            {contextChips.map((chip, i) => (
              <span key={i} className="flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px]">
                📎 {chip.label}
                {chip.approxTokens !== undefined && <span className="text-text-faint">~{chip.approxTokens}tok</span>}
                <button type="button" onClick={() => onRemoveChip(i)} className="text-text-faint hover:text-danger" aria-label={`移除 ${chip.label}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            placeholder={disabled ? (disabledHint ?? '先在设置中添加模型 →') : running ? '输入以插话，Esc 停止…' : '给 Panelot 发消息…'}
            rows={Math.min(8, Math.max(1, text.split('\n').length))}
            className="max-h-48 min-h-[36px] flex-1 resize-none bg-transparent px-2.5 py-1.5 text-[14.5px] leading-[1.5] outline-none placeholder:text-text-faint disabled:cursor-not-allowed"
          />
          {running ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="停止"
              title="停止 (Esc)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-text text-bg transition-transform hover:scale-105"
            >
              <span className="block h-2.5 w-2.5 rounded-[2px] bg-bg" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit('send')}
              disabled={disabled || !text.trim()}
              aria-label="发送"
              title="发送 (Enter)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-black transition-all hover:brightness-110 disabled:bg-surface-3 disabled:text-text-faint"
            >
              ↑
            </button>
          )}
        </div>
      </div>
      <div className="mt-1.5 px-2 text-center text-[10.5px] text-text-faint">
        {running ? 'Enter 插话 · Shift+Alt+Enter 排队 · Esc 停止' : 'Enter 发送 · Shift+Enter 换行'}
      </div>
    </div>
  );
}
