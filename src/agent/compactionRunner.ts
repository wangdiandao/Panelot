/**
 * CompactionRunner — executes auto/manual compaction as an internal
 * non-steerable turn (docs/04 §5.1), and branch summarization on branch
 * switches (§5.2). Uses the task model when configured (docs/03 §1.5).
 */

import type { ThreadTree } from '../db/tree';
import { buildSessionContext } from '../db/sessionContext';
import type { CompactionPayload } from '../db/types';
import type { AgentEvent } from '../messaging/protocol';
import type { ProviderAdapter } from '../providers/types';
import {
  compactionSpan,
  findCutPoint,
  mergeTrackedOps,
  renderSpanForSummary,
  shouldCompact,
  type CompactionConfig,
  DEFAULT_COMPACTION_CONFIG,
} from './compaction';
import { BRANCH_SUMMARY_PROMPT, compactionPrompt } from '../prompts/kernel';

export interface TaskModelRef {
  provider: ProviderAdapter;
  model: string;
}

export class CompactionRunner {
  constructor(
    private tree: ThreadTree,
    /** Task model resolver; falls back to the thread's main model (docs/03 §1.5). */
    private taskModel: (threadId: string) => Promise<TaskModelRef>,
    private emit: (ev: AgentEvent) => void,
    private config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
  ) {}

  /** Called before each LLM call by the loop (docs/04 §2). */
  async maybeCompact(threadId: string, contextTokens: number, contextWindow: number): Promise<void> {
    if (!shouldCompact(contextTokens, contextWindow, this.config)) return;
    await this.compact(threadId);
  }

  /** Manual or forced compaction. No-op if there is nothing to cut. */
  async compact(threadId: string): Promise<boolean> {
    const thread = await this.tree.getThread(threadId);
    if (!thread?.leafId) return false;
    const ctx = await buildSessionContext(this.tree, threadId, thread.leafId);

    const cutPointId = findCutPoint(ctx.path, this.config);
    if (!cutPointId) return false;

    const span = compactionSpan(ctx.path, ctx.lastCompaction, cutPointId);
    if (span.length === 0) return false;

    const turnId = crypto.randomUUID();
    this.emit({ type: 'turn.start', threadId, turnId, turnKind: 'compaction', steerable: false });

    try {
      const trackedOps = mergeTrackedOps(ctx.lastCompaction?.trackedOps ?? null, span);
      const spanText = renderSpanForSummary(span);
      const prompt = compactionPrompt(
        ctx.lastCompaction?.summary ?? '',
        JSON.stringify(ctx.lastCompaction?.trackedOps ?? null),
      );

      const { provider, model } = await this.taskModel(threadId);
      const stream = provider.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: `${prompt}\n\n--- CONVERSATION SPAN ---\n${spanText}` }] }],
        tools: [],
        params: { maxTokens: 2000 },
        model,
        signal: new AbortController().signal,
      });
      const final = await stream.final();
      const summary = final.message
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      if (!summary) return false;

      const tokensBefore = Math.ceil(spanText.length / 4);
      const payload: CompactionPayload = {
        summary,
        firstKeptNodeId: cutPointId,
        tokensBefore,
        tokensAfter: Math.ceil(summary.length / 4),
        trackedOps,
      };
      await this.tree.appendNode(threadId, { type: 'compaction', payload });
      this.emit({ type: 'turn.complete', threadId, turnId, stopReason: 'done' });
      return true;
    } catch {
      // Compaction failure must never kill the main task; skip and retry later.
      this.emit({ type: 'turn.complete', threadId, turnId, stopReason: 'error' });
      return false;
    }
  }

  /**
   * Branch summarization (docs/04 §5.2): summarize the abandoned branch
   * (below the common ancestor) and inject a branch_summary node into the
   * NEW branch path.
   */
  async summarizeAbandonedBranch(
    threadId: string,
    abandonedLeafId: string,
    newLeafId: string,
  ): Promise<void> {
    const abandoned = await this.tree.getPath(threadId, abandonedLeafId);
    const current = await this.tree.getPath(threadId, newLeafId);
    const currentIds = new Set(current.map((n) => n.id));

    // Deepest common ancestor = last abandoned-path node also on the new path.
    let commonAncestorId: string | null = null;
    let divergeIdx = 0;
    for (let i = 0; i < abandoned.length; i++) {
      if (currentIds.has(abandoned[i]!.id)) {
        commonAncestorId = abandoned[i]!.id;
        divergeIdx = i + 1;
      } else break;
    }
    const branchNodes = abandoned.slice(divergeIdx);
    if (branchNodes.length === 0) return;

    try {
      const spanText = renderSpanForSummary(branchNodes);
      if (!spanText.trim()) return;
      const { provider, model } = await this.taskModel(threadId);
      const stream = provider.stream({
        messages: [{ role: 'user', content: [{ type: 'text', text: `${BRANCH_SUMMARY_PROMPT}\n\n--- ABANDONED BRANCH ---\n${spanText}` }] }],
        tools: [],
        params: { maxTokens: 400 },
        model,
        signal: new AbortController().signal,
      });
      const final = await stream.final();
      const summary = final.message.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
      if (!summary) return;

      await this.tree.appendNode(threadId, {
        type: 'branch_summary',
        payload: { summary, abandonedLeafId, commonAncestorId: commonAncestorId ?? '' },
        parentId: newLeafId,
      });
    } catch {
      // Best-effort: losing a branch summary is acceptable, blocking the switch is not.
    }
  }
}
