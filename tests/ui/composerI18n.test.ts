// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const composerMocks = vi.hoisted(() => ({
  listAttachableTabs: vi.fn(async () => []),
  listSkillCommands: vi.fn(async () => []),
}));

vi.mock('../../src/ui/pageContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/pageContext')>()),
  listAttachableTabs: composerMocks.listAttachableTabs,
}));

vi.mock('../../src/ui/components/composerTriggers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/components/composerTriggers')>()),
  listSkillCommands: composerMocks.listSkillCommands,
}));

import { PromptInput } from '../../src/ui/components/PromptInput';
import { TriggerMenu } from '../../src/ui/components/TriggerMenu';
import { setLang } from '../../src/ui/i18n';

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
  setLang('en');
  vi.clearAllMocks();
});

describe('composer i18n contract', () => {
  it('renders the trigger-menu empty state in English', async () => {
    setLang('en');

    await act(async () =>
      root.render(
        createElement(TriggerMenu, {
          open: true,
          items: [],
          query: 'missing',
          onClose: vi.fn(),
        }),
      ),
    );

    expect(document.body.textContent).toContain('No results');
  });

  it('renders the attachment actions in Chinese', async () => {
    setLang('zh-CN');

    await act(async () =>
      root.render(
        createElement(PromptInput, {
          running: false,
          steerable: false,
          contextChips: [],
          submissionThreadId: 'thread-a',
          onRemoveChip: vi.fn(),
          onAttachContext: vi.fn(),
          onAttachFile: vi.fn(async () => null),
          onSend: vi.fn(() => true),
          onEnqueue: vi.fn(() => true),
          onStop: vi.fn(),
        }),
      ),
    );

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    expect(trigger?.getAttribute('aria-label')).toBe('添加');

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

    expect(document.body.textContent).toContain('上传文件');
    expect(document.body.textContent).toContain('技能');
  });
});
