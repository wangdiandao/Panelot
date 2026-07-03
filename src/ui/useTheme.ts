/**
 * Theme applier: reads the global theme setting (system/dark/light) and
 * toggles the `.dark` class on <html> (shadcn/ui convention), tracking OS
 * changes when in system mode.
 */

import { useEffect } from 'react';
import { SettingsStore } from '../settings/store';

type Theme = 'system' | 'dark' | 'light';

function apply(theme: Theme): void {
  const resolved = theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

export function useTheme(): void {
  useEffect(() => {
    let current: Theme = 'system';
    const mq = matchMedia('(prefers-color-scheme: light)');
    const onSystemChange = () => current === 'system' && apply('system');

    void SettingsStore.global.get().then((s) => {
      current = (s.theme as Theme) ?? 'system';
      apply(current);
    });

    mq.addEventListener('change', onSystemChange);

    // React to setting changes across the extension (chrome.storage events).
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes.global_settings) return;
      const next = (changes.global_settings.newValue as { theme?: Theme } | undefined)?.theme ?? 'system';
      current = next;
      apply(next);
    };
    chrome.storage?.onChanged?.addListener(onStorage);

    return () => {
      mq.removeEventListener('change', onSystemChange);
      chrome.storage?.onChanged?.removeListener(onStorage);
    };
  }, []);
}
