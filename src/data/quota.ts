/**
 * Storage quota monitoring & attachment LRU eviction (docs/02 §2.3/§6).
 * Screenshots/snapshots have a 200MB budget; over-budget evicts oldest by
 * createdAt and marks the owning node `evicted`. Eviction never touches the
 * active thread.
 */

import type { PanelotDB } from '../db/schema';

const ATTACHMENT_BUDGET_BYTES = 200 * 1024 * 1024;
const WARN_THRESHOLD = 0.8;

export interface QuotaStatus {
  usage: number;
  quota: number;
  pct: number;
  warn: boolean;
}

export async function getQuotaStatus(): Promise<QuotaStatus> {
  const est = (await navigator.storage?.estimate?.()) ?? { usage: 0, quota: 1 };
  const usage = est.usage ?? 0;
  const quota = est.quota ?? 1;
  const pct = quota > 0 ? usage / quota : 0;
  return { usage, quota, pct, warn: pct >= WARN_THRESHOLD };
}

/** Evict oldest attachments over the budget, skipping the active thread. */
export async function evictAttachmentsIfNeeded(db: PanelotDB, activeThreadId?: string): Promise<number> {
  const attachments = await db.attachments.orderBy('createdAt').toArray();
  let total = attachments.reduce((sum, a) => sum + a.bytes.size, 0);
  if (total <= ATTACHMENT_BUDGET_BYTES) return 0;

  let evicted = 0;
  for (const att of attachments) {
    if (total <= ATTACHMENT_BUDGET_BYTES) break;
    if (att.threadId === activeThreadId) continue; // never evict the live thread
    total -= att.bytes.size;
    await db.attachments.delete(att.id);
    evicted++;
  }
  return evicted;
}
