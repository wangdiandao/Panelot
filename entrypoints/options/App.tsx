/**
 * Standalone options page — now a thin wrapper over the shared SettingsPanel.
 * The primary settings surface is the in-app modal (SettingsModal); this page
 * remains for chrome://extensions "Options" and deep links.
 */

import { SettingsPanel } from '../../src/ui/settings/SettingsPanel';
import { LazyToaster } from '../../src/ui/components/LazyToaster';
import { useTheme } from '../../src/ui/useTheme';
import { useLanguage } from '../../src/ui/i18n';

export function App() {
  useLanguage();
  useTheme();
  return (
    <div className="h-screen">
      <SettingsPanel />
      <LazyToaster />
    </div>
  );
}
