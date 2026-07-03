/**
 * ThreadView — the shared conversation core used by both the side panel and
 * the full-page chat (docs/09 §2).
 */

import { useSyncExternalStore, useState, useCallback } from 'react';
import type { ContextBlock } from '../../messaging/protocol';
import type { EngineSession, ThreadUiState } from '../engineClient';
import { MessageStream } from './MessageStream';
import { PromptInput } from './PromptInput';
import { ApprovalCard } from './ApprovalCard';

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
}

export function ThreadView({ session, providerConfigured, onOpenSettings, stagedContext = [], onRemoveStagedContext }: Props) {
  const state = useEngineState(session);
  const [, setSendTick] = useState(0);

  const send = useCallback(
    (text: string) => {
      session.submit({ text, attachedContext: stagedContext.length > 0 ? stagedContext : undefined });
      // Chips are consumed by the send.
      for (let i = stagedContext.length - 1; i >= 0; i--) onRemoveStagedContext?.(i);
      setSendTick((t) => t + 1);
    },
    [session, stagedContext, onRemoveStagedContext],
  );

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      {!state.connected && (
        <div className="border-b border-border-soft bg-surface px-3 py-1 text-center text-[11px] text-text-dim">
          重新连接引擎…
        </div>
      )}
      {state.lastError && (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1 text-[11px] text-danger">
          {state.lastError}
        </div>
      )}
      <MessageStream items={state.items} liveItems={state.liveItems} />
      {state.pendingApprovals.length > 0 && (
        <div className="space-y-2 px-4 pb-2">
          {state.pendingApprovals.slice(0, 1).map((a, _, arr) => (
            <ApprovalCard
              key={a.approvalId}
              approval={a}
              queuePosition={{ index: 1, total: state.pendingApprovals.length || arr.length }}
              onDecision={(id, d) => session.respondApproval(id, d)}
            />
          ))}
        </div>
      )}
      {state.wasInterrupted && (
        <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
          <span>任务此前被中断（可能是浏览器休眠）。</span>
          <button
            type="button"
            onClick={() => session.enqueue({ text: '继续刚才的任务' })}
            className="ml-auto rounded-lg bg-warn px-2.5 py-1 text-[11px] font-medium text-black transition-[filter] hover:brightness-110"
          >
            继续
          </button>
        </div>
      )}
      {!providerConfigured && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mx-4 mb-2 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-[12px] text-accent transition-colors hover:bg-accent/20"
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
        onSend={send}
        onEnqueue={(text) => session.enqueue({ text })}
        onStop={() => session.interrupt()}
      />
    </div>
  );
}
