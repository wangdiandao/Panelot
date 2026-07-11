import type { PanelotDB } from '../db/schema';
import type { Attachment } from '../db/types';

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

interface AttachmentRepositoryOptions {
  now?: () => number;
}

export interface AddUploadInput {
  threadId: string;
  kind: 'image' | 'file';
  mime: string;
  bytes: Blob;
  provenance: NonNullable<Attachment['provenance']>;
  sourceRef?: string;
}

export class AttachmentRepository {
  private readonly now: () => number;

  constructor(
    private readonly db: PanelotDB,
    options: AttachmentRepositoryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async addUpload(input: AddUploadInput): Promise<Attachment> {
    if (input.provenance !== 'user') {
      throw new Error('Uploads require user-provenance attachments.');
    }
    if (input.bytes.size > MAX_UPLOAD_BYTES) {
      throw new Error(`Attachment exceeds the 8 MB upload limit (${input.bytes.size} bytes).`);
    }
    const thread = await this.db.threads.get(input.threadId);
    if (!thread || thread.deleting) throw new Error(`Thread not found: ${input.threadId}`);

    const attachment: Attachment = {
      id: crypto.randomUUID(),
      threadId: input.threadId,
      createdAt: this.now(),
      kind: input.kind,
      mime: input.mime || 'application/octet-stream',
      bytes: input.bytes,
      trust: 'trusted',
      provenance: 'user',
      sourceRef: input.sourceRef,
      meta: input.sourceRef ? { title: input.sourceRef } : undefined,
    };
    await this.db.attachments.add(attachment);
    return attachment;
  }

  async list(): Promise<Attachment[]> {
    return this.db.attachments
      .orderBy('createdAt')
      .reverse()
      .filter((item) => !item.deleting)
      .toArray();
  }

  async remove(id: string): Promise<void> {
    const found = await this.db.transaction(
      'rw',
      [this.db.attachments, this.db.nodes],
      async () => {
        const attachment = await this.db.attachments.get(id);
        if (!attachment) return false;
        for (const nodeId of attachment.refs?.nodeIds ?? []) {
          await this.db.nodes.update(nodeId, { evicted: true });
        }
        await this.db.attachments.update(id, { deleting: true });
        return true;
      },
    );
    if (!found) return;
    await this.db.attachments.delete(id);
  }

  async cleanupIncomplete(): Promise<number> {
    return this.db.transaction('rw', this.db.attachments, async () => {
      const keys = await this.db.attachments.filter((item) => item.deleting === true).primaryKeys();
      await this.db.attachments.bulkDelete(keys as string[]);
      return keys.length;
    });
  }
}
