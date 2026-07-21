/**
 * Conversation-tree operations (docs/02 §3).
 *
 * Modeling follows OpenWebUI's message tree ({nodes, leafId} with parentId
 * links and sibling-based branching) while deliberately avoiding its dual-
 * storage pitfall (issue #15189): the tree is the ONLY representation —
 * no parallel flat array, no stored childrenIds.
 */

import Dexie from 'dexie';
import type { PanelotDB } from './schema';
import type { NodePayload, NodeType, ThreadMeta, ThreadNode } from './types';

export interface AppendNodeInput {
  type: NodeType;
  payload: NodePayload;
  /** Defaults to the thread's current leafId (normal conversation flow). */
  parentId?: string | null;
  id?: string;
  ts?: number;
}

export interface DeleteThreadCommandIdentity {
  clientId: string;
  submissionId: string;
  commandType: 'thread.delete';
  requestFingerprint?: string;
}

export function createThreadMeta(partial: Partial<ThreadMeta> = {}, now = Date.now()): ThreadMeta {
  return {
    id: partial.id ?? crypto.randomUUID(),
    title: partial.title ?? '',
    createdAt: now,
    updatedAt: now,
    leafId: null,
    tags: [],
    pinned: false,
    archived: false,
    stats: { turns: 0, totalTokens: 0, costUsd: 0 },
    scopeOrigins: [],
    ...partial,
    revision: partial.revision ?? 0,
  };
}

/** Max parent-chain hops = total node count — guards against cycles (docs/02 §3.4). */
class TraversalGuard {
  private hops = 0;
  constructor(private limit: number) {}
  step(): void {
    if (++this.hops > this.limit) {
      throw new Error('tree traversal exceeded node count — data corruption suspected');
    }
  }
}

// Short branches are cheaper as point reads, while long histories must not pay one
// IndexedDB round trip per ancestor.
const SERIAL_PATH_LOOKUP_LIMIT = 32;

export class ThreadTree {
  constructor(private db: PanelotDB) {}

  // -------------------------------------------------------------------------
  // Thread lifecycle
  // -------------------------------------------------------------------------

  async createThread(partial?: Partial<ThreadMeta>): Promise<ThreadMeta> {
    const meta = createThreadMeta(partial);
    await this.db.threads.add(meta);
    return meta;
  }

  async getThread(threadId: string): Promise<ThreadMeta | undefined> {
    const meta = await this.db.threads.get(threadId);
    // A thread mid-deletion must never be replayed (docs/02 §6).
    if (meta?.deleting) return undefined;
    return meta;
  }

