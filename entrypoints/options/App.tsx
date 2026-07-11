/**
 * Standalone options page — now a thin wrapper over the shared SettingsPanel.
 * The primary settings surface is the in-app modal (SettingsModal); this page
 * remains for chrome://extensions "Options" and deep links.
 */

import { SettingsPanel } from '../../src/ui/settings/SettingsPanel';
import { LazyToaster } from '../../src/ui/components/LazyToaster';
import { useTheme } from '../../src/ui/useTheme';

export function App() {
  useTheme();
  return (
    <div className="h-screen">
      <SettingsPanel />
      <LazyToaster />
    </div>
  );
}
