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
    <div className="border-t border-border bg-surface p-3">
      {contextChips.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {contextChips.map((chip, i) => (
            <span key={i} className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px]">
              📎 {chip.label}
              {chip.approxTokens !== undefined && <span className="text-text-dim">~{chip.approxTokens}tok</span>}
              <button type="button" onClick={() => onRemoveChip(i)} className="text-text-dim hover:text-danger" aria-label={`移除 ${chip.label}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {steerHint && <div className="mb-1 text-[11px] text-agent">{steerHint}</div>}
      {queuedInputs > 0 && (
        <div className="mb-1 text-[11px] text-text-dim">队列中 {queuedInputs} 条消息</div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
          placeholder={disabled ? (disabledHint ?? '先在设置中添加模型 →') : running ? '输入以插话，Esc 停止…' : '问点什么… (@ 引用 / 命令)'}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          className="min-h-[38px] flex-1 resize-none rounded-[12px] border border-border bg-surface-2 px-3 py-2 text-[14px] leading-[1.5] outline-none placeholder:text-text-dim focus:border-accent/60 disabled:opacity-50"
        />
        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="停止"
            className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] border border-danger/40 text-danger hover:bg-danger/10"
          >
            ⏹
          </button>
        ) : (
          <button
            type="button"
            onClick={() => submit('send')}
            disabled={disabled || !text.trim()}
            aria-label="发送"
            className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-accent text-black hover:brightness-110 disabled:opacity-40"
          >
            ➤
          </button>
        )}
      </div>
    </div>
  );
}