  async updateThread(threadId: string, patch: Partial<ThreadMeta>): Promise<void> {
    await this.db.transaction('rw', this.db.threads, async () => {
      const thread = await this.db.threads.get(threadId);
      if (!thread) throw new Error(`thread ${threadId} not found`);
      await this.db.threads.update(threadId, {
        ...patch,
        revision: thread.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }

  async deleteThread(threadId: string, command?: DeleteThreadCommandIdentity): Promise<void> {
    await this.db.transaction(
      'rw',
      [
        this.db.nodes,
        this.db.attachments,
        this.db.runs,
        this.db.approvals,
        this.db.interactions,
        this.db.threads,
        this.db.commandReceipts,
      ],
      async () => {
        const thread = await this.db.threads.get(threadId);
        if (!thread) throw new Error(`thread ${threadId} not found`);
        await this.db.nodes.where('threadId').equals(threadId).delete();
        await this.db.attachments.where('threadId').equals(threadId).delete();
        await this.db.runs.where('threadId').equals(threadId).delete();
        await this.db.approvals.where('threadId').equals(threadId).delete();
        await this.db.interactions.where('threadId').equals(threadId).delete();
        await this.db.threads.delete(threadId);
        if (command) {
          const receiptId = `${command.clientId}\u0000${command.submissionId}`;
          const receipt = await this.db.commandReceipts.get(receiptId);
          if (!receipt || receipt.status !== 'processing') {
            throw new Error(`processing command receipt not found: ${receiptId}`);
          }
          if (receipt.commandType !== command.commandType) {
            throw new Error(
              `Command receipt type mismatch: expected ${receipt.commandType}, received ${command.commandType}`,
            );
          }
          if (receipt.requestFingerprint !== command.requestFingerprint) {
            throw new Error('Command receipt payload fingerprint mismatch');
          }
          await this.db.commandReceipts.put({
            ...receipt,
            status: 'acknowledged',
            response: { type: 'command.ack', threadId },
            updatedAt: Date.now(),
          });
        }
      },
    );
  }

  // -------------------------------------------------------------------------
  // Append (docs/02 §3.1)
  // -------------------------------------------------------------------------

  async appendNode(threadId: string, input: AppendNodeInput): Promise<ThreadNode> {
    return this.db.transaction('rw', [this.db.threads, this.db.nodes], async () => {
      const thread = await this.db.threads.get(threadId);
      if (!thread || thread.deleting) throw new Error(`thread ${threadId} not found`);

      const parentId = input.parentId !== undefined ? input.parentId : thread.leafId;

      // Integrity: parent must exist in the same thread (or be null root).
      if (parentId !== null) {
        const parent = await this.db.nodes.get(parentId);
        if (!parent || parent.threadId !== threadId) {
          throw new Error(`parent ${parentId} not found in thread ${threadId}`);
        }
      }

      const last = await this.db.nodes
        .where('[threadId+seq]')
        .between([threadId, Dexie.minKey], [threadId, Dexie.maxKey])
        .last();
      const seq = (last?.seq ?? 0) + 1;

      const node: ThreadNode = {
        id: input.id ?? crypto.randomUUID(),
        threadId,
        parentId,
        seq,
        ts: input.ts ?? Date.now(),
        type: input.type,
        payload: input.payload,
      };
      await this.db.nodes.add(node);
      await this.db.threads.update(threadId, {
        leafId: node.id,
        revision: thread.revision + 1,
        updatedAt: Date.now(),
      });
      return node;
    });
  }

  // -------------------------------------------------------------------------
  // Branching (docs/02 §3.2)
  // -------------------------------------------------------------------------

  /**
   * Edit-and-resend: append the new user message as a SIBLING of the edited
   * message (same parent) and move the cursor there. Regeneration is the same
   * operation with the assistant message's parent.
   */
  async forkAt(
    threadId: string,
    siblingOfNodeId: string,
    input: AppendNodeInput,
  ): Promise<ThreadNode> {
    const anchor = await this.db.nodes.get(siblingOfNodeId);
    if (!anchor || anchor.threadId !== threadId) {
      throw new Error(`node ${siblingOfNodeId} not found in thread ${threadId}`);
    }
    return this.appendNode(threadId, { ...input, parentId: anchor.parentId });
  }

  /**
   * Position the cursor for a branch-and-run (turn.fork): leafId ← the
   * anchor's nearest non-turn_context ancestor. The next turn prepends its
   * own turn_context there, making its user_message a LOGICAL sibling of the
   * anchor (see getLogicalSiblings). The anchor should be a user_message —
   * regenerate forks at the assistant's preceding user message.
   */
  async repositionLeafForFork(threadId: string, siblingOfNodeId: string): Promise<void> {
    const anchor = await this.db.nodes.get(siblingOfNodeId);
    if (!anchor || anchor.threadId !== threadId) {
      throw new Error(`node ${siblingOfNodeId} not found in thread ${threadId}`);
    }
    const total = await this.db.nodes.where('threadId').equals(threadId).count();
    const guard = new TraversalGuard(total);
    let ancestorId: string | null = anchor.parentId;
    while (ancestorId !== null) {
      guard.step();
      const ancestor = await this.db.nodes.get(ancestorId);
      if (!ancestor || ancestor.threadId !== threadId)
        throw new Error(`broken parent chain at ${ancestorId}`);
      if (ancestor.type !== 'turn_context') break;
      ancestorId = ancestor.parentId;
    }
    await this.updateThread(threadId, { leafId: ancestorId });
  }

  /**
   * Logical siblings for branch UI (docs/02 §3.2): turn_context nodes are
   * invisible structure — every turn prepends one, and a fork's turn_context
   * lands as the physical sibling of the forked message. The branch set of a
   * message node is therefore the LOGICAL children of its nearest
   * non-turn_context ancestor, where each turn_context expands (recursively,
   * seq-ordered) to the message nodes beneath it.
   */
  async getLogicalSiblings(threadId: string, nodeId: string): Promise<ThreadNode[]> {
    const node = await this.db.nodes.get(nodeId);
    if (!node || node.threadId !== threadId) return [];
    const total = await this.db.nodes.where('threadId').equals(threadId).count();
    const guard = new TraversalGuard(total);

    // Nearest non-turn_context ancestor (null = root level).
    let ancestorId: string | null = node.parentId;
    while (ancestorId !== null) {
      guard.step();
      const ancestor = await this.db.nodes.get(ancestorId);
      if (!ancestor || ancestor.threadId !== threadId) return [];
      if (ancestor.type !== 'turn_context') break;
      ancestorId = ancestor.parentId;
    }

    const liveChildren = async (parentId: string | null): Promise<ThreadNode[]> => {
      const children =
        parentId === null
          ? (await this.db.nodes.where('threadId').equals(threadId).toArray()).filter(
              (n) => n.parentId === null,
            )
          : await this.db.nodes.where('parentId').equals(parentId).toArray();
      return children
        .filter((n) => n.threadId === threadId && !n.deleted)
        .sort((a, b) => a.seq - b.seq);
    };

    const expand = async (nodes: ThreadNode[]): Promise<ThreadNode[]> => {
      const out: ThreadNode[] = [];
      for (const n of nodes) {
        guard.step();
        if (n.type === 'turn_context') out.push(...(await expand(await liveChildren(n.id))));
        else out.push(n);
      }
      return out;
    };

    return expand(await liveChildren(ancestorId));
  }

  /** Live (non-tombstoned) siblings sharing a parent, ordered by seq. */
  async getSiblings(threadId: string, nodeId: string): Promise<ThreadNode[]> {
    const node = await this.db.nodes.get(nodeId);
    if (!node || node.threadId !== threadId) return [];
    const siblings =
      node.parentId === null
        ? (await this.db.nodes.where('threadId').equals(threadId).toArray()).filter(
            (n) => n.parentId === null,
          )
        : await this.db.nodes.where('parentId').equals(node.parentId).toArray();
    return siblings
      .filter((n) => n.threadId === threadId && !n.deleted)
      .sort((a, b) => a.seq - b.seq);
  }

  /**
   * Branch switching: move leafId to the target sibling's deepest default
   * descendant — at each level descend into the child with the highest seq
   * (docs/02 §3.2).
   */
  async switchToSibling(threadId: string, targetSiblingId: string): Promise<string> {
    const target = await this.db.nodes.get(targetSiblingId);
    if (!target || target.threadId !== threadId || target.deleted) {
      throw new Error(`node ${targetSiblingId} not found in thread ${threadId}`);
    }
    const total = await this.db.nodes.where('threadId').equals(threadId).count();
    const guard = new TraversalGuard(total);

    let currentId = targetSiblingId;
    for (;;) {
      guard.step();
      const children = (await this.db.nodes.where('parentId').equals(currentId).toArray())
        .filter((n) => n.threadId === threadId && !n.deleted)
        .sort((a, b) => a.seq - b.seq);
      if (children.length === 0) break;
      const lastChild = children.at(-1);
      if (!lastChild) break;
      currentId = lastChild.id;
    }
    await this.updateThread(threadId, { leafId: currentId });
    return currentId;
  }

  // -------------------------------------------------------------------------
  // Tombstone deletion (docs/02 §3.3)
  // -------------------------------------------------------------------------

  async tombstone(threadId: string, nodeId: string): Promise<void> {
    await this.db.transaction('rw', [this.db.nodes, this.db.threads], async () => {
      const node = await this.db.nodes.get(nodeId);
      if (!node || node.threadId !== threadId) throw new Error(`node ${nodeId} not found`);
      const thread = await this.db.threads.get(threadId);
      if (!thread) throw new Error(`thread ${threadId} not found`);
      await this.db.nodes.update(nodeId, { deleted: true });

      let leafId = thread.leafId;
      if (leafId === nodeId) {
        const total = await this.db.nodes.where('threadId').equals(threadId).count();
        const guard = new TraversalGuard(total);
        let current: ThreadNode | undefined = { ...node, deleted: true };
        while (current?.deleted) {
          guard.step();
          current =
            current.parentId === null ? undefined : await this.db.nodes.get(current.parentId);
        }
        leafId = current?.id ?? null;
      }
      await this.db.threads.update(threadId, {
        leafId,
        revision: thread.revision + 1,
        updatedAt: Date.now(),
      });
    });
  }

  // -------------------------------------------------------------------------
  // Path traversal & integrity (docs/02 §3.4)
  // -------------------------------------------------------------------------

  /**
   * Walk leaf → root, returning the path in root-first order.
   * Tombstones are skipped (children implicitly relink to grandparent).
   * Throws if the chain is broken or cyclic — callers use validateLeaf first.
   */
  async getPath(threadId: string, leafId: string): Promise<ThreadNode[]> {
    const path: ThreadNode[] = [];
    const seen = new Set<string>();
    let serialLookups = 0;
    let nodesById: Map<string, ThreadNode> | undefined;
    let currentId: string | null = leafId;
    while (currentId !== null) {
      if (seen.has(currentId)) {
        throw new Error('tree traversal cycle — data corruption suspected');
      }
      seen.add(currentId);

      let node: ThreadNode | undefined;
      if (serialLookups < SERIAL_PATH_LOOKUP_LIMIT) {
        node = await this.db.nodes.get(currentId);
        serialLookups++;
      } else {
        if (!nodesById) {
          const nodes = await this.db.nodes.where('threadId').equals(threadId).toArray();
          nodesById = new Map(nodes.map((candidate) => [candidate.id, candidate]));
        }
        node = nodesById.get(currentId);
      }
      if (!node || node.threadId !== threadId) {
        throw new Error(`broken parent chain at ${currentId}`);
      }
      if (!node.deleted) path.push(node);
      currentId = node.parentId;
    }
    return path.reverse();
  }

  /**
   * Load-time integrity check: leafId must trace to root. On failure fall
   * back to the reachable node with the highest seq (docs/02 §3.4) so the
   * renderer NEVER dead-loops on bad data.
   */
  async validateLeaf(threadId: string): Promise<{ leafId: string | null; repaired: boolean }> {
    const thread = await this.db.threads.get(threadId);
    if (!thread) throw new Error(`thread ${threadId} not found`);
    if (thread.leafId === null) return { leafId: null, repaired: false };

    try {
      await this.getPath(threadId, thread.leafId);
      return { leafId: thread.leafId, repaired: false };
    } catch {
      // Find the highest-seq node that still traces to root.
      const all = await this.db.nodes.where('threadId').equals(threadId).toArray();
      const byId = new Map(all.map((n) => [n.id, n]));
      const candidates = all.filter((n) => !n.deleted).sort((a, b) => b.seq - a.seq);
      for (const candidate of candidates) {
        if (this.tracesToRoot(candidate, byId, all.length)) {
          await this.updateThread(threadId, { leafId: candidate.id });
          return { leafId: candidate.id, repaired: true };
        }
      }
      await this.updateThread(threadId, { leafId: null });
      return { leafId: null, repaired: true };
    }
  }

  private tracesToRoot(node: ThreadNode, byId: Map<string, ThreadNode>, limit: number): boolean {
    let hops = 0;
    let cur: ThreadNode | undefined = node;
    while (cur) {
      if (++hops > limit) return false;
      if (cur.parentId === null) return true;
      cur = byId.get(cur.parentId);
    }
    return false;
  }
}
