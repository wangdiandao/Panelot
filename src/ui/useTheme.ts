/**
 * Theme applier: reads the global theme setting (system/dark/light) and
 * toggles the `.dark` class on <html> (shadcn/ui convention), tracking OS
 * changes when in system mode.
 */

import { useEffect } from 'react';
import type { GlobalSettings } from '../settings/store';
import { useStorageValue } from './useStorageValue';

type Theme = 'system' | 'dark' | 'light';

function apply(theme: Theme): void {
  const resolved =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

export function useTheme(): void {
  const settings = useStorageValue<GlobalSettings | null>('global_settings', null);
  const theme = (settings?.theme as Theme) ?? 'system';

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: light)');
    const onSystemChange = () => theme === 'system' && apply('system');

    apply(theme);
    mq.addEventListener('change', onSystemChange);

    return () => {
      mq.removeEventListener('change', onSystemChange);
    };
  }, [theme]);
}
