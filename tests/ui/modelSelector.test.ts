// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from '../../src/providers/types';
import { setLang, t } from '../../src/ui/i18n';

const storageMocks = vi.hoisted(() => ({
  connections: [] as Connection[],
}));

vi.mock('../../src/settings/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/settings/store')>()),
  storageGet: vi.fn((key: string, fallback: unknown) =>
    Promise.resolve(key === 'connections' ? storageMocks.connections : fallback),
  ),
  onStorageChange: vi.fn(() => () => {}),
}));

import { ModelSelector } from '../../src/ui/components/ModelSelector';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  setLang('zh-CN');
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  storageMocks.connections = [
    {
      id: 'connection-a',
      name: 'Provider A',
      kind: 'openai',
      baseUrl: 'https://example.com/v1',
      apiKeys: [],
      modelIds: ['model-a', 'model-b'],
      enabled: true,
    },
  ];
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openSelector(): Promise<void> {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  if (!trigger) throw new Error('Model selector trigger not found');
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('ModelSelector default-model contract', () => {
  it('selects a concrete model and omits the inherited-default option when required', async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        createElement(ModelSelector, {
          value: null,
          onSelect,
          allowDefaultSelection: false,
        }),
      ),
    );
    await flush();

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'connection-a', modelId: 'model-a' }),
    );

    await openSelector();
    await flush();

    expect(document.body.querySelector('[cmdk-item][data-value="__default__"]')).toBeNull();
    expect(document.body.textContent).not.toContain(t('model.defaultHint'));
  });

  it('keeps the inherited-default option for conversation selectors', async () => {
    await act(async () =>
      root.render(createElement(ModelSelector, { value: null, onSelect: vi.fn() })),
    );

    await openSelector();
    await flush();

    expect(document.body.textContent).toContain(t('model.defaultHint'));
  });

  it('replaces a stored model that is no longer available', async () => {
    const onSelect = vi.fn();
    await act(async () =>
      root.render(
        createElement(ModelSelector, {
          value: { connectionId: 'connection-a', modelId: 'removed-model' },
          onSelect,
          allowDefaultSelection: false,
        }),
      ),
    );
    await flush();

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'connection-a', modelId: 'model-a' }),
    );
  });
});
