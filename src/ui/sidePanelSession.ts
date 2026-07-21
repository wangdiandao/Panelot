import type { ThreadMeta } from '../db/types';

export function isRestorableThread(thread: ThreadMeta | null | undefined): thread is ThreadMeta {
  return Boolean(thread && !thread.deleting && !thread.archived && thread.leafId !== null);
}

export function selectInitialSidePanelThread(
  lastSelected: ThreadMeta | null | undefined,
  mostRecent: ThreadMeta | null | undefined,
): ThreadMeta | null {
  if (isRestorableThread(lastSelected)) return lastSelected;
  return isRestorableThread(mostRecent) ? mostRecent : null;
}
