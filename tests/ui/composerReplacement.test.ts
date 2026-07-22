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

import type { AgentEvent, Op, PendingApproval } from '../../src/messaging/protocol';
import type { EngineTransport } from '../../src/messaging/transport';
import { ThreadView } from '../../src/ui/components/ThreadView';
import { EngineSession } from '../../src/ui/engineClient';
import { setLang } from '../../src/ui/i18n';

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

const approval: PendingApproval = {
  approvalId: 'approval-1',
  turnId: 'turn-1',
  requestedAt: 1,
  request: {
    tool: 'page.click',
    label: 'Click checkout',
    params: { ref: 's1_2' },
    targetOrigin: 'https://example.com',
    flags: [],
  },
};

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
  session.store.setState({
    threadId: 'thread-a',
    liveItems: [
      {
        itemId: 'message-1',
        kind: 'assistant_message',
        meta: {},
        text: 'Existing answer',
        reasoning: '',
        status: 'ok',
      },
    ],
  });
});

afterEach(async () => {
  await act(async () => {
    session.stop();
    root.unmount();
  });
  container.remove();
  setLang('zh-CN');
});

describe('composer replacement', () => {
  it('replaces the composer with the approval action bar', async () => {
    session.store.setState({ pendingApprovals: [approval] });
    await render(true);

    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[data-approval-focus-target="true"]')?.textContent).toContain(
      'Click checkout',
    );
  });

  it('replaces chat controls with an add-model action when no model is configured', async () => {
    const onOpenSettings = vi.fn();
    await render(false, onOpenSettings);

    expect(container.querySelector('textarea')).toBeNull();
    const addModel = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add model'),
    )!;
    expect(addModel).toBeDefined();
    await act(async () => addModel.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });
});

async function render(providerConfigured: boolean, onOpenSettings = vi.fn()): Promise<void> {
  await act(async () => {
    root.render(
      createElement(ThreadView, {
        session,
        providerConfigured,
        onOpenSettings,
        modelSelectorInComposer: false,
      }),
    );
  });
}
