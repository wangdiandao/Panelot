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

describe('ask_user composer replacement', () => {
  it('replaces the message textarea only for ask_user', async () => {
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
