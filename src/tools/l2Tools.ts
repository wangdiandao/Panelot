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

export function createL2Tools(
  cdp: CdpManager,
  gateway: BrowserToolGateway,
  db: PanelotDB,
  getThreadId: () => string,
): AnyAgentTool[] {
  const targetTab = () => gateway.getTargetTab(getThreadId());

  return [
    {
      name: 'screenshot',
      label: '截图',
      description:
        'Capture a screenshot (viewport, full page, or an element region). Use when the accessibility snapshot is insufficient — e.g. canvas apps or visual verification. Requires a vision-capable model to interpret.',
      parameters: z.object({
        target: z.union([z.literal('viewport'), z.literal('fullpage'), z.string()]).optional(),
        format: z.enum(['png', 'jpeg']).optional(),
      }),
      level: 'L2',
      effects: 'read',
      execute: async (toolCallId, params: { target?: string; format?: 'png' | 'jpeg' }) => {
        const tabId = await targetTab();
        const format = params.format ?? 'png';
        return cdp.withTab(tabId, async () => {
          if (params.target === 'fullpage') {
            const { cssContentSize } = await cdp.send<{ cssContentSize: { width: number; height: number } }>('Page.getLayoutMetrics');
            await cdp.send('Emulation.setDeviceMetricsOverride', {
              width: Math.ceil(cssContentSize.width),
              height: Math.ceil(cssContentSize.height),
              deviceScaleFactor: 1,
              mobile: false,
            });
          }
          const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format, captureBeyondViewport: params.target === 'fullpage' });
          if (params.target === 'fullpage') await cdp.send('Emulation.clearDeviceMetricsOverride');

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
          });
          return {
            content: [
              { type: 'text', text: '已截图（见图）' },
              { type: 'image', mime: `image/${format}`, data },
            ],
            details: { screenshotAttachmentId: attachmentId },
          };
        });
      },
    },
    {
      name: 'click_xy',
      label: '坐标点击',
      description: 'Click at pixel coordinates (vision coordinate mode). Use only when no ref is available (canvas). Coordinates are CSS pixels relative to the viewport.',
      parameters: z.object({ x: z.number(), y: z.number() }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { x: number; y: number }) => {
        const tabId = await targetTab();
        return cdp.withTab(tabId, async () => {
          const base = { x: params.x, y: params.y, button: 'left' as const, clickCount: 1 };
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
          return { content: [{ type: 'text', text: `已在 (${params.x}, ${params.y}) 点击` }] };
        });
      },
    },
    {
      name: 'drag',
      label: '拖拽',
      description: 'Drag from one point to another (vision coordinate mode) using trusted mouse events.',
      parameters: z.object({
        from: z.object({ x: z.number(), y: z.number() }),
        to: z.object({ x: z.number(), y: z.number() }),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { from: { x: number; y: number }; to: { x: number; y: number } }) => {
        const tabId = await targetTab();
        return cdp.withTab(tabId, async () => {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params.from, button: 'left', clickCount: 1 });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...params.to, button: 'left' });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params.to, button: 'left', clickCount: 1 });
          return { content: [{ type: 'text', text: `已从 (${params.from.x},${params.from.y}) 拖到 (${params.to.x},${params.to.y})` }] };
        });
      },
    },
    {
      name: 'upload_file',
      label: '上传文件',
      description: 'Set files on a file input (element+ref) from a user-provided attachment id. Only attachments the user explicitly provided can be uploaded.',
      parameters: z.object({
        element: z.string(),
        ref: z.string(),
        attachmentId: z.string(),
      }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, _params) => {
        // File upload needs the ref → backendNodeId translation via the content
        // script's selector_map plus DOM.setFileInputFiles; wired when the
        // selector_map↔CDP bridge lands. Fail loudly rather than silently.
        throw new Error('upload_file 需要 selector_map↔CDP 桥接（后续实现）。当前可让用户手动选择文件。');
      },
    },
    {
      name: 'press_keys_raw',
      label: '原生键序',
      description: 'Dispatch a trusted raw key sequence via CDP for pages that ignore synthetic events. Prefer press_key (L1) unless it was ignored.',
      parameters: z.object({ sequence: z.string() }),
      level: 'L2',
      effects: 'write',
      execute: async (_id, params: { sequence: string }) => {
        const tabId = await targetTab();
        return cdp.withTab(tabId, async () => {
          for (const ch of params.sequence) {
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch });
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', text: ch });
          }
          return { content: [{ type: 'text', text: `已输入原生键序（${params.sequence.length} 键）` }] };
        });
      },
    },
  ];
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
