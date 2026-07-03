/**
 * ThreadView — the shared conversation core used by both the side panel and
 * the full-page chat (docs/09 §2). Banners use shadcn/ui Alert; after an
 * approval decision keyboard focus returns to the composer (docs/09 §8).
 */

import { useSyncExternalStore, useState, useCallback, useRef } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ApprovalDecision, ContextBlock } from '../../messaging/protocol';
import type { EngineSession, ThreadUiState } from '../engineClient';
import { MessageStream } from './MessageStream';
import { PromptInput } from './PromptInput';
import { ApprovalCard } from './ApprovalCard';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';

export function useEngineState(session: EngineSession): ThreadUiState {
  return useSyncExternalStore(session.store.subscribe, session.store.getState, session.store.getState);
}

interface Props {
  session: EngineSession;
  /** Provider configured? Gates the input (docs/09 §7). */
  providerConfigured: boolean;
  onOpenSettings?: () => void;
  /** Context chips staged for the next message (page attach etc.). */
  stagedContext?: ContextBlock[];
  onRemoveStagedContext?: (index: number) => void;
  /** Stage a context block from the @ trigger menu. */
  onAttachContext?: (block: ContextBlock) => void;
}

export function ThreadView({ session, providerConfigured, onOpenSettings, stagedContext = [], onRemoveStagedContext, onAttachContext }: Props) {
  const state = useEngineState(session);
  const [, setSendTick] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const send = useCallback(
    (text: string) => {
      session.submit({ text, attachedContext: stagedContext.length > 0 ? stagedContext : undefined });
      // Chips are consumed by the send.
      for (let i = stagedContext.length - 1; i >= 0; i--) onRemoveStagedContext?.(i);
      setSendTick((t) => t + 1);
    },
    [session, stagedContext, onRemoveStagedContext],
  );

  const onDecision = useCallback(
    (id: string, d: ApprovalDecision) => {
      session.respondApproval(id, d);
      // Focus returns to the composer so the keyboard flow continues.
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [session],
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {!state.connected && (
        <div className="border-b border-border-soft bg-card px-3 py-1 text-center text-[11px] text-muted-foreground">
          重新连接引擎…
        </div>
      )}
      {state.lastError && (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-[11px] text-destructive">
          {state.lastError}
        </div>
      )}
      <MessageStream
        items={state.items}
        liveItems={state.liveItems}
        threadId={state.threadId}
        onSelectBranch={(nodeId) => session.selectBranch(nodeId)}
      />
      {state.pendingApprovals.length > 0 && (
        <div className="space-y-2 px-4 pb-2">
          {state.pendingApprovals.slice(0, 1).map((a, _, arr) => (
            <ApprovalCard
              key={a.approvalId}
              approval={a}
              queuePosition={{ index: 1, total: state.pendingApprovals.length || arr.length }}
              onDecision={onDecision}
            />
          ))}
        </div>
      )}
      {state.wasInterrupted && (
        <Alert className="mx-4 mb-2 w-auto border-warning/40 bg-warning/10 text-warning">
          <TriangleAlert className="size-4" />
          <AlertDescription className="flex items-center gap-2 text-[12px] text-warning">
            <span>任务此前被中断（可能是浏览器休眠）。</span>
            <Button
              size="sm"
              className="ml-auto h-6 bg-warning px-2.5 text-[11px] text-black hover:bg-warning/90"
              onClick={() => session.enqueue({ text: '继续刚才的任务' })}
            >
              继续
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!providerConfigured && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mx-4 mb-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-[12px] text-primary transition-colors hover:bg-primary/20"
        >
          先在设置中添加模型 →
        </button>
      )}
      <PromptInput
        running={state.activeTurn !== null}
        steerable={state.activeTurn?.steerable ?? false}
        queuedInputs={state.queuedInputs}
        disabled={!providerConfigured}
        contextChips={stagedContext}
        onRemoveChip={(i) => onRemoveStagedContext?.(i)}
        onAttachContext={onAttachContext}
        onSend={send}
        onEnqueue={(text) => session.enqueue({ text })}
        onStop={() => session.interrupt()}
        textareaRef={inputRef}
        modelOverride={state.pendingOverrides.model ?? null}
        onSelectModel={(choice) =>
          session.setOverrides({ model: choice ? { connectionId: choice.connectionId, modelId: choice.modelId } : undefined })
        }
      />
    </div>
  );
}
