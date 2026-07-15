// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const composerMocks = vi.hoisted(() => ({ evaluateVariables: vi.fn() }));

vi.mock('../../src/ui/components/composerTriggers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/components/composerTriggers')>()),
  evaluateVariables: composerMocks.evaluateVariables,
}));

import { PromptInput } from '../../src/ui/components/PromptInput';
import { ThreadView } from '../../src/ui/components/ThreadView';
import { EngineSession } from '../../src/ui/engineClient';
import type { AgentEvent, ContextBlock, Op } from '../../src/messaging/protocol';
import type { EngineTransport } from '../../src/messaging/transport';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function typeAndSubmit(value: string): Promise<void> {
  const textarea = container.querySelector('textarea')!;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
    textarea,
    value,
  );
  await act(async () => {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
  });
}

describe('PromptInput submission ordering', () => {
  it('dispatches variable expansion in FIFO order even when an earlier read is slow', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    composerMocks.evaluateVariables
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onSend = vi.fn(() => true);

    await act(async () =>
      root.render(
        createElement(PromptInput, {
          running: false,
          steerable: false,
          contextChips: [],
          submissionThreadId: 'thread-a',
          onRemoveChip: vi.fn(),
          onSend,
          onEnqueue: vi.fn(() => true),
          onStop: vi.fn(),
        }),
      ),
    );

    await typeAndSubmit('first {{CURRENT_DATE}}');
    await typeAndSubmit('second {{CURRENT_DATE}}');

    expect(composerMocks.evaluateVariables).toHaveBeenCalledTimes(1);
    expect(composerMocks.evaluateVariables).toHaveBeenNthCalledWith(
      1,
      'first {{CURRENT_DATE}}',
      expect.objectContaining({ referencedTabs: [] }),
    );
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve('resolved first');
      await first.promise;
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenNthCalledWith(
      1,
      'resolved first',
      'thread-a',
      expect.objectContaining({ referencedTabs: [] }),
    );
    expect(composerMocks.evaluateVariables).toHaveBeenNthCalledWith(
      2,
      'second {{CURRENT_DATE}}',
      expect.objectContaining({ referencedTabs: [] }),
    );

    await act(async () => {
      second.resolve('resolved second');
      await second.promise;
      await Promise.resolve();
    });
    expect(onSend.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      ['resolved first', 'thread-a'],
      ['resolved second', 'thread-a'],
    ]);
  });

  it('rejects a resolved submission after switching threads without misrouting its context', async () => {
    class FakeTransport implements EngineTransport {
      sent: Op[] = [];
      send(op: Op): void {
        this.sent.push(op);
      }
      onEvent(_handler: (event: AgentEvent) => void): () => void {
        return () => {};
      }
      onDisconnect(_handler: () => void): () => void {
        return () => {};
      }
      close(): void {}
    }

    const expansion = deferred<string>();
    composerMocks.evaluateVariables.mockReturnValueOnce(expansion.promise);
    const transport = new FakeTransport();
    const session = new EngineSession(() => transport);
    session.start();
    session.store.setState({ threadId: 'thread-a' });
    const submit = vi.spyOn(session, 'submit');
    const removeContext = vi.fn();
    const contexts: ContextBlock[] = [
      {
        kind: 'file',
        label: 'notes.txt',
        provenance: 'user',
        sourceRef: 'attachment-a',
        content: [{ type: 'text', text: 'attachment metadata' }],
      },
      {
        kind: 'page',
        label: 'Thread A page',
        provenance: 'page',
        sourceRef: 'https://a.example/source',
        tab: { tabId: 41, url: 'https://a.example/source', title: 'Thread A page' },
        content: [{ type: 'text', text: 'referenced page' }],
      },
    ];

    await act(async () =>
      root.render(
        createElement(ThreadView, {
          session,
          providerConfigured: true,
          stagedContext: contexts,
          onRemoveStagedContext: removeContext,
          modelSelectorInComposer: false,
        }),
      ),
    );

    await typeAndSubmit('question {{CURRENT_DATE}}');
    await act(async () => session.openThread('thread-b'));
    await act(async () => {
      expansion.resolve('resolved question');
      await expansion.promise;
      await Promise.resolve();
    });

    expect(submit).toHaveBeenCalledWith(
      {
        text: 'resolved question',
        attachmentIds: ['attachment-a'],
        attachedContext: contexts,
        browserContext: expect.objectContaining({
          defaultTab: { tabId: 41, url: 'https://a.example/source', title: 'Thread A page' },
          referencedTabs: [{ tabId: 41, url: 'https://a.example/source', title: 'Thread A page' }],
        }),
      },
      { expectedThreadId: 'thread-a' },
    );
    expect(transport.sent.filter((op) => op.type.startsWith('turn.'))).toEqual([]);
    expect(session.store.getState().threadId).toBe('thread-b');
    expect(session.store.getState().liveItems).toEqual([]);
    expect(removeContext).not.toHaveBeenCalled();
    session.stop();
  });
});
