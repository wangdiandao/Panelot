import type { ToolResult } from '../agent/tool';
import type { PanelotDB } from '../db/schema';

export async function createArtifact(
  db: PanelotDB,
  threadId: string,
  params: { filename: string; mime?: string; content: string },
): Promise<ToolResult> {
  const thread = await db.threads.get(threadId);
  if (!thread || thread.deleting) throw new Error(`Thread not found: ${threadId}`);
  const mime = params.mime || 'text/plain';
  const bytes = new TextEncoder().encode(params.content);
  const attachmentId = crypto.randomUUID();
  await db.attachments.add({
    id: attachmentId,
    threadId,
    createdAt: Date.now(),
    kind: 'file',
    mime,
    bytes: new Blob([bytes], { type: mime }),
    trust: 'trusted',
    provenance: 'tool',
    sourceRef: params.filename,
    meta: { title: params.filename },
  });
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const downloadId = await chrome.downloads.download({
    url: `data:${mime};base64,${btoa(binary)}`,
    filename: params.filename,
    saveAs: false,
  });
  return {
    content: [
      {
        type: 'text',
        text: `Created ${params.filename} (${bytes.length} bytes), attachment ${attachmentId}, download #${downloadId}.`,
      },
    ],
    details: { artifactAttachmentId: attachmentId, filename: params.filename, mime, downloadId },
  };
}
