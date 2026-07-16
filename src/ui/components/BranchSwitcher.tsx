/**
 * BranchSwitcher (docs/09 §2, CH-6): renders "‹ n/m ›" beside a message that
 * has siblings; clicking (or Ctrl/Cmd+↑↓ globally) moves the thread's leafId
 * to the adjacent sibling via thread.selectBranch. Pure local tree query —
 * the sibling list comes from Dexie, not the LLM.
 */

import { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './ui/button';
import { PanelotDB } from '../../db/schema';
import { ThreadTree } from '../../db/tree';
import { t } from '../i18n';

const db = new PanelotDB();
const tree = new ThreadTree(db);

interface Props {
  threadId: string;
  nodeId: string;
  branch: { index: number; count: number };
  onSelectBranch: (expectedThreadId: string, nodeId: string) => void;
}

async function siblingAt(threadId: string, nodeId: string, offset: number): Promise<string | null> {
  // Logical siblings: turn.fork branches hang under their own turn_context
  // node, so physical-sibling queries would miss them (docs/02 §3.2).
  const siblings = await tree.getLogicalSiblings(threadId, nodeId);
  const idx = siblings.findIndex((s) => s.id === nodeId);
  if (idx === -1) return null;
  const target = siblings[idx + offset];
  return target?.id ?? null;
}

export function BranchSwitcher({ threadId, nodeId, branch, onSelectBranch }: Props) {
  const go = async (offset: number) => {
    const expectedThreadId = threadId;
    const target = await siblingAt(threadId, nodeId, offset);
    if (target) onSelectBranch(expectedThreadId, target);
  };

  return (
    <div className="mt-1 flex items-center gap-0.5 text-[11px] text-faint-foreground">
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={branch.index <= 1}
        aria-label={t('app.previousBranch')}
        onClick={() => void go(-1)}
      >
        <ChevronLeft data-icon="inline-start" />
      </Button>
      <span className="tabular-nums">
        {branch.index}/{branch.count}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={branch.index >= branch.count}
        aria-label={t('app.nextBranch')}
        onClick={() => void go(1)}
      >
        <ChevronRight data-icon="inline-start" />
      </Button>
    </div>
  );
}

/**
 * Global Ctrl/Cmd+↑↓ branch switching (docs/09 §6): operates on the LAST
 * branchable message in the current path.
 */
export function useBranchShortcuts(
  threadId: string | null,
  lastBranchNodeId: string | null,
  onSelectBranch: (expectedThreadId: string, nodeId: string) => void,
): void {
  const selectBranchRef = useRef(onSelectBranch);
  useEffect(() => {
    selectBranchRef.current = onSelectBranch;
  }, [onSelectBranch]);

  useEffect(() => {
    if (!threadId || !lastBranchNodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      const expectedThreadId = threadId;
      void siblingAt(expectedThreadId, lastBranchNodeId, e.key === 'ArrowUp' ? -1 : 1).then(
        (target) => {
          if (target) selectBranchRef.current(expectedThreadId, target);
        },
      );
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [threadId, lastBranchNodeId]);
}
