/**
 * Auto-compaction support (docs/04 §5, docs/02 §4).
 *
 * Two-compaction design follows Pi Agent's CompactionEntry: each compaction
 * summarizes the span [previous firstKeptNodeId (or root), cutPoint), so
 * messages that survived the last compaction are folded into the next summary
 * instead of silently vanishing (compound-loss prevention).
 */

import type { ThreadNode } from '../db/types';
import type { CompactionPayload, TrackedOps } from '../db/types';

export interface CompactionConfig {
  /** Trigger when contextTokens > contextWindow − reserveTokens. */
  reserveTokens: number;
  /** The cut point must keep at least this many tokens of recent history. */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  reserveTokens: 16_000,
  keepRecentTokens: 20_000,
};

/** Rough token estimate: ~4 chars/token for mixed CJK/latin content. */
export function estimateNodeTokens(node: ThreadNode): number {
  return Math.ceil(JSON.stringify(node.payload).length / 4);
}

export function shouldCompact(
  contextTokens: number,
  contextWindow: number,
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): boolean {
  return contextTokens > contextWindow - config.reserveTokens;
}

/**
 * Find the cut point on the active path (docs/04 §5.1): scan backward from the
 * newest node keeping ≥ keepRecentTokens, then adjust so we never cut between
 * a tool_call and its tool_result, and never cut a pending-approval span.
 *
 * Returns the node id that becomes `firstKeptNodeId`, or null when the path is
 * too short to compact meaningfully.
 */
export function findCutPoint(
  path: ThreadNode[],
  config: CompactionConfig = DEFAULT_COMPACTION_CONFIG,
): string | null {
  if (path.length < 4) return null;

  // Scan backward accumulating token estimates.
  let kept = 0;
  let cutIdx = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    kept += estimateNodeTokens(path[i]!);
    if (kept >= config.keepRecentTokens) {
      cutIdx = i;
      break;
    }
  }
  if (cutIdx <= 0) return null; // everything fits in the keep window

  // Never start the kept region at a tool_result whose tool_call would be
  // summarized away — walk the cut earlier until the pair is intact.
  // Also keep turn_context anchors with their turn.
  while (cutIdx > 0) {
    const node = path[cutIdx]!;
    if (node.type === 'tool_result' || node.type === 'tool_call' || node.type === 'assistant_message') {
      // Walk back to the turn boundary (user_message or turn_context) so a
      // turn is never split in half.
      cutIdx--;
      continue;
    }
    if (node.type === 'turn_context') {
      // Perfect anchor: keep from the turn_context on.
      break;
    }
    if (node.type === 'user_message') {
      // Prefer the preceding turn_context when adjacent.
      const prev = path[cutIdx - 1];
      if (prev && prev.type === 'turn_context') cutIdx--;
      break;
    }
    break;
  }
  if (cutIdx <= 0) return null;
  return path[cutIdx]!.id;
}

/**
 * The span a new compaction must summarize: from the previous compaction's
 * firstKeptNodeId (or root) up to (excluding) the new cut point. Compaction
 * nodes themselves are excluded from the summarized content.
 */
export function compactionSpan(
  path: ThreadNode[],
  previousCompaction: CompactionPayload | null,
  cutPointId: string,
): ThreadNode[] {
  let startIdx = 0;
  if (previousCompaction) {
    const idx = path.findIndex((n) => n.id === previousCompaction.firstKeptNodeId);
    if (idx !== -1) startIdx = idx;
  }
  const endIdx = path.findIndex((n) => n.id === cutPointId);
  if (endIdx === -1 || endIdx <= startIdx) return [];
  return path.slice(startIdx, endIdx).filter((n) => n.type !== 'compaction');
}

/**
 * Extract tracked operations from a span and merge with the accumulated set —
 * operation history survives any number of compactions (docs/04 §5.1).
 */
export function mergeTrackedOps(previous: TrackedOps | null, span: ThreadNode[]): TrackedOps {
  const visitedUrls = new Set(previous?.visitedUrls ?? []);
  const mutatedTargets = new Set(previous?.mutatedTargets ?? []);

  for (const node of span) {
    if (node.type === 'tool_call') {
      const p = node.payload as { toolName: string; params: unknown };
      const params = (p.params ?? {}) as Record<string, unknown>;
      if ((p.toolName === 'navigate' || p.toolName === 'tab_open' || p.toolName === 'fetch_url') && typeof params.url === 'string') {
        visitedUrls.add(params.url);
      }
      if (p.toolName === 'click' || p.toolName === 'type' || p.toolName === 'select_option') {
        const desc = typeof params.element === 'string' ? params.element : p.toolName;
        mutatedTargets.add(desc);
      }
    }
  }
  return { visitedUrls: [...visitedUrls], mutatedTargets: [...mutatedTargets] };
}

/** Render a span as plain text for the summarizer input. */
export function renderSpanForSummary(span: ThreadNode[]): string {
  const lines: string[] = [];
  for (const node of span) {
    switch (node.type) {
      case 'user_message': {
        const p = node.payload as { content: { type: string; text?: string }[] };
        lines.push(`USER: ${p.content.map((c) => c.text ?? '[image]').join(' ')}`);
        break;
      }
      case 'assistant_message': {
        const p = node.payload as { content: { type: string; text?: string }[] };
        lines.push(`ASSISTANT: ${p.content.map((c) => c.text ?? '').join(' ')}`);
        break;
      }
      case 'tool_call': {
        const p = node.payload as { toolName: string; params: unknown };
        lines.push(`TOOL CALL: ${p.toolName}(${JSON.stringify(p.params)})`);
        break;
      }
      case 'tool_result': {
        const p = node.payload as { ok: boolean; contentForLlm: { type: string; text?: string }[] };
        const text = p.contentForLlm.map((c) => c.text ?? '').join(' ');
        // Tool results are summarized aggressively (docs/05 §7).
        lines.push(`TOOL RESULT (${p.ok ? 'ok' : 'error'}): ${text.slice(0, 500)}`);
        break;
      }
      case 'branch_summary': {
        const p = node.payload as { summary: string };
        lines.push(`ABANDONED BRANCH: ${p.summary}`);
        break;
      }
      default:
        break;
    }
  }
  return lines.join('\n');
}
