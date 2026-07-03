/**
 * Prompt input (docs/09 §2/§4.4): running-state Enter=steer / Esc=stop,
 * Shift+Alt+Enter=explicit enqueue, context chips, send/stop toggle,
 * @ / slash / {{variable}} TriggerMenu, model selector.
 *
 * Keyboard arbitration (docs/09 §5): when the TriggerMenu is open it consumes
 * ArrowUp/ArrowDown/Enter/Tab/Esc FIRST; only unconsumed keys reach the
 * send/steer/enqueue/stop state machine below, which is otherwise unchanged
 * (the crown-jewel contract).
 */

import { useRef, useState, type RefObject } from 'react';
import { ArrowUp, Paperclip, Square, X } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import type { ContextBlock } from '../../messaging/protocol';
import { TriggerMenu, detectTrigger, type TriggerMenuHandle, type TriggerState } from './TriggerMenu';
import { useTriggerItems, evaluateVariables, type BuiltinCommand, type SkillCommand } from './composerTriggers';
import { SkillVariableForm } from './SkillVariableForm';
import { ModelSelector, type ModelChoice } from './ModelSelector';

interface Props {
  running: boolean;
  steerable: boolean;
  queuedInputs: number;
  disabled?: boolean;
  disabledHint?: string;
  contextChips: ContextBlock[];
  onRemoveChip: (index: number) => void;
  onAttachContext?: (block: ContextBlock) => void;
  onSend: (text: string) => void;
  onEnqueue: (text: string) => void;
  onStop: () => void;
  /** Optional external ref so parents can restore focus (e.g. post-approval). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Model override control (null = follow preset). */
  modelOverride?: { connectionId: string; modelId: string } | null;
  onSelectModel?: (choice: ModelChoice | null) => void;
  /** Extra slash commands supplied by the host page (e.g. /clear). */
  builtinCommands?: BuiltinCommand[];
}

export function PromptInput({
  running,
  steerable,
  queuedInputs,
  disabled,
  disabledHint,
  contextChips,
  onRemoveChip,
  onAttachContext,
  onSend,
  onEnqueue,
  onStop,
  textareaRef,
  modelOverride,
  onSelectModel,
  builtinCommands = [],
}: Props) {
  const [text, setText] = useState('');
  const [steerHint, setSteerHint] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [variableForm, setVariableForm] = useState<SkillCommand | null>(null);
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const taRef = textareaRef ?? innerRef;
  const menuRef = useRef<TriggerMenuHandle>(null);

  const refreshTrigger = (value: string, caret: number) => {
    setTrigger(detectTrigger(value, caret));
  };

  /** Replace the active trigger token (e.g. "@que") with `replacement`. */
  const replaceTrigger = (replacement: string) => {
    if (!trigger) return;
    const caret = taRef.current?.selectionStart ?? text.length;
    const next = text.slice(0, trigger.start) + replacement + text.slice(caret);
    setText(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (el) {
        const pos = trigger.start + replacement.length;
        el.focus();
        el.setSelectionRange(pos, pos);
      }
    });
  };

  const items = useTriggerItems(trigger, {
    attachContext: (block) => onAttachContext?.(block),
    replaceTrigger,
    openVariableForm: setVariableForm,
    builtinCommands,
  });

  const submit = (explicit: 'send' | 'enqueue') => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setText('');
    setTrigger(null);
    void evaluateVariables(trimmed).then((resolved) => {
      if (explicit === 'enqueue') {
        onEnqueue(resolved);
      } else {
        onSend(resolved);
        if (running) {
          setSteerHint(steerable ? '已插话，将在下次模型调用前生效' : '当前轮不可插话，已加入队列');
          setTimeout(() => setSteerHint(null), 3000);
        }
      }
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Menu-open arbitration: the menu consumes navigation keys first.
    if (menuRef.current?.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }
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
          'relative flex flex-col rounded-3xl border border-border bg-muted px-2 py-1.5 shadow-soft transition-colors',
          disabled ? 'opacity-70' : 'focus-within:border-primary/60',
        )}
      >
        <TriggerMenu
          ref={menuRef}
          open={trigger !== null && items.length > 0}
          items={items}
          query={trigger?.query ?? ''}
          onClose={() => setTrigger(null)}
        />
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
            onChange={(e) => {
              setText(e.target.value);
              refreshTrigger(e.target.value, e.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onClick={(e) => refreshTrigger(text, e.currentTarget.selectionStart)}
            onBlur={() => setTimeout(() => setTrigger(null), 150) /* let menu clicks land first */}
            disabled={disabled}
            placeholder={disabled ? (disabledHint ?? '先在设置中添加模型 →') : running ? '输入以插话，Esc 停止…' : '给 Panelot 发消息… (@ 引用 / 命令)'}
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
        {onSelectModel && (
          <div className="flex items-center px-1.5 pt-0.5">
            <ModelSelector value={modelOverride ?? null} onSelect={onSelectModel} />
          </div>
        )}
      </div>
      <div className="mt-1.5 px-2 text-center text-[10.5px] text-faint-foreground">
        {running ? 'Enter 插话 · Shift+Alt+Enter 排队 · Esc 停止' : 'Enter 发送 · Shift+Enter 换行'}
      </div>

      <SkillVariableForm
        command={variableForm}
        onClose={() => setVariableForm(null)}
        onSubmit={(composed) => onSend(composed)}
      />
    </div>
  );
}
