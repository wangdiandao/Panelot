/**
 * L2 tool definitions (docs/05 §3): screenshot, click_xy/drag (vision
 * coordinate mode), upload_file, press_keys_raw. All are level:'L2' so the
 * Gatekeeper attaches the escalation_l2 flag and the user confirms the
 * "being debugged" banner (docs/06 §5).
 */

import { schema } from '../agent/schema';
import type { AnyAgentTool } from '../agent/tool';
import type { CdpManager } from './cdp/debugger';
import type { BrowserToolGateway } from './gateway';
import type { PanelotDB } from '../db/schema';
import { currentBrowserTarget } from './browserTools';
import { ActionDeadline, deadlineForTool } from './action/deadline';
import type { ActionEvidence } from './action/types';
import type { ExecuteResult } from './content/executor';

function dispatchedEvidence(effect: string, startedAt: number): ActionEvidence {
  return {
    attemptId: crypto.randomUUID(),
    attempts: [
      {
        phase: 'execute',
        strategy: 'l2',
        startedAt,
        durationMs: Date.now() - startedAt,
        message: `${effect} dispatched; target effect not verified`,
      },
    ],
    effectState: 'dispatched',
    observedEffects: [],
    outcome: 'uncertain',
  };
}

function capturedTabToolResult(result: ExecuteResult, details: Record<string, unknown> = {}) {
  const snapshot = result.snapshot ? `\n\n--- 新标签页快照 ---\n${result.snapshot}` : '';
  return {
    content: [
      {
        type: 'text' as const,
        text: `[tabId=${result.resultTabId}] ${result.resultText}${snapshot}`,
      },
    ],
    details: {
      ...details,
      ...(result.evidence ? { actionEvidence: result.evidence } : {}),
    },
  };
}

