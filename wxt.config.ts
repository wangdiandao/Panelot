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
      'favicon',
      'identity',
      'clipboardWrite',
      'notifications',
    ],
    optional_host_permissions: ['<all_urls>'],
    host_permissions: [],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    action: {
      default_title: 'Panelot',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    commands: {
      // Reserved command = "press the toolbar icon". With openPanelOnActionClick
      // the browser opens/closes the side panel NATIVELY — no JS, no user-gesture
      // pitfalls (sidePanel.open() silently fails after an awaited promise).
      _execute_action: {
        suggested_key: { default: 'Alt+P' },
      },
    },
    minimum_chrome_version: '116',
  },
});
