/**
 * ThreadView — the shared conversation core used by both the side panel and
 * the full-page chat (docs/09 §2). Banners use shadcn/ui Alert; after an
 * approval decision keyboard focus returns to the composer (docs/09 §8).
 */

import { useSyncExternalStore, useState, useCallback, useRef, useEffect } from 'react';
import { toast } from 'sonner';
import type { ApprovalDecision, ContextBlock } from '../../messaging/protocol';
import { AttachmentRepository } from '../../data/attachments';
import { PanelotDB } from '../../db/schema';
import type { EngineSession, ThreadUiState } from '../engineClient';
import { MessageStream } from './MessageStream';
import { PromptInput } from './PromptInput';
import { ApprovalCard } from './ApprovalCard';
import { PlanConfirmCard } from './PlanConfirmCard';
import { EmptyState } from './EmptyState';
import { QueueDock } from './QueueDock';
import { RecoveryCard } from './RecoveryCard';
import { Onboarding } from './Onboarding';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { t } from '../i18n';
import { buildProviderErrorPresentation } from '../providerErrorPresentation';
import { ProviderErrorNotice } from './ProviderErrorNotice';

export function useEngineState(session: EngineSession): ThreadUiState {
  return useSyncExternalStore(
    session.store.subscribe,
    session.store.getState,
    session.store.getState,
  );
}

const attachmentRepository = new AttachmentRepository(new PanelotDB());

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
  /**
   * Render the model selector inside the composer toolbar. The full page
   * hosts it in the header instead (OpenWebUI placement); the side panel
   * keeps it here (no room in a 360px header).
   */
  modelSelectorInComposer?: boolean;
  /** Hosting surface — the empty state adapts (docs/09 §7). */
  surface?: 'page' | 'panel';
  /** Active tab URL for page-type-aware empty-state suggestions (panel). */
  pageUrl?: string;
  /** Backspace on an empty composer (side panel page-chip removal). */
  onBackspaceEmpty?: () => void;
  /**
   * Cap row/composer content width while the scroll container spans the
   * surface (full page passes 768; side panel leaves it unset).
   */
  contentMaxWidth?: number;
  /** Called when the user invokes /plan — parent opens the task panel. */
  onPlanCommand?: () => void;
}

