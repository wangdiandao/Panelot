/**
 * extract oversized-result offload (borrowed from chrome-agent-skill's save_path
 * / browser-use's file_system): text over the threshold is stored as a
 * 'page_text' attachment; only a preview + id reach the model, keeping the full
 * body out of context. The attachment channel is UI-side and never re-fed to
 * the LLM (docs/02 §2.3).
 */
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { createL1Tools } from '../../src/tools/browserTools';
import type { BrowserToolGateway } from '../../src/tools/gateway';
import type { AnyAgentTool } from '../../src/agent/tool';

let n = 0;
let db: PanelotDB;

function makeGateway(resultText: string): BrowserToolGateway {
  return {
    callContentTool: vi.fn(async () => ({ resultText })),
    getTabOrigin: vi.fn(async () => 'https://example.com'),
  } as unknown as BrowserToolGateway;
}

function extractTool(gateway: BrowserToolGateway, withDb: boolean): AnyAgentTool {
  const tools = createL1Tools(gateway, () => 't1', withDb ? { db } : {});
  return tools.find((t) => t.name === 'extract')!;
}

beforeEach(() => {
  db = new PanelotDB(`extract-test-${Date.now()}-${n++}`);
});

describe('extract windowing + oversized-result offload', () => {
  it('offloads the COMPLETE body to a page_text attachment and windows the model view', async () => {
    const big = '甲'.repeat(20_000); // > 8000-char window
    const tool = extractTool(makeGateway(big), true);
    const result = await tool.execute('call1', {}, new AbortController().signal);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/完整正文已存为附件/);
    expect(text).toMatch(/fromChar=8000/); // paging hint
    expect(text.length).toBeLessThan(big.length); // model sees only one window
    const attachmentId = (result.details as { extractionAttachmentId?: string } | undefined)?.extractionAttachmentId;
    expect(attachmentId).toBeTruthy();

    const stored = await db.attachments.get(attachmentId!);
    expect(stored?.kind).toBe('page_text');
    expect(stored?.mime).toBe('text/markdown');
    // The attachment holds the WHOLE body, not the truncated window (honesty).
    expect(await stored!.bytes.text()).toBe(big);
    expect(text).toMatch(/^<<<web_content_/); // fenced as untrusted
  });

  it('fromChar pages to the next window and marks end of content', async () => {
    const big = '乙'.repeat(12_000);
    const tool = extractTool(makeGateway(big), true);
    const second = await tool.execute('call2', { fromChar: 8000 }, new AbortController().signal);
    const text = (second.content[0] as { text: string }).text;
    expect(text).toContain('已到正文结尾');
    expect(text).not.toMatch(/fromChar=/); // no further paging
    // Continuation windows do not re-offload (attachment written on first window only).
    expect(second.details).toBeUndefined();
  });

  it('returns full text inline when it fits in one window', async () => {
    const small = '短内容';
    const tool = extractTool(makeGateway(small), true);
    const result = await tool.execute('call3', {}, new AbortController().signal);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('短内容');
    expect(text).not.toMatch(/存为附件/);
    expect(result.details).toBeUndefined();
    expect(await db.attachments.count()).toBe(0);
  });

  it('still windows when no db is provided (just no attachment)', async () => {
    const big = '丙'.repeat(20_000);
    const tool = extractTool(makeGateway(big), false);
    const result = await tool.execute('call4', {}, new AbortController().signal);
    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(big.length); // still windowed for context
    expect(text).toMatch(/fromChar=8000/);
    expect(text).not.toMatch(/存为附件/); // no attachment without db
    expect(result.details).toBeUndefined();
  });
});
