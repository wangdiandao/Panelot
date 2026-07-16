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

export interface ThreadDraftError {
  phase: 'read' | 'write';
  message: string;
  sequence: number;
}

export interface ThreadDraftStatus {
  error: ThreadDraftError | null;
  stale: boolean;
}

interface KeyedDraftStatus extends ThreadDraftStatus {
  key: string;
}

const EMPTY_DRAFT_STATUS: ThreadDraftStatus = { error: null, stale: false };

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
): [string, (value: string) => void, ThreadDraftStatus] {
  const key = threadDraftKey(threadId);
  const storage = storageOverride === undefined ? availableSessionStorage() : storageOverride;
  const generationRef = useRef(0);
  const operationSequenceRef = useRef(0);
  const latestWriteSequenceRef = useRef(0);
  const writeTailRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const [state, setState] = useState<DraftState>({ key, value: '', loaded: false, dirty: false });
  const [status, setStatus] = useState<KeyedDraftStatus>({
    key,
    error: null,
    stale: false,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    const readSequence = ++operationSequenceRef.current;
    // The storage key is an external identity boundary; reset before hydrating its snapshot.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState({ key, value: '', loaded: storage === null, dirty: false });
    setStatus({ key, error: null, stale: false });
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
        setStatus((current) =>
          current.key === key ? { key, error: null, stale: false } : current,
        );
      })
      .catch((error: unknown) => {
        if (generationRef.current !== generation) return;
        setState((current) =>
          current.key === key && !current.dirty ? { ...current, loaded: true } : current,
        );
        setStatus({
          key,
          error: {
            phase: 'read',
            message: error instanceof Error ? error.message : String(error),
            sequence: readSequence,
          },
          stale: true,
        });
      });

    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [key, storage]);

  useEffect(() => {
    if (!storage || state.key !== key || !state.loaded || !state.dirty) return;
    const sequence = ++operationSequenceRef.current;
    latestWriteSequenceRef.current = sequence;
    const write = () => (state.value ? storage.set({ [key]: state.value }) : storage.remove(key));

    writeTailRef.current = writeTailRef.current.then(write, write).then(
      () => {
        if (!mountedRef.current || latestWriteSequenceRef.current !== sequence) return;
        setStatus((current) =>
          current.key === key ? { key, error: null, stale: false } : current,
        );
      },
      (error: unknown) => {
        if (!mountedRef.current || latestWriteSequenceRef.current !== sequence) return;
        setStatus({
          key,
          error: {
            phase: 'write',
            message: error instanceof Error ? error.message : String(error),
            sequence,
          },
          stale: true,
        });
      },
    );
  }, [key, state, storage]);

  const setDraft = useCallback(
    (value: string) => {
      setState({ key, value, loaded: true, dirty: true });
    },
    [key],
  );

  return [
    state.key === key ? state.value : '',
    setDraft,
    status.key === key ? status : EMPTY_DRAFT_STATUS,
  ];
}