export function createL2Tools(
  cdp: CdpManager,
  gateway: BrowserToolGateway,
  db: PanelotDB,
  getThreadId: () => string,
): AnyAgentTool[] {
  const tabIdParameter = {
    tabId: schema.optional(
      schema.number({
        integer: true,
        description: 'Target tab id from tabs_list; omitted = the user-visible web tab',
      }),
    ),
  };
  const targetTab = (tabId?: number) => gateway.getOperationTab(getThreadId(), tabId);

  const tools: AnyAgentTool[] = [
    {
      name: 'read_page_deep',
      label: '深度读取页面',
      description:
        'Read the CDP accessibility tree with opaque deep refs for controls inside cross-origin iframes or closed shadow roots. Use when read_page reports those boundaries; copy the returned [ref=<deep-ref>] value exactly into click_trusted or type_trusted.',
      parameters: schema.object({ ...tabIdParameter }),
      level: 'L2',
      effects: 'read',
      execute: async (_id, params: { tabId?: number }, signal) => {
        const tabId = await targetTab(params.tabId);
        const deadlineAt = deadlineForTool('read_page_deep', params);
        return {
          content: [
            {
              type: 'text',
              text: `[tabId=${tabId}] ${await cdp.getDeepAxTree(tabId, signal, deadlineAt)}`,
            },
          ],
        };
      },
    },
    {
      name: 'screenshot',
      label: '截图',
      description:
        'Capture a screenshot (viewport, full page, or an element region). Use when the accessibility snapshot is insufficient — e.g. canvas apps or visual verification. Requires a vision-capable model to interpret.',
      parameters: schema.object({
        ...tabIdParameter,
        target: schema.optional(
          schema.union([schema.literal('viewport'), schema.literal('fullpage'), schema.string()]),
        ),
        format: schema.optional(schema.enum(['png', 'jpeg'])),
        annotate: schema.optional(schema.boolean()),
      }),
      level: 'L2',
      effects: 'read',
      execute: async (
        toolCallId,
        params: { tabId?: number; target?: string; format?: 'png' | 'jpeg'; annotate?: boolean },
        signal,
      ) => {
        const tabId = await targetTab(params.tabId);
        const deadlineAt = deadlineForTool('screenshot', params);
        const format = params.format ?? 'png';
        return cdp.withTab(
          tabId,
          async () => {
            let metricsOverridden = false;
            let clip:
              { x: number; y: number; width: number; height: number; scale: number } | undefined;
            try {
              let refLegend = '';
              if (params.annotate) {
                const annotation = await gateway.callContentTool(
                  getThreadId(),
                  'annotate_refs',
                  {},
                  tabId,
                  signal,
                  deadlineAt,
                );
                refLegend = annotation.resultText;
              }
              if (params.target === 'fullpage') {
                const { cssContentSize } = await cdp.send<{
                  cssContentSize: { width: number; height: number };
                }>('Page.getLayoutMetrics');
                await cdp.send('Emulation.setDeviceMetricsOverride', {
                  width: Math.ceil(cssContentSize.width),
                  height: Math.ceil(cssContentSize.height),
                  deviceScaleFactor: 1,
                  mobile: false,
                });
                metricsOverridden = true;
              } else if (params.target && params.target !== 'viewport') {
                const rect = await gateway.getElementRect(
                  getThreadId(),
                  params.target,
                  tabId,
                  'document',
                  signal,
                  deadlineAt,
                );
                if (rect.width <= 0 || rect.height <= 0)
                  throw new Error(`Element ${params.target} is not visible`);
                clip = { ...rect, scale: 1 };
              }
              const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', {
                format,
                captureBeyondViewport: params.target === 'fullpage' || clip !== undefined,
                ...(clip ? { clip } : {}),
              });

              // Store as an attachment; reference by id in details, embed image for the model.
              const threadId = getThreadId();
              const bytes = base64ToBlob(data, `image/${format}`);
              const attachmentId = crypto.randomUUID();
              await db.attachments.add({
                id: attachmentId,
                threadId,
                createdAt: Date.now(),
                kind: 'screenshot',
                mime: `image/${format}`,
                bytes,
                trust: 'untrusted',
                provenance: 'page',
              });
              return {
                content: [
                  { type: 'text', text: `[tabId=${tabId}] 已截图（见图）` },
                  { type: 'image', mime: `image/${format}`, data },
                ],
                details: {
                  screenshotAttachmentId: attachmentId,
                  ...(refLegend ? { refLegend } : {}),
                },
              };
            } finally {
              if (params.annotate) {
                await gateway
                  .callContentTool(getThreadId(), 'clear_annotations', {}, tabId)
                  .catch(() => {});
              }
              if (metricsOverridden) {
                await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
              }
            }
          },
          signal,
          deadlineAt,
        );
      },
    },
    {
      name: 'click_xy',
      label: '坐标点击',
      description:
        'Click at pixel coordinates (vision coordinate mode). Use only when no ref is available (canvas). Coordinates are CSS pixels relative to the viewport.',
      parameters: schema.object({
        ...tabIdParameter,
        x: schema.number(),
        y: schema.number(),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { tabId?: number; x: number; y: number }, signal) => {
        const tabId = await targetTab(params.tabId);
        const deadlineAt = deadlineForTool('click_xy', params);
        const startedAt = Date.now();
        const captured = await gateway.runWithNewTabCapture(
          getThreadId(),
          tabId,
          () =>
            cdp.withTab(
              tabId,
              async () => {
                new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
                // CDP mouse events are isTrusted — suppress the manual-op watcher.
                gateway.markAgentInput(tabId);
                gateway.markDriven(getThreadId(), tabId);
                const base = {
                  x: params.x,
                  y: params.y,
                  button: 'left' as const,
                  clickCount: 1,
                };
                await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: `[tabId=${tabId}] 已在 (${params.x}, ${params.y}) 点击`,
                    },
                  ],
                  details: { actionEvidence: dispatchedEvidence('trusted_click', startedAt) },
                };
              },
              signal,
              deadlineAt,
              true,
            ),
          signal,
          deadlineAt,
        );
        return captured.createdTabResult
          ? capturedTabToolResult(captured.createdTabResult)
          : captured.value;
      },
    },
    {
      name: 'click_trusted',
      label: '原生点击元素',
      description:
        'Escalation path for a ref-based click that failed because synthetic input was ineffective. Uses trusted CDP mouse input; call only with a ref from the latest snapshot after the ordinary click reports l1_not_effective.',
      parameters: schema.object({
        ...tabIdParameter,
        element: schema.string(),
        ref: schema.string(),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { tabId?: number; element: string; ref: string }, signal) => {
        const tabId = await targetTab(params.tabId);
        const deadlineAt = deadlineForTool('click_trusted', params);
        const startedAt = Date.now();
        new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
        const markDispatch = () => {
          gateway.markAgentInput(tabId);
          gateway.markDriven(getThreadId(), tabId);
        };
        let trustedClick: () => Promise<{ settled: boolean }>;
        if (params.ref.startsWith('c')) {
          trustedClick = () =>
            cdp.clickDeepRef(tabId, params.ref, signal, deadlineAt, markDispatch);
        } else {
          const rect = await gateway.getElementRect(
            getThreadId(),
            params.ref,
            tabId,
            'viewport',
            signal,
            deadlineAt,
          );
          if (rect.width <= 0 || rect.height <= 0) throw new Error('目标元素当前没有可点击区域。');
          await gateway.callContentTool(
            getThreadId(),
            'validate_ref',
            { ref: params.ref },
            tabId,
            signal,
            deadlineAt,
          );
          trustedClick = () =>
            cdp.withNetworkSettled(
              tabId,
              async () => {
                markDispatch();
                const base = {
                  x: rect.x + rect.width / 2,
                  y: rect.y + rect.height / 2,
                  button: 'left' as const,
                  clickCount: 1,
                };
                await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
              },
              500,
              5000,
              signal,
              deadlineAt,
            );
        }
        const captured = await gateway.runWithNewTabCapture(
          getThreadId(),
          tabId,
          trustedClick,
          signal,
          deadlineAt,
        );
        const { settled } = captured.value;
        if (captured.createdTabResult) {
          return capturedTabToolResult(captured.createdTabResult, { networkSettled: settled });
        }
        const snapshot = params.ref.startsWith('c')
          ? { resultText: await cdp.getDeepAxTree(tabId, signal, deadlineAt) }
          : await gateway.callContentTool(
              getThreadId(),
              'read_page',
              { maxTokens: 1500 },
              tabId,
              signal,
              deadlineAt,
            );
        return {
          content: [
            {
              type: 'text',
              text: `[tabId=${tabId}] 已用原生输入点击 ${params.element}。\n\n${snapshot.resultText}`,
            },
          ],
          details: {
            actionEvidence: dispatchedEvidence('trusted_click', startedAt),
            networkSettled: settled,
          },
        };
      },
    },
    {
      name: 'type_trusted',
      label: '原生输入文本',
      description:
        'Escalation path for a field that rejected ordinary synthetic input. Focuses the latest ref and inserts text through CDP; use only after type reports l1_not_effective.',
      parameters: schema.object({
        ...tabIdParameter,
        element: schema.string(),
        ref: schema.string(),
        text: schema.string(),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (
        _id,
        params: { tabId?: number; element: string; ref: string; text: string },
        signal,
      ) => {
        const tabId = await targetTab(params.tabId);
        const deadlineAt = deadlineForTool('type_trusted', params);
        const startedAt = Date.now();
        new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
        const markDispatch = () => {
          gateway.markAgentInput(tabId);
          gateway.markDriven(getThreadId(), tabId);
        };
        const { settled } = params.ref.startsWith('c')
          ? await cdp.typeDeepRef(tabId, params.ref, params.text, signal, deadlineAt, markDispatch)
          : await cdp.withNetworkSettled(
              tabId,
              async () => {
                await gateway.callContentTool(
                  getThreadId(),
                  'focus',
                  { ref: params.ref },
                  tabId,
                  signal,
                  deadlineAt,
                );
                await gateway.callContentTool(
                  getThreadId(),
                  'validate_ref',
                  { ref: params.ref },
                  tabId,
                  signal,
                  deadlineAt,
                );
                markDispatch();
                await cdp.send('Input.dispatchKeyEvent', {
                  type: 'keyDown',
                  key: 'a',
                  code: 'KeyA',
                  modifiers: 2,
                });
                await cdp.send('Input.dispatchKeyEvent', {
                  type: 'keyUp',
                  key: 'a',
                  code: 'KeyA',
                  modifiers: 2,
                });
                await cdp.send('Input.insertText', { text: params.text });
              },
              500,
              5000,
              signal,
              deadlineAt,
            );
        const snapshot = params.ref.startsWith('c')
          ? { resultText: await cdp.getDeepAxTree(tabId, signal, deadlineAt) }
          : await gateway.callContentTool(
              getThreadId(),
              'read_page',
              { maxTokens: 1500 },
              tabId,
              signal,
              deadlineAt,
            );
        return {
          content: [
            {
              type: 'text',
              text: `[tabId=${tabId}] 已用原生输入填写 ${params.element}（${params.text.length} 个字符）。\n\n${snapshot.resultText}`,
            },
          ],
          details: {
            actionEvidence: dispatchedEvidence('trusted_input', startedAt),
            networkSettled: settled,
          },
        };
      },
    },
    {
      name: 'drag',
      label: '拖拽',
      description:
        'Drag from one point to another (vision coordinate mode) using trusted mouse events.',
      parameters: schema.object({
        ...tabIdParameter,
        from: schema.object({ x: schema.number(), y: schema.number() }),
        to: schema.object({ x: schema.number(), y: schema.number() }),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (
        _id,
        params: {
          tabId?: number;
          from: { x: number; y: number };
          to: { x: number; y: number };
        },
        signal,
      ) => {
        const tabId = await targetTab(params.tabId);
        const deadlineAt = deadlineForTool('drag', params);
        const startedAt = Date.now();
        return cdp.withTab(
          tabId,
          async () => {
            new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
            gateway.markAgentInput(tabId);
            gateway.markDriven(getThreadId(), tabId);
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              ...params.from,
              button: 'left',
              clickCount: 1,
            });
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              ...params.to,
              button: 'left',
            });
            await cdp.send('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              ...params.to,
              button: 'left',
              clickCount: 1,
            });
            return {
              content: [
                {
                  type: 'text',
                  text: `[tabId=${tabId}] 已从 (${params.from.x},${params.from.y}) 拖到 (${params.to.x},${params.to.y})`,
                },
              ],
              details: { actionEvidence: dispatchedEvidence('trusted_drag', startedAt) },
            };
          },
          signal,
          deadlineAt,
          true,
        );
      },
    },
    {
      name: 'upload_file',
      label: '上传文件',
      description:
        'Set a file on a file input (element+ref from the latest snapshot) from a user-provided attachment id. Only attachments the user explicitly provided can be uploaded (≤8MB).',
      parameters: schema.object({
        ...tabIdParameter,
        element: schema.string(),
        ref: schema.string(),
        attachmentId: schema.string(),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (
        _id,
        params: { tabId?: number; element: string; ref: string; attachmentId: string },
        signal,
      ) => {
        const deadlineAt = deadlineForTool('upload_file', params);
        new ActionDeadline(Number.POSITIVE_INFINITY, signal, deadlineAt).throwIfDone();
        const threadId = getThreadId();
        const attachment = await db.attachments.get(params.attachmentId);
        if (!attachment)
          throw new Error(`附件 ${params.attachmentId} 不存在。只能上传用户提供的附件。`);
        if (attachment.threadId !== threadId) throw new Error('该附件不属于当前会话。');
        if (attachment.provenance !== 'user') {
          throw new Error('只能上传用户明确提供的附件；页面、工具和导入内容不能作为上传来源。');
        }
        const MAX = 8 * 1024 * 1024;
        if (attachment.bytes.size > MAX) {
          throw new Error(
            `附件过大（${(attachment.bytes.size / 1024 / 1024).toFixed(1)} MB > 8 MB 上限），请让用户手动选择文件。`,
          );
        }
        const buf = new Uint8Array(await attachment.bytes.arrayBuffer());
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < buf.length; i += CHUNK)
          binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
        const base64 = btoa(binary);
        const ext = attachment.mime.split('/')[1]?.split('+')[0] ?? 'bin';
        const tabId = await targetTab(params.tabId);
        const result = await gateway.callContentTool(
          threadId,
          'upload',
          {
            ref: params.ref,
            filename:
              attachment.meta?.title ?? `attachment-${params.attachmentId.slice(0, 8)}.${ext}`,
            mime: attachment.mime,
            base64,
          },
          tabId,
          signal,
          deadlineAt,
        );
        return {
          content: [{ type: 'text' as const, text: `[tabId=${tabId}] ${result.resultText}` }],
        };
      },
    },
  ];
  return tools.map((tool) => ({
    ...tool,
    resolveTarget:
      tool.resolveTarget ??
      ((params: { tabId?: number }) => currentBrowserTarget(gateway, getThreadId, params.tabId)),
  }));
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
