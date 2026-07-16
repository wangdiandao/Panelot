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

  it('associates MCP JSON instructions and validation errors with the input', async () => {
    const interaction: PendingInteraction = {
      interactionId: 'interaction-mcp',
      turnId: 'turn-mcp',
      itemId: 'call-mcp',
      requestedAt: 1,
      request: {
        kind: 'mcp_elicitation',
        serverId: 'calendar',
        message: 'Provide a structured date range.',
        requestedSchema: { type: 'object' },
      },
    };
    await act(async () =>
      root.render(createElement(InteractionCard, { interaction, onResponse: vi.fn() })),
    );

    const textarea = container.querySelector('textarea');
    expect(textarea?.labels?.[0]?.textContent).toContain('JSON');
    expect(textarea?.getAttribute('aria-describedby')).toBe(
      'interaction-mcp-structured-description',
    );

    if (!textarea) throw new Error('Expected structured response textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      textarea,
      '{',
    );
    await act(async () => textarea.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => findButton('Submit').click());

    expect(textarea.getAttribute('aria-invalid')).toBe('true');
    expect(textarea.getAttribute('aria-describedby')).toBe(
      'interaction-mcp-structured-description interaction-mcp-structured-error',
    );
    expect(container.querySelector('#interaction-mcp-structured-error')?.textContent).toContain(
      'valid JSON',
    );
  });

  it('resets MCP JSON state when a new interaction replaces the previous request', async () => {
    const onResponse = vi.fn();
    const interaction = mcpInteraction('interaction-mcp-first', 'First request');
    await act(async () => root.render(createElement(InteractionCard, { interaction, onResponse })));

    const firstTextarea = container.querySelector('textarea');
    if (!firstTextarea) throw new Error('Expected structured response textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      firstTextarea,
      '{',
    );
    await act(async () => firstTextarea.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => findButton('Submit').click());
    expect(firstTextarea.getAttribute('aria-invalid')).toBe('true');

    const nextInteraction = mcpInteraction('interaction-mcp-next', 'Next request');
    await act(async () =>
      root.render(createElement(InteractionCard, { interaction: nextInteraction, onResponse })),
    );

    const nextTextarea = container.querySelector('textarea');
    expect(nextTextarea?.value).toBe('{}');
    expect(nextTextarea?.getAttribute('aria-invalid')).toBe('false');
    expect(nextTextarea?.getAttribute('aria-describedby')).toBe(
      'interaction-mcp-next-structured-description',
    );
    expect(container.querySelector('#interaction-mcp-first-structured-error')).toBeNull();
  });
});

function mcpInteraction(interactionId: string, message: string): PendingInteraction {
  return {
    interactionId,
    turnId: `turn-${interactionId}`,
    itemId: `call-${interactionId}`,
    requestedAt: 1,
    request: {
      kind: 'mcp_elicitation',
      serverId: 'calendar',
      message,
      requestedSchema: { type: 'object' },
    },
  };
}

function findButton(text: string): HTMLButtonElement {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text),
  )!;
}
