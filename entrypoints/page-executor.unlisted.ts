/**
 * On-demand page executor (docs/01 §5, docs/05). It is built as an unlisted
 * script so WXT does not promote its match pattern into permanent host access.
 */

import {
  CONTENT_SCRIPT_PROTOCOL,
  CONTENT_SCRIPT_SCHEMA_HASH,
  type ContentScriptResult,
} from '../src/messaging/protocol';
import { parseContentScriptOp } from '../src/messaging/validation';
import {
  executeContentTool,
  hideIndicator,
  showIndicator,
  watchManualOperation,
} from '../src/tools/content/executor';
import { serializeActionFailure } from '../src/tools/action/errors';
import { abortedAction } from '../src/tools/action/deadline';

export default defineUnlistedScript({
  main() {
    const page = window as { __panelotInjected?: boolean };
    if (page.__panelotInjected) return;
    page.__panelotInjected = true;

    const requests = new Map<string, AbortController>();
    let executionQueue: Promise<void> = Promise.resolve();

    chrome.runtime.onMessage.addListener(
      (raw: unknown, _sender, sendResponse: (response: ContentScriptResult) => void) => {
        const parsed = parseContentScriptOp(raw);
        if (!parsed.ok) {
          const looksLikePanelotMessage =
            typeof raw === 'object' &&
            raw !== null &&
            ('kind' in raw || 'protocol' in raw || 'requestId' in raw);
          if (!looksLikePanelotMessage) return false;
          if (parsed.requestId) {
            sendResponse({
              protocol: CONTENT_SCRIPT_PROTOCOL,
              schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
              requestId: parsed.requestId,
              ok: false,
              error: `Invalid content-script request: ${parsed.diagnostic}`,
            });
          }
          return false;
        }
        const op = parsed.value;

        if (op.kind === 'ping') {
          sendResponse({
            protocol: CONTENT_SCRIPT_PROTOCOL,
            schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
            requestId: op.requestId,
            ok: true,
            result: 'pong',
          });
          return false;
        }

        if (op.kind === 'cancel') {
          requests.get(op.cancelRequestId)?.abort();
          sendResponse({
            protocol: CONTENT_SCRIPT_PROTOCOL,
            schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
            requestId: op.requestId,
            ok: true,
            result: 'cancelled',
          });
          return false;
        }

        const controller = new AbortController();
        requests.set(op.requestId, controller);
        const execute = executionQueue.then(async () => {
          if (controller.signal.aborted) {
            throw abortedAction('execute', { dispatched: false });
          }
          showIndicator(op.requestId, 'Panelot 正在操作…');
          return executeContentTool(op.tool, op.params, {
            requestId: op.requestId,
            signal: controller.signal,
            deadlineAt: op.deadlineAt,
          });
        });
        executionQueue = execute.then(
          () => undefined,
          () => undefined,
        );
        void execute
          .then((result) =>
            sendResponse({
              protocol: CONTENT_SCRIPT_PROTOCOL,
              schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
              requestId: op.requestId,
              ok: true,
              result,
            }),
          )
          .catch((error: unknown) => {
            const failure = serializeActionFailure(error);
            sendResponse({
              protocol: CONTENT_SCRIPT_PROTOCOL,
              schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
              requestId: op.requestId,
              ok: false,
              error: failure.message,
              failure,
            });
          })
          .finally(() => {
            requests.delete(op.requestId);
            hideIndicator(op.requestId);
          });
        return true;
      },
    );

    watchManualOperation(() => {
      void chrome.runtime.sendMessage({ type: 'panelot.manualOperation' }).catch(() => {});
    });
  },
});
