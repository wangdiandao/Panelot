import Dexie, { type Table } from 'dexie';
import type { Attachment, MemoryRecord, SkillRecord, ThreadMeta, ThreadNode } from './types';

export class PanelotDB extends Dexie {
  threads!: Table<ThreadMeta, string>;
  nodes!: Table<ThreadNode, string>;
  attachments!: Table<Attachment, string>;
  skills!: Table<SkillRecord, string>;
  memories!: Table<MemoryRecord, string>;

  constructor(name = 'panelot') {
    super(name);
    this.version(1).stores({
      threads: 'id, updatedAt, folderId, archived, pinned',
      nodes: 'id, threadId, [threadId+seq], parentId',
      attachments: 'id, threadId, createdAt',
      skills: 'id, name, enabled',
      memories: 'id, key, updatedAt',
    });
  }
}

let instance: PanelotDB | null = null;

export function getDB(): PanelotDB {
  if (!instance) instance = new PanelotDB();
  return instance;
}

/** Test helper: swap in an isolated database. */
export function setDBForTesting(db: PanelotDB): void {
  instance = db;
}
