// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

vi.mock('../../src/ui/pageContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/pageContext')>()),
  listAttachableTabs: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('../../src/ui/components/composerTriggers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/components/composerTriggers')>()),
  listSkillCommands: vi.fn(() => new Promise<never>(() => {})),
}));

import { AttachmentRepository } from '../../src/data/attachments';
import { ThreadView } from '../../src/ui/components/ThreadView';
import { EngineSession } from '../../src/ui/engineClient';
import { setLang } from '../../src/ui/i18n';
import type { AgentEvent, ContextBlock, Op } from '../../src/messaging/protocol';
import type { EngineTransport } from '../../src/messaging/transport';

class FakeTransport implements EngineTransport {
  send(_op: Op): void {}
  onEvent(_handler: (event: AgentEvent) => void): () => void {
    return () => {};
  }
  onDisconnect(_handler: () => void): () => void {
    return () => {};
  }
  close(): void {}
}

let root: Root;
let container: HTMLDivElement;
let session: EngineSession;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  session = new EngineSession(() => new FakeTransport());
  session.start();
  session.startDraft();
});

afterEach(async () => {
  await act(async () => {
    session.stop();
    root.unmount();
  });
  container.remove();
  setLang('en');
  vi.restoreAllMocks();
});

describe('new-chat attachment contract shared by Chat and Side Panel', () => {
  for (const [language, addLabel, uploadLabel, message] of [
    ['zh-CN', '添加', '上传文件', '请先发送一条消息创建会话，再上传文件。'],
    ['en', 'Add', 'Upload file', 'Send a message to create the chat before uploading a file.'],
  ] as const) {
    it(`does not open a chooser or write attachment data in ${language}`, async () => {
      setLang(language);
      const addUpload = vi.spyOn(AttachmentRepository.prototype, 'addUpload');
      const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click');
      const info = vi.spyOn(toast, 'info').mockImplementation(() => 'toast-id');

      await renderThreadView(vi.fn());
      await openAttachmentMenu(addLabel);
      const upload = findMenuItem(uploadLabel);
      expect(upload).toBeTruthy();

      await act(async () => upload?.click());

      expect(info).toHaveBeenCalledWith(message);
      expect(inputClick).not.toHaveBeenCalled();
      expect(addUpload).not.toHaveBeenCalled();
      expect(container.querySelectorAll('[data-attachment-chip]')).toHaveLength(0);
    });
  }

  it('keeps file persistence and chip staging available for an existing thread', async () => {
    setLang('en');
    session.store.setState({ threadId: 'thread-a' });
    const onAttachContext = vi.fn();
    const addUpload = vi.spyOn(AttachmentRepository.prototype, 'addUpload').mockResolvedValue({
      id: 'attachment-a',
      threadId: 'thread-a',
      createdAt: 1,
      kind: 'file',
      mime: 'text/plain',
      bytes: new Blob(['hello']),
      provenance: 'user',
    });
    const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click');

    await renderThreadView(onAttachContext);
    await openAttachmentMenu('Add');
    await act(async () => findMenuItem('Upload file')?.click());
    expect(inputClick).toHaveBeenCalledTimes(1);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    expect(addUpload).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-a', sourceRef: 'notes.txt' }),
    );
    expect(onAttachContext).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRef: 'attachment-a', label: 'notes.txt' }),
    );
  });
});

async function renderThreadView(onAttachContext: (block: ContextBlock) => void): Promise<void> {
  await act(async () =>
    root.render(
      createElement(ThreadView, {
        session,
        providerConfigured: true,
        stagedContext: [],
        onAttachContext,
        onRemoveStagedContext: vi.fn(),
        modelSelectorInComposer: false,
      }),
    ),
  );
}

async function openAttachmentMenu(label: string): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  expect(trigger).toBeTruthy();
  await act(async () => {
    trigger?.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        pointerType: 'mouse',
      }),
    );
    await Promise.resolve();
  });
}

function findMenuItem(text: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
    item.textContent?.includes(text),
  );
}
