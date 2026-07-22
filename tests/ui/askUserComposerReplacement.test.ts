// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/ui/pageContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/pageContext')>()),
  listAttachableTabs: vi.fn(() => new Promise<never>(() => {})),
}));

vi.mock('../../src/ui/components/composerTriggers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/components/composerTriggers')>()),
  listSkillCommands: vi.fn(() => new Promise<never>(() => {})),
}));

import { ThreadView } from '../../src/ui/components/ThreadView';
import { EngineSession } from '../../src/ui/engineClient';
import { setLang } from '../../src/ui/i18n';
import type { AgentEvent, Op, PendingInteraction } from '../../src/messaging/protocol';
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
  setLang('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  session = new EngineSession(() => new FakeTransport());
  session.start();
  session.store.setState({ threadId: 'thread-a' });
});

afterEach(async () => {
  await act(async () => {
    session.stop();
    root.unmount();
  });
  container.remove();
  setLang('zh-CN');
});

describe('interaction composer replacement', () => {
  it('replaces the message textarea for ask_user but keeps user_action above it', async () => {
    await renderWithInteraction({
      interactionId: 'ask-1',
      turnId: 'turn-1',
      itemId: 'call-1',
      requestedAt: 1,
      request: {
        kind: 'ask_user',
        questions: [
          {
            id: 'scope',
            question: 'Choose a scope',
            options: [{ value: 'current', label: 'Current workspace' }],
          },
        ],
      },
    });

    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[role="region"]')?.textContent).toContain('Choose a scope');

    await renderWithInteraction({
      interactionId: 'action-1',
      turnId: 'turn-1',
      itemId: 'call-2',
      requestedAt: 2,
      request: { kind: 'user_action', instruction: 'Complete the browser step.' },
    });

    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.textContent).toContain('Complete the browser step.');
  });

  it('replaces the message textarea while waiting for a page change', async () => {
    await renderWithInteraction({
      interactionId: 'watch-1',
      turnId: 'turn-1',
      itemId: 'call-1',
      requestedAt: 1,
      request: {
        kind: 'watch_page',
        tabId: 7,
        condition: { type: 'text', value: 'Ready' },
        deadlineAt: Date.now() + 60_000,
      },
    });

    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[role="region"]')?.textContent).toContain(
      'Waiting for a page change',
    );
    expect(container.textContent).toContain(
      'Panelot will continue when the condition is met or the wait times out.',
    );
  });
});

async function renderWithInteraction(interaction: PendingInteraction): Promise<void> {
  await act(async () => {
    session.store.setState({ pendingInteractions: [interaction] });
    root.render(
      createElement(ThreadView, {
        session,
        providerConfigured: true,
        modelSelectorInComposer: false,
      }),
    );
  });
}
