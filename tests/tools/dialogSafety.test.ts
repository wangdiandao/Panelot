// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTENT_SCRIPT_PROTOCOL,
  CONTENT_SCRIPT_SCHEMA_HASH,
  type ContentScriptOp,
} from '../../src/messaging/protocol';
import { executeContentTool } from '../../src/tools/content/executor';
import { BrowserToolGateway } from '../../src/tools/gateway';

let executeScript: ReturnType<typeof vi.fn>;
let sendMessage: ReturnType<typeof vi.fn>;
let executeCount: number;

function contentResult(requestId: string, result: unknown) {
  return {
    protocol: CONTENT_SCRIPT_PROTOCOL,
    schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
    requestId,
    ok: true as const,
    result,
  };
}

function contentError(requestId: string, error: string) {
  return {
    protocol: CONTENT_SCRIPT_PROTOCOL,
    schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
    requestId,
    ok: false as const,
    error,
  };
}

function refOf(snapshot: string, label: string): string {
  const line = snapshot.split('\n').find((candidate) => candidate.includes(label));
  const match = line?.match(/\[ref=(s[a-z0-9]+_\d+_\d+)\]/i);
  if (!match) throw new Error(`No ref for ${label} in:\n${snapshot}`);
  return match[1]!;
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.title = 'Dialog fixture';
  executeCount = 0;
  executeScript = vi.fn(async (injection: { func?: () => void }) => {
    injection.func?.();
    return [];
  });
  sendMessage = vi.fn(async (_tabId: number, op: ContentScriptOp) => {
    if (op.kind === 'ping') return contentResult(op.requestId, 'pong');
    if (op.kind === 'cancel') {
      return contentResult(op.requestId, 'cancelled');
    }
    executeCount++;
    try {
      const result = await executeContentTool(op.tool, op.params, {
        requestId: op.requestId,
        deadlineAt: op.deadlineAt,
      });
      return contentResult(op.requestId, result);
    } catch (error) {
      return contentError(op.requestId, String(error));
    }
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      query: vi.fn(async () => [
        { id: 7, url: 'https://dialog.example.test/', active: true, status: 'complete' },
      ]),
      get: vi.fn(async () => ({
        id: 7,
        url: 'https://dialog.example.test/',
        active: true,
        status: 'complete',
      })),
      sendMessage,
    },
    scripting: { executeScript },
  };
});

afterEach(() => {
  const page = window as Window & {
    __panelotDialogScope?: {
      alert: typeof window.alert;
      confirm: typeof window.confirm;
      prompt: typeof window.prompt;
    };
  };
  if (!page.__panelotDialogScope) return;
  window.alert = page.__panelotDialogScope.alert;
  window.confirm = page.__panelotDialogScope.confirm;
  window.prompt = page.__panelotDialogScope.prompt;
  delete page.__panelotDialogScope;
});

describe('page dialog safety boundary', () => {
  it('does not patch page dialogs for read-only tools', async () => {
    document.body.innerHTML = '<main>read-only fixture</main>';
    executeScript.mockRejectedValue(new Error('MAIN world injection denied'));
    const originalConfirm = window.confirm;
    const gateway = new BrowserToolGateway();

    const result = await gateway.callContentTool('thread-1', 'read_page', {});

    expect(result.resultText).toContain('read-only fixture');
    expect(executeScript).not.toHaveBeenCalled();
    expect(window.confirm).toBe(originalConfirm);
  });

  it('fails closed before dispatch when the MAIN-world safety patch cannot be installed', async () => {
    executeScript.mockRejectedValue(new Error('MAIN world injection denied'));
    sendMessage.mockImplementation(async (_tabId: number, op: ContentScriptOp) => {
      if (op.kind === 'ping') return contentResult(op.requestId, 'pong');
      if (op.kind === 'execute') {
        executeCount++;
        return contentResult(op.requestId, { resultText: 'unsafe success' });
      }
      return contentResult(op.requestId, 'cancelled');
    });
    const gateway = new BrowserToolGateway();

    await expect(
      gateway.callContentTool('thread-1', 'click', { ref: 's1_1' }, 7),
    ).rejects.toMatchObject({
      failure: {
        code: 'safety_boundary_unavailable',
        phase: 'precheck',
        details: {
          stage: 'install',
          dispatched: false,
        },
      },
    });
    expect(executeCount).toBe(0);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('cancels confirm for a write, reports that decision, and restores the page API', async () => {
    document.body.innerHTML = '<button id="delete">Delete item</button>';
    const button = document.getElementById('delete')!;
    button.addEventListener('click', () => {
      document.body.dataset.confirmed = String(window.confirm('Delete this item?'));
    });
    const originalConfirm = window.confirm;
    const gateway = new BrowserToolGateway();
    const snapshot = await gateway.callContentTool('thread-1', 'read_page', {});
    const ref = refOf(snapshot.resultText, 'Delete item');

    const result = await gateway.callContentTool('thread-1', 'click', { ref });

    expect(document.body.dataset.confirmed).toBe('false');
    expect(result.resultText).toContain('confirm("Delete this item?")');
    expect(result.resultText).toContain('已自动取消（false）');
    expect(result.resultText).not.toContain('已自动确认（true）');
    expect(result.evidence).toMatchObject({
      effectState: 'observed',
      outcome: 'uncertain',
    });
    expect(window.confirm).toBe(originalConfirm);
    expect(executeScript).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('retries restore and exposes a structured recovery failure if the patch may remain', async () => {
    document.body.innerHTML = '<button id="save">Save</button>';
    let mainWorldCalls = 0;
    executeScript.mockImplementation(async (injection: { func?: () => void }) => {
      mainWorldCalls++;
      if (mainWorldCalls === 1) {
        injection.func?.();
        return [];
      }
      throw new Error('MAIN world restore denied');
    });
    const gateway = new BrowserToolGateway();
    const snapshot = await gateway.callContentTool('thread-1', 'read_page', {});
    const ref = refOf(snapshot.resultText, 'Save');

    await expect(gateway.callContentTool('thread-1', 'click', { ref })).rejects.toMatchObject({
      failure: {
        code: 'safety_boundary_unavailable',
        phase: 'recover',
        details: {
          stage: 'restore',
          restoreAttempts: 2,
          dispatched: true,
          effectMayHaveOccurred: true,
          dialogInterceptionMayRemain: true,
        },
      },
    });
    expect(executeCount).toBe(2);
    expect(executeScript).toHaveBeenCalledTimes(3);
  }, 15_000);
});
