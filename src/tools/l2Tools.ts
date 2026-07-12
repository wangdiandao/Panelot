/**
 * L2 tool definitions (docs/05 §3): screenshot, click_xy/drag (vision
 * coordinate mode), upload_file, press_keys_raw. All are level:'L2' so the
 * Gatekeeper attaches the escalation_l2 flag and the user confirms the
 * "being debugged" banner (docs/06 §5).
 */

import { z } from 'zod';
import type { AnyAgentTool } from '../agent/tool';
import type { CdpManager } from './cdp/debugger';
import type { BrowserToolGateway } from './gateway';
import type { PanelotDB } from '../db/schema';
import { currentBrowserTarget } from './browserTools';

export function createL2Tools(
  cdp: CdpManager,
  gateway: BrowserToolGateway,
  db: PanelotDB,
  getThreadId: () => string,
): AnyAgentTool[] {
  const tabIdParameter = {
    tabId: z
      .number()
      .int()
      .optional()
      .describe('Target tab id from tabs_list; omitted = the user-visible web tab'),
  };
  const targetTab = (tabId?: number) => gateway.getOperationTab(getThreadId(), tabId);

  const tools: AnyAgentTool[] = [
    {
      name: 'read_page_deep',
      label: '深度读取页面',
      description:
        'Read the CDP accessibility tree with deep refs for controls inside cross-origin iframes or closed shadow roots. Use when read_page reports those boundaries; use returned cN_M refs with click_trusted or type_trusted.',
      parameters: z.object({ ...tabIdParameter }),
      level: 'L2',
      effects: 'read',
      execute: async (_id, params: { tabId?: number }) => {
        const tabId = await targetTab(params.tabId);
        return {
          content: [{ type: 'text', text: `[tabId=${tabId}] ${await cdp.getDeepAxTree(tabId)}` }],
        };
      },
    },
    {
      name: 'screenshot',
      label: '截图',
      description:
        'Capture a screenshot (viewport, full page, or an element region). Use when the accessibility snapshot is insufficient — e.g. canvas apps or visual verification. Requires a vision-capable model to interpret.',
      parameters: z.object({
        ...tabIdParameter,
        target: z.union([z.literal('viewport'), z.literal('fullpage'), z.string()]).optional(),
        format: z.enum(['png', 'jpeg']).optional(),
        annotate: z.boolean().optional(),
      }),
      level: 'L2',
      effects: 'read',
      execute: async (
        toolCallId,
        params: { tabId?: number; target?: string; format?: 'png' | 'jpeg'; annotate?: boolean },
      ) => {
        const tabId = await targetTab(params.tabId);
        const format = params.format ?? 'png';
        return cdp.withTab(tabId, async () => {
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
              const rect = await gateway.getElementRect(getThreadId(), params.target, tabId);
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
        });
      },
    },
    {
      name: 'click_xy',
      label: '坐标点击',
      description:
        'Click at pixel coordinates (vision coordinate mode). Use only when no ref is available (canvas). Coordinates are CSS pixels relative to the viewport.',
      parameters: z.object({ ...tabIdParameter, x: z.number(), y: z.number() }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { tabId?: number; x: number; y: number }) => {
        const tabId = await targetTab(params.tabId);
        // CDP mouse events are isTrusted — suppress the manual-op watcher.
        gateway.markAgentInput(tabId);
        gateway.markDriven(getThreadId(), tabId);
        return cdp.withTab(tabId, async () => {
          const base = { x: params.x, y: params.y, button: 'left' as const, clickCount: 1 };
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
          return {
            content: [
              { type: 'text', text: `[tabId=${tabId}] 已在 (${params.x}, ${params.y}) 点击` },
            ],
          };
        });
      },
    },
    {
      name: 'click_trusted',
      label: '原生点击元素',
      description:
        'Escalation path for a ref-based click that failed because synthetic input was ineffective. Uses trusted CDP mouse input; call only with a ref from the latest snapshot after the ordinary click reports l1_not_effective.',
      parameters: z.object({
        ...tabIdParameter,
        element: z.string(),
        ref: z.string(),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { tabId?: number; element: string; ref: string }) => {
        const tabId = await targetTab(params.tabId);
        gateway.markAgentInput(tabId);
        gateway.markDriven(getThreadId(), tabId);
        const { settled } = params.ref.startsWith('c')
          ? await cdp.clickDeepRef(tabId, params.ref)
          : await gateway
              .getElementRect(getThreadId(), params.ref, tabId, 'viewport')
              .then((rect) => {
                if (rect.width <= 0 || rect.height <= 0)
                  throw new Error('目标元素当前没有可点击区域。');
                return cdp.withNetworkSettled(tabId, async () => {
                  const base = {
                    x: rect.x + rect.width / 2,
                    y: rect.y + rect.height / 2,
                    button: 'left' as const,
                    clickCount: 1,
                  };
                  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
                  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
                });
              });
        const snapshot = params.ref.startsWith('c')
          ? { resultText: await cdp.getDeepAxTree(tabId) }
          : await gateway.callContentTool(getThreadId(), 'read_page', { maxTokens: 1500 }, tabId);
        return {
          content: [
            {
              type: 'text',
              text: `[tabId=${tabId}] 已用原生输入点击 ${params.element}。\n\n${snapshot.resultText}`,
            },
          ],
          details: {
            strategy: 'l2',
            observedEffects: ['trusted_click'],
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
      parameters: z.object({
        ...tabIdParameter,
        element: z.string(),
        ref: z.string(),
        text: z.string(),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (
        _id,
        params: { tabId?: number; element: string; ref: string; text: string },
      ) => {
        const tabId = await targetTab(params.tabId);
        gateway.markAgentInput(tabId);
        gateway.markDriven(getThreadId(), tabId);
        const { settled } = params.ref.startsWith('c')
          ? await cdp.typeDeepRef(tabId, params.ref, params.text)
          : await gateway
              .callContentTool(getThreadId(), 'focus', { ref: params.ref }, tabId)
              .then(() =>
                cdp.withNetworkSettled(tabId, async () => {
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
                }),
              );
        const snapshot = params.ref.startsWith('c')
          ? { resultText: await cdp.getDeepAxTree(tabId) }
          : await gateway.callContentTool(getThreadId(), 'read_page', { maxTokens: 1500 }, tabId);
        return {
          content: [
            {
              type: 'text',
              text: `[tabId=${tabId}] 已用原生输入填写 ${params.element}（${params.text.length} 个字符）。\n\n${snapshot.resultText}`,
            },
          ],
          details: {
            strategy: 'l2',
            observedEffects: ['trusted_input'],
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
      parameters: z.object({
        ...tabIdParameter,
        from: z.object({ x: z.number(), y: z.number() }),
        to: z.object({ x: z.number(), y: z.number() }),
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
      ) => {
        const tabId = await targetTab(params.tabId);
        gateway.markAgentInput(tabId);
        gateway.markDriven(getThreadId(), tabId);
        return cdp.withTab(tabId, async () => {
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
          };
        });
      },
    },
    {
      name: 'upload_file',
      label: '上传文件',
      description:
        'Set a file on a file input (element+ref from the latest snapshot) from a user-provided attachment id. Only attachments the user explicitly provided can be uploaded (≤8MB).',
      parameters: z.object({
        ...tabIdParameter,
        element: z.string(),
        ref: z.string(),
        attachmentId: z.string(),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (
        _id,
        params: { tabId?: number; element: string; ref: string; attachmentId: string },
      ) => {
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
