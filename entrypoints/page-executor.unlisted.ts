/**
 * On-demand page executor (docs/01 §5, docs/05). It is built as an unlisted
 * script so WXT does not promote its match pattern into permanent host access.
 */

import type { ContentScriptOp, ContentScriptResult } from '../src/messaging/protocol';
import {
  executeContentTool,
  hideIndicator,
  showIndicator,
  watchManualOperation,
} from '../src/tools/content/executor';

export default defineUnlistedScript({
  main() {
    const page = window as { __panelotInjected?: boolean };
    if (page.__panelotInjected) return;
    page.__panelotInjected = true;

    chrome.runtime.onMessage.addListener(
      (raw: unknown, _sender, sendResponse: (response: ContentScriptResult) => void) => {
        const op = raw as ContentScriptOp;
        if (!op || typeof op !== 'object' || !('requestId' in op) || !('tool' in op)) return false;

        if (op.tool === '__ping') {
          sendResponse({ requestId: op.requestId, ok: true, result: 'pong' });
          return false;
        }

        showIndicator('Panelot 正在操作…');
        void executeContentTool(op.tool, op.params)
          .then((result) => sendResponse({ requestId: op.requestId, ok: true, result }))
          .catch((error: Error) =>
            sendResponse({ requestId: op.requestId, ok: false, error: error.message }),
          )
          .finally(() => hideIndicator());
        return true;
      },
    );

    watchManualOperation(() => {
      void chrome.runtime.sendMessage({ type: 'panelot.manualOperation' }).catch(() => {});
    });
  },
});
