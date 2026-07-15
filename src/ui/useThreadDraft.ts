import { useCallback, useEffect, useRef, useState } from 'react';

export interface ThreadDraftStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, string>): Promise<void>;
  remove(key: string): Promise<void>;
}

interface DraftState {
  key: string;
  value: string;
  loaded: boolean;
  dirty: boolean;
}

const extensionSessionStorage: ThreadDraftStorage = {
  get: (key) => chrome.storage.session.get(key),
  set: (items) => chrome.storage.session.set(items),
  remove: (key) => chrome.storage.session.remove(key),
};

function availableSessionStorage(): ThreadDraftStorage | null {
  return typeof chrome !== 'undefined' && !!chrome.storage?.session
    ? extensionSessionStorage
    : null;
}

export function threadDraftKey(threadId: string | null): string {
  return `draft:${threadId ?? 'draft'}`;
}

export function useThreadDraft(
  threadId: string | null,
  storageOverride?: ThreadDraftStorage | null,
): [string, (value: string) => void] {
  const key = threadDraftKey(threadId);
  const storage = storageOverride === undefined ? availableSessionStorage() : storageOverride;
  const generationRef = useRef(0);
  const [state, setState] = useState<DraftState>({ key, value: '', loaded: false, dirty: false });

  useEffect(() => {
    const generation = ++generationRef.current;
    setState({ key, value: '', loaded: storage === null, dirty: false });
    if (!storage) return;

    void storage
      .get(key)
      .then((result) => {
        if (generationRef.current !== generation) return;
        setState((current) => {
          if (current.key !== key || current.dirty) return current;
          return {
            key,
            value: typeof result[key] === 'string' ? result[key] : '',
            loaded: true,
            dirty: false,
          };
        });
      })
      .catch(() => {
        if (generationRef.current !== generation) return;
        setState((current) =>
          current.key === key && !current.dirty ? { ...current, loaded: true } : current,
        );
      });

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [key, storage]);

  useEffect(() => {
    if (!storage || state.key !== key || !state.loaded || !state.dirty) return;
    if (state.value) void storage.set({ [key]: state.value }).catch(() => {});
    else void storage.remove(key).catch(() => {});
  }, [key, state, storage]);

  const setDraft = useCallback(
    (value: string) => {
      setState({ key, value, loaded: true, dirty: true });
    },
    [key],
  );

  return [state.key === key ? state.value : '', setDraft];
}
