import { useSyncExternalStore } from 'react';
import { onStorageChange, storageGet } from '../settings/store';

type Listener = () => void;

export class StorageExternalStore<T> {
  private snapshot: T;
  private hydrated = false;
  private readonly listeners = new Set<Listener>();
  private stopStorageListener: (() => void) | null = null;
  private lifecycle = 0;
  private storageRevision = 0;

  constructor(
    private readonly key: string,
    private readonly fallback: T,
  ) {
    this.snapshot = fallback;
  }

  getSnapshot = (): T => this.snapshot;

  getHydratedSnapshot = (): boolean => this.hydrated;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stop();
    };
  };

  private publish(value: T): void {
    this.snapshot = value;
    this.hydrated = true;
    for (const listener of this.listeners) listener();
  }

  private start(): void {
    const lifecycle = ++this.lifecycle;
    this.stopStorageListener = onStorageChange(this.key, (value) => {
      if (lifecycle !== this.lifecycle) return;
      this.storageRevision += 1;
      this.publish(value === undefined ? this.fallback : (value as T));
    });
    const readRevision = this.storageRevision;
    void storageGet(this.key, this.fallback).then(
      (value) => {
        if (lifecycle !== this.lifecycle || readRevision !== this.storageRevision) return;
        this.publish(value);
      },
      () => undefined,
    );
  }

  private stop(): void {
    this.lifecycle += 1;
    this.stopStorageListener?.();
    this.stopStorageListener = null;
  }
}

const stores = new Map<string, StorageExternalStore<unknown>>();

export function getStorageExternalStore<T>(key: string, fallback: T): StorageExternalStore<T> {
  let store = stores.get(key);
  if (!store) {
    store = new StorageExternalStore(key, fallback);
    stores.set(key, store);
  }
  return store as StorageExternalStore<T>;
}

export function useStorageValue<T>(key: string, fallback: T): T {
  const store = getStorageExternalStore(key, fallback);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useStorageValueState<T>(key: string, fallback: T): { value: T; hydrated: boolean } {
  const store = getStorageExternalStore(key, fallback);
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const hydrated = useSyncExternalStore(
    store.subscribe,
    store.getHydratedSnapshot,
    store.getHydratedSnapshot,
  );
  return { value, hydrated };
}

export function resetStorageExternalStoresForTests(): void {
  stores.clear();
}
