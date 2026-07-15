import { afterEach, describe, expect, it, vi } from 'vitest';
import { storageGet, storagePatch, storageSet, storageUpdate } from '../../src/settings/store';
import {
  getStorageExternalStore,
  resetStorageExternalStoresForTests,
} from '../../src/ui/useStorageValue';

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

afterEach(() => {
  resetStorageExternalStoresForTests();
  vi.unstubAllGlobals();
});

describe('StorageExternalStore', () => {
  it('does not let an older hydration read overwrite a newer storage event', async () => {
    const hydration = deferred<Record<string, unknown>>();
    let storageListener: (
      changes: Record<string, chrome.storage.StorageChange>,
      areaName: string,
    ) => void = () => {};
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn(() => hydration.promise) },
        onChanged: {
          addListener: vi.fn((listener) => {
            storageListener = listener;
          }),
          removeListener: vi.fn(),
        },
      },
    });

    const store = getStorageExternalStore<{ theme: string } | null>('global_settings', null);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    storageListener(
      { global_settings: { oldValue: undefined, newValue: { theme: 'dark' } } },
      'local',
    );
    expect(store.getSnapshot()).toEqual({ theme: 'dark' });

    hydration.resolve({ global_settings: { theme: 'light' } });
    await hydration.promise;
    await Promise.resolve();

    expect(store.getSnapshot()).toEqual({ theme: 'dark' });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});

describe('storage updates', () => {
  it('serializes field patches so concurrent writers do not lose each other', async () => {
    vi.stubGlobal('chrome', undefined);
    const key = `settings-race:${crypto.randomUUID()}`;
    const firstMutation = deferred<void>();
    await storageSet(key, { language: 'en', theme: 'system' });

    const languageWrite = storageUpdate(key, {}, async (current: Record<string, string>) => {
      await firstMutation.promise;
      return { ...current, language: 'zh-CN' };
    });
    const themeWrite = storagePatch(key, {}, { theme: 'dark' });

    firstMutation.resolve();
    await Promise.all([languageWrite, themeWrite]);

    await expect(storageGet(key, {})).resolves.toEqual({ language: 'zh-CN', theme: 'dark' });
  });
});
