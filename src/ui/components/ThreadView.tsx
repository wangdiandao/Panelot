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
import { Onboarding } from './Onboarding';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';

export function useEngineState(session: EngineSession): ThreadUiState {
  return useSyncExternalStore(session.store.subscribe, session.store.getState, session.store.getState);
}

/** Human-readable provider-error attribution (docs/03 §7, docs/09 §7). */
const ERROR_KIND_TEXT: Record<string, string> = {
  auth: 'API Key 无效或已过期 — 检查设置中的 Key',
  rate_limit: '触发限流 — 稍后自动可重试，或添加备用 Key',
  overloaded: '模型服务过载 — 稍后重试',
  context_too_long: '上下文超长 — 已尝试压缩仍超限，试试新会话',
  content_filter: '内容被模型服务拦截',
  network: '网络异常 — 检查网络或代理设置',
  protocol: '端点协议不符 — 检查连接的 API 风格配置',
};

function humanizeError(err: { message: string; kind?: string }): string {
  return (err.kind && ERROR_KIND_TEXT[err.kind]) ?? err.message;
}

interface Props {
  session: EngineSession;
  /** Provider configured? Gates the input (docs/09 §7). */
  providerConfigured: boolean;
  onOpenSettings?: () => void;
  /** Re-check provider config (after onboarding saves a connection). */
  onProviderConfigured?: () => void;
  /** Context chips staged for the next message (page attach etc.). */
  stagedContext?: ContextBlock[];
  onRemoveStagedContext?: (index: number) => void;
  /** Stage a context block from the @ trigger menu. */
  onAttachContext?: (block: ContextBlock) => void;
}

export function ThreadView({ session, providerConfigured, onOpenSettings, onProviderConfigured, stagedContext = [], onRemoveStagedContext, onAttachContext }: Props) {
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
        <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1 text-[11px] text-destructive">
          <span className="min-w-0 flex-1 truncate" title={state.lastError.message}>
            {humanizeError(state.lastError)}
          </span>
          {state.lastError.kind === 'auth' && onOpenSettings && (
            <Button variant="ghost" size="sm" className="h-5 shrink-0 px-2 text-[11px] text-destructive underline-offset-2 hover:underline" onClick={onOpenSettings}>
              打开设置
            </Button>
          )}
          {state.lastError.retryable && state.lastInput && (
            <Button variant="ghost" size="sm" className="h-5 shrink-0 px-2 text-[11px] text-destructive underline-offset-2 hover:underline" onClick={() => session.retryLast()}>
              重试
            </Button>
          )}
        </div>
      )}
      {!providerConfigured && state.items.length === 0 && state.liveItems.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Onboarding
            onConfigured={() => onProviderConfigured?.()}
            onOpenSettings={() => onOpenSettings?.()}
            onTryDemo={(text) => send(text)}
          />
        </div>
      ) : (
        <MessageStream
          items={state.items}
          liveItems={state.liveItems}
          threadId={state.threadId}
          onSelectBranch={(nodeId) => session.selectBranch(nodeId)}
        />
      )}
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
        toolLevels={state.pendingOverrides.enabledToolLevels}
        onSelectToolLevels={(levels) => session.setOverrides({ enabledToolLevels: levels })}
      />
    </div>
  );
}
