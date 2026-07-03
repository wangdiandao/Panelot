import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See DESIGN.md §11 for the permission rationale. All host permissions are
// requested dynamically at runtime (chrome.permissions.request).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: 'dist',
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Panelot',
    description:
      'Browser-native AI agent — bring your own model, operate the web, extend with Skills & MCP.',
    permissions: [
      'sidePanel',
      'storage',
      'unlimitedStorage',
      'tabs',
      'scripting',
      'activeTab',
      'alarms',
      'contextMenus',
      'debugger',
      'downloads',
      'identity',
      'clipboardWrite',
      'notifications',
    ],
    optional_host_permissions: ['<all_urls>'],
    host_permissions: [],
    action: { default_title: 'Panelot' },
    commands: {
      'toggle-sidepanel': {
        suggested_key: { default: 'Alt+P' },
        description: 'Open/close the Panelot side panel',
      },
    },
    minimum_chrome_version: '116',
  },
});
