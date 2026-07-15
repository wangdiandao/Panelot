/**
 * Prompt input (docs/09 §2/§4.4): running-state Enter=steer / Esc=stop,
 * Shift+Alt+Enter=explicit enqueue, context chips, send/stop toggle,
 * @ / slash / {{variable}} TriggerMenu, model selector.
 *
 * Keyboard arbitration (docs/09 §5): when the TriggerMenu is open it consumes
 * ArrowUp/ArrowDown/Enter/Tab/Esc FIRST; only unconsumed keys reach the
 * send/steer/enqueue/stop state machine below, which is otherwise unchanged
 * (the crown-jewel contract). An IME double-guard (isComposing + keyCode 229,
 * OpenWebUI's lesson for CJK keyboards) sits above everything: a
 * composition-confirm Enter neither sends nor steers.
 *
 * Shell styling follows OpenWebUI's composer grammar: focus-within ring on
 * the whole card, dashed indigo border while the running turn is steerable
 * (mode signal via shape, not color alone), and a bottom toolbar of
 * [+ attach] | divider | pill strip … [send/stop circle].
 */

import { useRef, useState, type RefObject } from 'react';
import { ArrowUp, FileText, Paperclip, Plus, Sparkles, Square, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { InputGroup, InputGroupAddon, InputGroupTextarea } from './ui/input-group';
import { Separator } from './ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { cn } from '../lib/utils';
import { t } from '../i18n';
import type { ContextBlock, SubmissionBrowserContext } from '../../messaging/protocol';
import {
  attachTab as attachTabFromMenu,
  captureSubmissionBrowserContext,
  listAttachableTabs,
} from '../pageContext';
import {
  TriggerMenu,
  detectTrigger,
  type TriggerMenuHandle,
  type TriggerState,
} from './TriggerMenu';
import {
  useTriggerItems,
  evaluateVariables,
  listSkillCommands,
  type BuiltinCommand,
  type SkillCommand,
} from './composerTriggers';
import { SkillVariableForm } from './SkillVariableForm';
import { ModelSelector, type ModelChoice } from './ModelSelector';
import { PermissionSwitch, type PermissionTier } from './PermissionSwitch';
import type { PermissionPolicy } from '../../messaging/protocol';

interface Props {
  running: boolean;
  steerable: boolean;
  disabled?: boolean;
  disabledHint?: string;
  contextChips: ContextBlock[];
  /** Thread selected when the user starts a submission; null denotes a draft. */
  submissionThreadId: string | null;
  onRemoveChip: (index: number) => void;
  onAttachContext?: (block: ContextBlock) => void;
  onAttachFile?: (file: File) => Promise<ContextBlock | null>;
  attachmentUnavailableReason?: string;
  onSend: (
    text: string,
    expectedThreadId: string | null,
    browserContext: SubmissionBrowserContext,
  ) => boolean | Promise<boolean>;
  onEnqueue: (
    text: string,
    expectedThreadId: string | null,
    browserContext: SubmissionBrowserContext,
  ) => boolean | Promise<boolean>;
  onStop: () => void;
  /** Optional external ref so parents can restore focus (e.g. post-approval). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  /** Controlled draft (lifted for empty-state filtering + persistence). */
  draft?: string;
  onDraftChange?: (text: string) => void;
  /** Backspace pressed with an empty composer (side panel page-chip removal). */
  onBackspaceEmpty?: () => void;
  /** ArrowUp on an empty composer recalls the last user message (terminal idiom). */
  onRecallLast?: () => string | undefined;
  /** Model override control (null = follow preset); omit to hide (header hosts it). */
  modelOverride?: { connectionId: string; modelId: string } | null;
  onSelectModel?: (choice: ModelChoice | null) => void;
  /** Permission tier (undefined = global default). */
  permissionPolicy?: PermissionPolicy | undefined;
  onSelectPolicy?: (tier: PermissionTier) => void;
  /** Extra slash commands supplied by the host page (e.g. /clear). */
  builtinCommands?: BuiltinCommand[];
}

export function PromptInput({
  running,
  steerable,
  disabled,
  disabledHint,
  contextChips,
  submissionThreadId,
  onRemoveChip,
  onAttachContext,
  onAttachFile,
  attachmentUnavailableReason,
  onSend,
  onEnqueue,
  onStop,
  textareaRef,
  draft,
  onDraftChange,
  onBackspaceEmpty,
  onRecallLast,
  modelOverride,
  onSelectModel,
  permissionPolicy,
  onSelectPolicy,
  builtinCommands = [],
}: Props) {
  const [innerText, setInnerText] = useState('');
  const controlled = draft !== undefined;
  const text = controlled ? draft : innerText;
  const setText = (v: string) => {
    if (!controlled) setInnerText(v);
    onDraftChange?.(v);
  };
  const [steerHint, setSteerHint] = useState<string | null>(null);
  const [trigger, setTrigger] = useState<TriggerState | null>(null);
  const [variableForm, setVariableForm] = useState<SkillCommand | null>(null);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const taRef = textareaRef ?? innerRef;
  const menuRef = useRef<TriggerMenuHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const submissionTail = useRef<Promise<void>>(Promise.resolve());

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
    if (!trimmed && contextChips.length === 0) return;
    const browserContext = captureSubmissionBrowserContext([...contextChips]);
    setText('');
    setTrigger(null);
    const submission = {
      explicit,
      trimmed,
      expectedThreadId: submissionThreadId,
      onEnqueue,
      onSend,
      running,
      steerable,
    };
    const dispatch = async () => {
      try {
        const capturedBrowserContext = await browserContext;
        const resolved = await evaluateVariables(submission.trimmed, capturedBrowserContext);
        const accepted =
          submission.explicit === 'enqueue'
            ? await submission.onEnqueue(
                resolved,
                submission.expectedThreadId,
                capturedBrowserContext,
              )
            : await submission.onSend(
                resolved,
                submission.expectedThreadId,
                capturedBrowserContext,
              );
        if (!accepted) {
          setSteerHint(t('input.threadChangedBeforeSend'));
          setTimeout(() => setSteerHint(null), 3000);
          return;
        }
        if (submission.explicit === 'send') {
          if (submission.running) {
            setSteerHint(submission.steerable ? t('input.steered') : t('input.queuedInstead'));
            setTimeout(() => setSteerHint(null), 3000);
          }
        }
      } catch {
        setSteerHint(t('input.variableExpansionFailed'));
        setTimeout(() => setSteerHint(null), 3000);
      }
    };
    submissionTail.current = submissionTail.current.then(dispatch, dispatch);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME double-guard (OpenWebUI): while composing (or on the synthetic
    // keyCode-229 event some Chinese/Japanese keyboards emit on confirm),
    // no key may reach the state machine — Enter must not send OR steer.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Menu-open arbitration: the menu consumes navigation keys first.
    if (menuRef.current?.handleKeyDown(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Backspace' && text === '') {
      onBackspaceEmpty?.();
      return;
    }
    if (e.key === 'ArrowUp' && text === '' && onRecallLast) {
      const recalled = onRecallLast();
      if (recalled) {
        e.preventDefault();
        setText(recalled);
        requestAnimationFrame(() =>
          taRef.current?.setSelectionRange(recalled.length, recalled.length),
        );
      }
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

  // + menu: "引用页面" is a submenu listing open tabs; Skills is another submenu.
  const [menuSkills, setMenuSkills] = useState<SkillCommand[] | null>(null);
  const [menuTabs, setMenuTabs] = useState<{ id: number; title: string; url: string }[] | null>(
    null,
  );
  const loadMenu = () => {
    if (menuSkills === null) void listSkillCommands().then(setMenuSkills);
    if (menuTabs === null) void listAttachableTabs().then(setMenuTabs);
  };
  const attachTab = async (tabId: number, url: string) => {
    const block = await attachTabFromMenu(tabId, url);
    if (block) onAttachContext?.(block);
  };
  const pickSkill = (cmd: SkillCommand) => {
    if (cmd.variables && cmd.variables.length > 0) {
      setVariableForm(cmd);
      return;
    }
    // Insert the slash command into the draft; the user completes and sends.
    const next = text ? `${cmd.command} ${text}` : `${cmd.command} `;
    setText(next);
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(next.length, next.length);
    });
  };

  /** Huge pastes become a context chip instead of flooding the textarea
   *  (OpenWebUI paste-as-file, adapted); Shift+paste bypasses. */
  const PASTE_CHIP_THRESHOLD = 2000;
  const shiftDown = useRef(false);
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!onAttachContext || shiftDown.current) return;
    const pasted = e.clipboardData.getData('text/plain');
    if (pasted.length <= PASTE_CHIP_THRESHOLD) return;
    e.preventDefault();
    onAttachContext({
      kind: 'file',
      label: t('input.pastedText', { n: pasted.length }),
      content: [{ type: 'text', text: pasted }],
      approxTokens: Math.round(pasted.length / 4),
    });
  };

  const rows = text.split('\n').length;
  // LibreChat collapse-mask: long unfocused drafts shrink under a gradient
  // fade instead of eating the viewport; focus restores full height.
  const collapsed = !focused && rows > 3;

  return (
    <div className="px-4 pb-4 pt-1">
      {steerHint && <div className="mb-1.5 px-1 text-[11px] text-info">{steerHint}</div>}

      <InputGroup
        data-disabled={disabled || undefined}
        className={cn(
          'h-auto flex-col rounded-3xl bg-muted px-2 py-1.5 shadow-soft',
          disabled && 'opacity-70',
          // Steerable running turn: dashed indigo border — a shape-channel
          // mode signal (Enter now steers instead of sending).
          running && steerable
            ? 'border-dashed border-primary/60'
            : 'focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20',
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
              <Badge key={i} variant="secondary" className="max-w-full pr-0.5">
                <Paperclip />
                <span className="truncate">{chip.label}</span>
                {chip.approxTokens !== undefined && (
                  <span className="text-faint-foreground">~{chip.approxTokens}tok</span>
                )}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onRemoveChip(i)}
                  aria-label={t('input.remove', { label: chip.label })}
                >
                  <X />
                </Button>
              </Badge>
            ))}
          </div>
        )}
        <InputGroupTextarea
          ref={taRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            refreshTrigger(e.target.value, e.target.selectionStart);
          }}
          onKeyDown={(e) => {
            shiftDown.current = e.shiftKey;
            onKeyDown(e);
          }}
          onKeyUp={(e) => {
            shiftDown.current = e.shiftKey;
          }}
          onPaste={onPaste}
          onClick={(e) => refreshTrigger(text, e.currentTarget.selectionStart)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setTimeout(() => setTrigger(null), 150); /* let menu clicks land first */
          }}
          disabled={disabled}
          placeholder={
            disabled
              ? (disabledHint ?? t('input.noProvider'))
              : running
                ? t('input.running')
                : t('input.placeholder')
          }
          rows={collapsed ? 3 : Math.min(8, Math.max(1, rows))}
          style={
            collapsed
              ? { maskImage: 'linear-gradient(to bottom, black 55%, transparent 95%)' }
              : undefined
          }
          className="max-h-[45vh] min-h-9 py-2"
        />
        {/* Toolbar: [+ attach] | divider | pill strip … [primary circle] */}
        <InputGroupAddon align="block-end" className="gap-1 px-1 pb-0 pt-0.5">
          {onAttachContext && (
            <>
              <DropdownMenu
                open={attachMenuOpen}
                onOpenChange={(open) => {
                  setAttachMenuOpen(open);
                  if (open) loadMenu();
                }}
              >
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 rounded-full"
                    aria-label={t('input.attach')}
                    disabled={disabled}
                  >
                    <Plus />
                  </Button>
                </DropdownMenuTrigger>
                {attachMenuOpen && (
                  <DropdownMenuContent align="start" side="top" className="w-48">
                    <DropdownMenuGroup>
                      {onAttachFile && (
                        <DropdownMenuItem
                          onSelect={() => {
                            if (attachmentUnavailableReason) {
                              toast.info(attachmentUnavailableReason);
                              return;
                            }
                            fileRef.current?.click();
                          }}
                        >
                          <Upload data-icon="inline-start" /> {t('input.uploadFile')}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <FileText /> {t('input.attachPage')}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="max-h-64 w-64 overflow-y-auto">
                          <DropdownMenuGroup>
                            {menuTabs === null ? (
                              <DropdownMenuLabel className="text-[12px] font-normal text-faint-foreground">
                                {t('model.loading')}
                              </DropdownMenuLabel>
                            ) : menuTabs.length === 0 ? (
                              <DropdownMenuLabel className="text-[12px] font-normal text-faint-foreground">
                                {t('input.noTabs')}
                              </DropdownMenuLabel>
                            ) : (
                              menuTabs.map((tab) => (
                                <DropdownMenuItem
                                  key={tab.id}
                                  onSelect={() => {
                                    setAttachMenuOpen(false);
                                    void attachTab(tab.id, tab.url);
                                  }}
                                >
                                  <div className="flex min-w-0 flex-col">
                                    <span className="truncate text-[12px]">{tab.title}</span>
                                    <span className="truncate text-[11px] text-faint-foreground">
                                      {new URL(tab.url).hostname}
                                    </span>
                                  </div>
                                </DropdownMenuItem>
                              ))
                            )}
                          </DropdownMenuGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Sparkles /> {t('input.skills')}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="max-h-64 w-56 overflow-y-auto">
                          <DropdownMenuGroup>
                            {menuSkills === null ? (
                              <DropdownMenuLabel className="text-[12px] font-normal text-faint-foreground">
                                {t('model.loading')}
                              </DropdownMenuLabel>
                            ) : menuSkills.length === 0 ? (
                              <DropdownMenuLabel className="text-[12px] font-normal text-faint-foreground">
                                {t('input.noSkills')}
                              </DropdownMenuLabel>
                            ) : (
                              menuSkills.map((cmd) => (
                                <DropdownMenuItem
                                  key={cmd.skillName}
                                  onSelect={() => {
                                    setAttachMenuOpen(false);
                                    pickSkill(cmd);
                                  }}
                                >
                                  <div className="flex min-w-0 flex-col">
                                    <span className="truncate font-mono text-[12px]">
                                      {cmd.command}
                                    </span>
                                    <span className="truncate text-[11px] text-faint-foreground">
                                      {cmd.description}
                                    </span>
                                  </div>
                                </DropdownMenuItem>
                              ))
                            )}
                          </DropdownMenuGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                )}
              </DropdownMenu>
              {onAttachFile && (
                <Input
                  ref={fileRef}
                  type="file"
                  className="sr-only"
                  tabIndex={-1}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (file)
                      void onAttachFile(file).then((block) => block && onAttachContext(block));
                  }}
                />
              )}
              <Separator orientation="vertical" className="mx-0.5 h-4" />
            </>
          )}
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
            {onSelectPolicy && (
              <PermissionSwitch value={permissionPolicy} onSelect={onSelectPolicy} />
            )}
            {onSelectModel && (
              <ModelSelector
                variant="composer"
                value={modelOverride ?? null}
                onSelect={onSelectModel}
              />
            )}
          </div>
          {running ? (
            <Button
              size="icon"
              aria-label={t('input.stop')}
              title={`${t('input.stop')} (Esc)`}
              className="shrink-0 rounded-full"
              onClick={onStop}
            >
              <Square />
            </Button>
          ) : (
            <Button
              size="icon"
              aria-label={t('input.send')}
              title={`${t('input.send')} (Enter)`}
              disabled={disabled || (!text.trim() && contextChips.length === 0)}
              className="shrink-0 rounded-full"
              onClick={() => submit('send')}
            >
              <ArrowUp />
            </Button>
          )}
        </InputGroupAddon>
      </InputGroup>
      <div className="mt-1.5 px-2 text-center text-[11px] text-faint-foreground">
        {running ? t('input.hintRunning') : t('input.hintIdle')}
      </div>

      <SkillVariableForm
        command={variableForm}
        onClose={() => setVariableForm(null)}
        onSubmit={(composed) => {
          void captureSubmissionBrowserContext([...contextChips]).then((browserContext) =>
            onSend(composed, submissionThreadId, browserContext),
          );
        }}
      />
    </div>
  );
}
