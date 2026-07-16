// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillVariableForm } from '../../src/ui/components/SkillVariableForm';
import type { SkillCommand } from '../../src/ui/components/composerTriggers';

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
});

describe('SkillVariableForm', () => {
  it('reinitializes values when command identity changes even if variable keys are reused', async () => {
    const first = command('/first', 'First default');
    const second = command('/second', 'Second default');
    const props = { onClose: vi.fn(), onSubmit: vi.fn() };

    await act(async () =>
      root.render(createElement(SkillVariableForm, { ...props, command: first })),
    );
    const firstInput = document.querySelector<HTMLInputElement>('#var-topic');
    expect(firstInput?.value).toBe('First default');
    if (!firstInput) throw new Error('Expected skill variable input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      firstInput,
      'Local edit',
    );
    await act(async () => firstInput.dispatchEvent(new Event('input', { bubbles: true })));

    await act(async () =>
      root.render(createElement(SkillVariableForm, { ...props, command: second })),
    );

    expect(document.querySelector<HTMLInputElement>('#var-topic')?.value).toBe('Second default');
    expect(document.body.textContent).toContain('/second');
    expect(document.body.textContent).not.toContain('/first');
  });
});

function command(name: string, defaultValue: string): SkillCommand {
  return {
    command: name,
    skillName: name,
    description: `${name} description`,
    variables: [
      {
        key: 'topic',
        label: 'Topic',
        type: 'text',
        default: defaultValue,
      },
    ],
  };
}
