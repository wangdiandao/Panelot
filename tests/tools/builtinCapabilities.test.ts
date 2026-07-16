import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { ThreadTree } from '../../src/db/tree';
import { createArtifactTool } from '../../src/tools/builtinTools';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('built-in artifact capability', () => {
  it('stores generated text as a trusted thread attachment before downloading it', async () => {
    const db = new PanelotDB(`artifact-tool-${Date.now()}`);
    const thread = await new ThreadTree(db).createThread({ title: 'artifact' });
    const download = vi.fn(async () => 17);
    vi.stubGlobal('chrome', { downloads: { download } });
    const tool = createArtifactTool(db, () => thread.id);

    const result = await tool.execute(
      'call-1',
      { filename: 'result.md', mime: 'text/markdown', content: '# Result' },
      new AbortController().signal,
    );

    const [attachment] = await db.attachments.where('threadId').equals(thread.id).toArray();
    expect(attachment).toMatchObject({
      kind: 'file',
      mime: 'text/markdown',
      trust: 'trusted',
      provenance: 'tool',
      sourceRef: 'result.md',
    });
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: 'result.md', saveAs: false }),
    );
    expect(result.details).toMatchObject({
      artifactAttachmentId: attachment?.id,
      filename: 'result.md',
      downloadId: 17,
    });
  });
});