export function ThreadView({
  session,
  providerConfigured,
  onOpenSettings,
  onProviderConfigured,
  stagedContext = [],
  onRemoveStagedContext,
  onAttachContext,
  modelSelectorInComposer = true,
  surface = 'page',
  pageUrl,
  onBackspaceEmpty,
  contentMaxWidth,
  onPlanCommand,
}: Props) {
  const state = useEngineState(session);
  const [, setSendTick] = useState(0);
  // Debounced disconnect banner (OpenWebUI toast discipline): SW restarts
  // reconnect within ~1s constantly — flashing "reconnecting" for those is
  // noise. Only a sustained outage (>1.5s) surfaces.
  const [showDisconnected, setShowDisconnected] = useState(false);
  useEffect(() => {
    if (state.connected) {
      setShowDisconnected(false);
      return;
    }
    const timer = setTimeout(() => setShowDisconnected(true), 1500);
    return () => clearTimeout(timer);
  }, [state.connected]);
  // Plan mode (R7): agent writes a plan to todos, user confirms before execution.
  // planMode is a UI-only state — not an ApprovalPolicy value in the engine.
  const [planMode, setPlanMode] = useState(false);
  // When the agent's plan turn finishes (was running, todos appeared, now done),
  // auto-switch the composer to PlanConfirmCard.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (state.activeTurn !== null) {
      wasRunning.current = true;
    } else if (wasRunning.current && planMode && state.todos.length > 0) {
      // Turn just completed with todos written — leave planMode active so the
      // confirm card shows. The user dismisses it via confirm/edit/cancel.
      wasRunning.current = false;
    } else {
      wasRunning.current = false;
    }
  }, [state.activeTurn, state.todos.length, planMode]);

  // Draft lives here (not in PromptInput) so the empty state can filter its
  // suggestions live and drafts persist per thread across panel closes.
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Per-thread draft persistence (chrome.storage.session — the side panel
  // gets closed constantly; losing a half-typed prompt is real data loss).
  useEffect(() => {
    const key = `draft:${state.threadId ?? 'draft'}`;
    try {
      void chrome.storage?.session?.get(key).then((r) => setDraft((r[key] as string) ?? ''));
    } catch {
      /* non-extension env */
    }
  }, [state.threadId]);
  useEffect(() => {
    const key = `draft:${state.threadId ?? 'draft'}`;
    try {
      if (draft) void chrome.storage?.session?.set({ [key]: draft });
      else void chrome.storage?.session?.remove(key);
    } catch {
      /* non-extension env */
    }
  }, [draft, state.threadId]);

  const buildInput = useCallback(
    (text: string) => {
      const attachmentIds = stagedContext.flatMap((block) =>
        block.kind === 'file' && block.provenance === 'user' && block.sourceRef
          ? [block.sourceRef]
          : [],
      );
      return {
        text,
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        attachedContext: stagedContext.length > 0 ? stagedContext : undefined,
      };
    },
    [stagedContext],
  );

  const consumeStagedContext = useCallback(() => {
    for (let i = stagedContext.length - 1; i >= 0; i--) onRemoveStagedContext?.(i);
  }, [stagedContext, onRemoveStagedContext]);

  const send = useCallback(
    (text: string) => {
      session.submit(buildInput(text));
      // Chips are consumed by the send.
      consumeStagedContext();
      setSendTick((t) => t + 1);
    },
    [session, buildInput, consumeStagedContext],
  );

  const enqueue = useCallback(
    (text: string) => {
      session.enqueue(buildInput(text));
      consumeStagedContext();
    },
    [session, buildInput, consumeStagedContext],
  );

  const attachFile = useCallback(
    async (file: File): Promise<ContextBlock | null> => {
      if (!state.threadId) return null;
      try {
        const attachment = await attachmentRepository.addUpload({
          threadId: state.threadId,
          kind: file.type.startsWith('image/') ? 'image' : 'file',
          mime: file.type || 'application/octet-stream',
          bytes: file,
          provenance: 'user',
          sourceRef: file.name,
        });
        return {
          kind: 'file',
          label: file.name,
          sourceRef: attachment.id,
          trust: 'trusted',
          provenance: 'user',
          content: [
            {
              type: 'text',
              text: `User-provided attachment: ${file.name}\nAttachment ID: ${attachment.id}\nMIME: ${attachment.mime}\nSize: ${attachment.bytes.size} bytes`,
            },
          ],
          approxTokens: 40,
        };
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return null;
      }
    },
    [state.threadId],
  );

  const onDecision = useCallback(
    (id: string, d: ApprovalDecision) => {
      session.respondApproval(id, d);
      // Focus returns to the composer so the keyboard flow continues.
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [session],
  );

  // ArrowUp on an empty composer recalls the last user message text.
  const recallLast = useCallback((): string | undefined => {
    const { items } = session.store.getState();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      if (item.kind === 'user_message') {
        const content = (item.payload as { content: { type: string; text?: string }[] }).content;
        return content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') || undefined;
      }
    }
    return undefined;
  }, [session]);

  // Stream-scope shortcuts (registry: focusComposer / copyLast).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && e.shiftKey) {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'c') {
        const { items } = session.store.getState();
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i]!;
          if (item.kind === 'assistant_message') {
            const content = (item.payload as { content: { type: string; text?: string }[] })
              .content;
            const text = content.map((c) => (c.type === 'text' ? c.text : '')).join('');
            if (text) {
              e.preventDefault();
              void navigator.clipboard.writeText(text);
            }
            return;
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session]);

  const errorView = state.lastError ? buildProviderErrorPresentation(state.lastError) : undefined;
  const canOpenErrorSettings = Boolean(errorView?.opensSettings && onOpenSettings);
  const canRetryError = Boolean(state.lastError?.retryable && state.lastInput);

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {showDisconnected && (
        <div className="border-b border-border-soft bg-card px-3 py-1 text-center text-[11px] text-muted-foreground">
          {t('reconnecting')}
        </div>
      )}
      {state.lastError && (
        <ProviderErrorNotice
          error={state.lastError}
          className="rounded-none border-x-0 border-t-0 px-3 py-2"
          actions={
            canOpenErrorSettings || canRetryError ? (
              <>
                {canOpenErrorSettings && (
                  <Button variant="outline" size="xs" onClick={onOpenSettings}>
                    {t('error.openSettings')}
                  </Button>
                )}
                {canRetryError && (
                  <Button variant="outline" size="xs" onClick={() => session.retryLast()}>
                    {t('error.retry')}
                  </Button>
                )}
              </>
            ) : undefined
          }
        />
      )}
      {(showDisconnected || state.loading) && state.items.length === 0 ? (
        /* Thread switch / reconnect: 3-message skeleton (docs/09 §7). */
        <div className="flex-1 space-y-6 px-4 py-6">
          <div className="flex justify-end">
            <Skeleton className="h-10 w-3/5 rounded-2xl" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="size-7 rounded-lg" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-4/5" />
            </div>
          </div>
          <div className="flex justify-end">
            <Skeleton className="h-10 w-2/5 rounded-2xl" />
          </div>
        </div>
      ) : !providerConfigured && state.items.length === 0 && state.liveItems.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Onboarding
            onConfigured={() => onProviderConfigured?.()}
            onOpenSettings={() => onOpenSettings?.()}
            onTryDemo={(text) => send(text)}
          />
        </div>
      ) : state.items.length === 0 && state.liveItems.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            variant={surface}
            pageUrl={pageUrl}
            onPick={(text) => {
              setDraft(text);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          />
        </div>
      ) : (
        <MessageStream
          items={state.items}
          liveItems={state.liveItems}
          threadId={state.threadId}
          onSelectBranch={(nodeId) => session.selectBranch(nodeId)}
          onForkAt={(siblingOfNodeId, text) => session.forkTurn(siblingOfNodeId, { text })}
          turnActive={state.activeTurn !== null}
          contentMaxWidth={contentMaxWidth}
        />
      )}
      {/* Bottom dock (approvals / banners / composer) shares the content cap
          so it aligns with the centered rows above. */}
      <div
        className="mx-auto w-full"
        style={contentMaxWidth ? { maxWidth: contentMaxWidth } : undefined}
      >
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
        {state.recoverableRuns
          .filter((run) => run.state !== 'waiting_approval')
          .slice(0, 1)
          .map((run) => (
            <RecoveryCard
              key={run.runId}
              run={run}
              onResume={() => session.resumeRun(run.runId)}
              onResolve={(resolution) => session.resolveUncertain(run.runId, resolution)}
            />
          ))}
        {!providerConfigured && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="mx-4 mb-2 rounded-xl border border-primary/40 bg-primary/10 px-3 py-2 text-[12px] text-primary transition-colors hover:bg-primary/20"
          >
            {t('input.noProvider')}
          </button>
        )}
        <QueueDock
          runs={state.queuedRuns}
          paused={state.pendingApprovals.length > 0}
          onUpdate={(runId, text) => {
            const run = state.queuedRuns.find((candidate) => candidate.runId === runId);
            session.updateQueued(runId, { ...run?.input, text }, run?.overrides);
          }}
          onRemove={(runId) => session.removeQueued(runId)}
        />
        {/* Plan confirm card replaces the composer when plan mode is active and
          the agent has finished writing todos. Approval cards take priority
          (never fold a pending approval). */}
        {planMode &&
        state.activeTurn === null &&
        state.todos.length > 0 &&
        state.pendingApprovals.length === 0 ? (
          <PlanConfirmCard
            todos={state.todos}
            onConfirm={() => {
              setPlanMode(false);
              send(t('plan.confirmMsg'));
              onPlanCommand?.();
            }}
            onEdit={() => {
              // Drop back to the normal textarea so the user can revise their task.
              setPlanMode(false);
            }}
            onCancel={() => {
              setPlanMode(false);
            }}
          />
        ) : (
          <PromptInput
            running={state.activeTurn !== null}
            steerable={state.activeTurn?.steerable ?? false}
            disabled={!providerConfigured}
            contextChips={stagedContext}
            onRemoveChip={(i) => onRemoveStagedContext?.(i)}
            onAttachContext={onAttachContext}
            onAttachFile={onAttachContext ? attachFile : undefined}
            onSend={send}
            onEnqueue={enqueue}
            onStop={() => session.interrupt()}
            textareaRef={inputRef}
            draft={draft}
            onDraftChange={setDraft}
            onBackspaceEmpty={onBackspaceEmpty}
            onRecallLast={recallLast}
            modelOverride={state.pendingOverrides.model ?? null}
            onSelectModel={
              modelSelectorInComposer
                ? (choice) =>
                    session.setOverrides({
                      model: choice
                        ? { connectionId: choice.connectionId, modelId: choice.modelId }
                        : undefined,
                    })
                : undefined
            }
            approvalPolicy={state.pendingOverrides.approvalPolicy}
            planMode={planMode}
            onSelectPolicy={(tier) => {
              if (tier === 'plan') {
                setPlanMode(true);
                onPlanCommand?.();
              } else {
                setPlanMode(false);
                session.setOverrides({ approvalPolicy: tier });
              }
            }}
            builtinCommands={[
              {
                id: '/plan',
                label: '/plan',
                hint: t('cmd.planHint'),
                run: () => {
                  setPlanMode(true);
                  onPlanCommand?.();
                  requestAnimationFrame(() => inputRef.current?.focus());
                },
              },
            ]}
          />
        )}
      </div>
    </div>
  );
}
