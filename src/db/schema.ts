import Dexie, { type Table } from 'dexie';
import type {
  ApprovalRecord,
  InteractionRecord,
  Attachment,
  CommandReceipt,
  MemoryRecord,
  MaintenanceMarker,
  PluginRecord,
  PluginAssetRecord,
  RunRecord,
  SkillRecord,
  ThreadMeta,
  ThreadNode,
} from './types';

export class PanelotDB extends Dexie {
  threads!: Table<ThreadMeta, string>;
  nodes!: Table<ThreadNode, string>;
  attachments!: Table<Attachment, string>;
  skills!: Table<SkillRecord, string>;
  memories!: Table<MemoryRecord, string>;
  runs!: Table<RunRecord, string>;
  commandReceipts!: Table<CommandReceipt, string>;
  approvals!: Table<ApprovalRecord, string>;
  interactions!: Table<InteractionRecord, string>;
  plugins!: Table<PluginRecord, string>;
  pluginAssets!: Table<PluginAssetRecord, string>;
  maintenance!: Table<MaintenanceMarker, string>;

  constructor(name = 'panelot_v1') {
    super(name);
    this.version(1).stores({
      threads: 'id, updatedAt, folderId, archived, pinned',
      nodes: 'id, threadId, [threadId+seq], parentId',
      attachments: 'id, threadId, createdAt',
      skills: 'id, name, enabled, sourceRef',
      memories: 'id, key, updatedAt',
      runs: 'id, threadId, [threadId+state], submissionId, updatedAt',
      commandReceipts: 'id, [clientId+submissionId], status, createdAt, expiresAt',
      approvals: 'id, threadId, runId, [threadId+status], requestedAt',
      plugins: 'id, name, enabled, updatedAt',
      pluginAssets: 'id, pluginId, [pluginId+path], kind, createdAt',
    });
    this.version(2).stores({
      skills: 'id, name, enabled, sourceRef',
    });
    this.version(3).stores({
      maintenance: 'id, operationId, committedAt',
    });
    this.version(4).stores({
      interactions: 'id, threadId, runId, [threadId+status], requestedAt',
    });
  }
}
