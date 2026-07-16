// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingInteraction } from '../../src/messaging/protocol';
import { InteractionCard } from '../../src/ui/components/InteractionCard';
import { setLang } from '../../src/ui/i18n';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  setLang('en');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setLang('zh-CN');
});

describe('InteractionCard', () => {
  it('submits a structured answer from an offered option', async () => {
    const interaction: PendingInteraction = {
      interactionId: 'interaction-1',
      turnId: 'turn-1',
      itemId: 'call-1',
      requestedAt: 1,
      request: {
        kind: 'ask_user',
        questions: [
          {
            id: 'layout',
            question: 'Which layout?',
            options: [
              { value: 'compact', label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
            ],
          },
        ],
      },
    };
    const onResponse = vi.fn();
    await act(async () => root.render(createElement(InteractionCard, { interaction, onResponse })));

    const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
    const compact = buttons.find((button) => button.textContent?.includes('Compact'))!;
    await act(async () => compact.click());

    expect(onResponse).toHaveBeenCalledWith('interaction-1', {
      kind: 'submit',
      value: { answers: [{ id: 'layout', value: 'compact', source: 'option' }] },
    });
  });

  it('advances through multiple questions before submitting', async () => {
    const interaction: PendingInteraction = {
      interactionId: 'interaction-multiple',
      turnId: 'turn-1',
      itemId: 'call-1',
      requestedAt: 1,
      request: {
        kind: 'ask_user',
        questions: [
          {
            id: 'layout',
            question: 'Which layout?',
            options: [{ value: 'compact', label: 'Compact (Recommended)' }],
          },
          {
            id: 'scope',
            question: 'Apply it where?',
            options: [{ value: 'all', label: 'All workspaces' }],
          },
        ],
      },
    };
    const onResponse = vi.fn();
    await act(async () => root.render(createElement(InteractionCard, { interaction, onResponse })));

    expect(container.textContent).toContain('Which layout?');
    expect(container.textContent).toContain('Recommended');
    await act(async () => findButton('Compact').click());
    expect(onResponse).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Apply it where?');
    await act(async () => findButton('All workspaces').click());

    expect(onResponse).toHaveBeenCalledWith('interaction-multiple', {
      kind: 'submit',
      value: {
        answers: [
          { id: 'layout', value: 'compact', source: 'option' },
          { id: 'scope', value: 'all', source: 'option' },
        ],
      },
    });
  });

  it('cancels the request when skipped', async () => {
    const interaction: PendingInteraction = {
      interactionId: 'interaction-skip',
      turnId: 'turn-1',
      itemId: 'call-1',
      requestedAt: 1,
      request: {
        kind: 'ask_user',
        questions: [{ id: 'answer', question: 'Continue?' }],
      },
    };
    const onResponse = vi.fn();
    await act(async () => root.render(createElement(InteractionCard, { interaction, onResponse })));

    await act(async () => findButton('Skip').click());
    expect(onResponse).toHaveBeenCalledWith('interaction-skip', { kind: 'cancel' });
  });

  it('returns only a completion marker for user handoff', async () => {
    const interaction: PendingInteraction = {
      interactionId: 'interaction-2',
      turnId: 'turn-2',
      itemId: 'call-2',
      requestedAt: 1,
      request: { kind: 'user_action', instruction: 'Complete the verification.' },
    };
    const onResponse = vi.fn();
    await act(async () => root.render(createElement(InteractionCard, { interaction, onResponse })));

    const complete = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'I completed it',
    )!;
    await act(async () => complete.click());

    expect(onResponse).toHaveBeenCalledWith('interaction-2', {
      kind: 'submit',
      value: { completed: true },
    });
  });
});

function findButton(text: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text),
  )!;
}
