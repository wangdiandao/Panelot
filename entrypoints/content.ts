/**
 * Content script (docs/01 §5, docs/05): tool executor + visual feedback +
 * manual-operation watcher. Injected on demand via chrome.scripting; also
 * registered as a declarative content script for controlled tabs.
 */

import type { ContentScriptOp, ContentScriptResult } from '../src/messaging/protocol';
import { executeContentTool, hideIndicator, showIndicator, watchManualOperation } from '../src/tools/content/executor';

export default defineContentScript({
  matches: ['<all_urls>'],
  registration: 'runtime', // injected programmatically, not on every page
  main() {
    // Idempotence guard: scripting.executeScript may inject twice.
    const w = window as { __panelotInjected?: boolean };
    if (w.__panelotInjected) return;
    w.__panelotInjected = true;

    chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse: (r: ContentScriptResult) => void) => {
      const op = raw as ContentScriptOp;
      if (!op || typeof op !== 'object' || !('requestId' in op) || !('tool' in op)) return false;

      if (op.tool === '__ping') {
        sendResponse({ requestId: op.requestId, ok: true, result: 'pong' });
        return false;
      }

      showIndicator('Panelot 正在操作…');
      void executeContentTool(op.tool, op.params)
        .then((result) => sendResponse({ requestId: op.requestId, ok: true, result }))
        .catch((e: Error) => sendResponse({ requestId: op.requestId, ok: false, error: e.message }))
        .finally(() => hideIndicator());
      return true; // async response
    });

    // Manual operation → notify background to auto-pause (docs/05 §5).
    watchManualOperation(() => {
      void chrome.runtime.sendMessage({ type: 'panelot.manualOperation' }).catch(() => {});
    });
  },
});
