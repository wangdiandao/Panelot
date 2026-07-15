// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadDraft, type ThreadDraftStorage } from '../../src/ui/useThreadDraft';

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

function Harness({
  threadId,
  storage,
  editValue,
}: {
  threadId: string | null;
  storage: ThreadDraftStorage;
  editValue: string;
}) {
  const [draft, setDraft] = useThreadDraft(threadId, storage);
  return createElement('button', {
    'data-draft': draft,
    onClick: () => setDraft(editValue),
  });
}

function currentDraft(): string {
  return container.querySelector('button')?.dataset.draft ?? '';
}

async function editDraft(): Promise<void> {
  await act(async () =>
    container.querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
}

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
  vi.restoreAllMocks();
});

describe('useThreadDraft', () => {
  it('ignores an older thread read that resolves after the current thread', async () => {
    const reads = new Map<string, Deferred<Record<string, unknown>>>();
    const storage: ThreadDraftStorage = {
      get: vi.fn((key) => {
        const read = deferred<Record<string, unknown>>();
        reads.set(key, read);
        return read.promise;
      }),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };

    await act(async () =>
      root.render(createElement(Harness, { threadId: 'a', storage, editValue: '' })),
    );
    await act(async () =>
      root.render(createElement(Harness, { threadId: 'b', storage, editValue: '' })),
    );
    expect(currentDraft()).toBe('');

    await act(async () => reads.get('draft:b')!.resolve({ 'draft:b': 'draft B' }));
    expect(currentDraft()).toBe('draft B');

    await act(async () => reads.get('draft:a')!.resolve({ 'draft:a': 'stale A' }));
    expect(currentDraft()).toBe('draft B');
  });

  it('does not write the previous thread draft into a new key before hydration', async () => {
    const reads = new Map<string, Deferred<Record<string, unknown>>>();
    const set = vi.fn(async (_items: Record<string, string>) => {});
    const storage: ThreadDraftStorage = {
      get: vi.fn((key) => {
        const read = deferred<Record<string, unknown>>();
        reads.set(key, read);
        return read.promise;
      }),
      set,
      remove: vi.fn(async () => {}),
    };

    await act(async () =>
      root.render(createElement(Harness, { threadId: 'a', storage, editValue: 'edited A' })),
    );
    await act(async () => reads.get('draft:a')!.resolve({ 'draft:a': 'draft A' }));
    await editDraft();
    expect(set).toHaveBeenCalledWith({ 'draft:a': 'edited A' });
    set.mockClear();

    await act(async () =>
      root.render(createElement(Harness, { threadId: 'b', storage, editValue: '' })),
    );
    expect(currentDraft()).toBe('');
    expect(set).not.toHaveBeenCalled();

    await act(async () => reads.get('draft:b')!.resolve({ 'draft:b': 'draft B' }));
    expect(currentDraft()).toBe('draft B');
    expect(set).not.toHaveBeenCalledWith({ 'draft:b': 'edited A' });
  });

  it('keeps a local edit made before the storage read resolves', async () => {
    const read = deferred<Record<string, unknown>>();
    const storage: ThreadDraftStorage = {
      get: vi.fn(() => read.promise),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };

    await act(async () =>
      root.render(createElement(Harness, { threadId: 'a', storage, editValue: 'new local text' })),
    );
    await editDraft();
    await act(async () => read.resolve({ 'draft:a': 'old stored text' }));

    expect(currentDraft()).toBe('new local text');
  });
});
