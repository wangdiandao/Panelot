import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { minify } from 'terser';
import type { Plugin } from 'vite';

function compactJavaScript(): Plugin {
  return {
    name: 'panelot-compact-javascript',
    apply: 'build',
    enforce: 'post',
    async renderChunk(code, _chunk, options) {
      const result = await minify(code, {
        compress: { ecma: 2022, passes: 3 },
        format: { comments: false, ecma: 2022 },
        module: options.format === 'es',
      });
      if (result.code === undefined) throw new Error('Terser returned no JavaScript output.');
      return { code: result.code, map: null };
    },
  };
}

function workerSafeModulePreload(): Plugin {
  return {
    name: 'panelot-worker-safe-module-preload',
    apply: 'build',
    enforce: 'post',
    transform(code, id) {
      if (!id.endsWith('vite/preload-helper.js')) return null;
      const workerSafeCode = code.replaceAll('window.dispatchEvent(', 'globalThis.dispatchEvent(');
      return workerSafeCode === code ? null : { code: workerSafeCode, map: null };
    },
  };
}

// See docs/06-permissions.md for the permission rationale. All host permissions are
// requested dynamically at runtime (chrome.permissions.request).
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: 'dist',
  vite: () => ({
    plugins: [tailwindcss(), workerSafeModulePreload(), compactJavaScript()],
    // Chrome 116+ supports modulepreload natively, so dependency preloading can stay disabled.
    // Vite still wraps dynamic imports when this is false; the plugin above makes its rejected-
    // import event work in both Window and ServiceWorkerGlobalScope.
    build: {
      modulePreload: false,
      target: 'chrome116',
    },
    resolve: {
      alias: {
        dexie: 'dexie/dist/modern/dexie.min.mjs',
      },
    },
  }),
  manifest: {
    name: 'Panelot',
    description:
      'Use your own AI model with browser tools, Skills, and remote MCP in Chrome or Edge.',
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
      'offscreen',
      'bookmarks',
      'history',
      'sessions',
      'tabGroups',
      'topSites',
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
