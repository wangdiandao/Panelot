import { describe, expect, it, vi } from 'vitest';
import type { AnyAgentTool } from '../../src/agent/tool';
import { createL1Tools } from '../../src/tools/browserTools';
import { parseContentToolCall } from '../../src/tools/content/protocol';
import type { BrowserToolGateway } from '../../src/tools/gateway';

type ContentBackedToolName =
  | 'read_page'
  | 'find_in_page'
  | 'extract'
  | 'get_selection'
  | 'click'
  | 'type'
  | 'select_option'
  | 'press_key'
  | 'scroll'
  | 'hover'
  | 'wait_for'
  | 'batch_actions';

const tools = new Map(
  createL1Tools({} as BrowserToolGateway, () => 'thread-1').map((tool) => [tool.name, tool]),
);

function getTool(name: ContentBackedToolName): AnyAgentTool {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Missing L1 tool ${name}`);
  return tool;
}

function contentBoundaryParams(
  name: ContentBackedToolName,
  params: unknown,
): Record<string, unknown> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new Error(`Expected object params for ${name}`);
  }
  const forwarded = { ...(params as Record<string, unknown>) };
  delete forwarded.tabId;
  if (name === 'extract') delete forwarded.fromChar;
  if (name === 'press_key') delete forwarded.ref;
  if (['click', 'type', 'select_option', 'hover'].includes(name)) delete forwarded.element;
  if (name === 'batch_actions' && Array.isArray(forwarded.actions)) {
    forwarded.actions = forwarded.actions.map((action) => {
      if (typeof action !== 'object' || action === null || Array.isArray(action)) return action;
      const actionRecord = action as Record<string, unknown>;
      if (
        typeof actionRecord.params !== 'object' ||
        actionRecord.params === null ||
        Array.isArray(actionRecord.params)
      ) {
        return action;
      }
      const actionParams = { ...(actionRecord.params as Record<string, unknown>) };
      delete actionParams.element;
      return { ...actionRecord, params: actionParams };
    });
  }
  return forwarded;
}

function expectAcceptedAtBothBoundaries(
  name: ContentBackedToolName,
  rawParams: Record<string, unknown>,
): void {
  const agentResult = getTool(name).parameters.safeParse(rawParams);
  expect(agentResult.success, `${name} AgentTool should accept the fixture`).toBe(true);
  if (!agentResult.success) return;
  const contentResult = parseContentToolCall(name, contentBoundaryParams(name, agentResult.data));
  expect(contentResult, `${name} content boundary should accept AgentTool output`).toMatchObject({
    ok: true,
  });
}

function expectRejectedAtBothBoundaries(
  name: ContentBackedToolName,
  rawParams: Record<string, unknown>,
): void {
  expect(getTool(name).parameters.safeParse(rawParams).success).toBe(false);
  expect(parseContentToolCall(name, contentBoundaryParams(name, rawParams)).ok).toBe(false);
}

describe('content tool parameter contracts', () => {
  it('accepts representative AgentTool params at the content-script boundary', () => {
    const fixtures: ReadonlyArray<readonly [ContentBackedToolName, Record<string, unknown>]> = [
      ['read_page', { tabId: 7, mode: 'article', maxTokens: 6000 }],
      ['find_in_page', { tabId: 7, query: 'Panelot' }],
      ['extract', { tabId: 7, scope: 's1_1', fromChar: 8000 }],
      ['get_selection', { tabId: 7 }],
      ['click', { tabId: 7, element: 'Submit', ref: 's1_1', doubleClick: false }],
      [
        'type',
        {
          tabId: 7,
          element: 'Email',
          ref: 's1_2',
          text: 'user@example.test',
          mode: 'replace',
          submit: false,
          slowly: true,
        },
      ],
      ['select_option', { tabId: 7, element: 'Country', ref: 's1_3', values: ['CN'] }],
      ['press_key', { tabId: 7, key: 'Enter', ref: 's1_4' }],
      ['scroll', { tabId: 7, target: 's1_5', direction: 'down', amount: 0 }],
      ['hover', { tabId: 7, element: 'Menu', ref: 's1_6' }],
      ['wait_for', { tabId: 7, text: 'Ready', textGone: false, timeMs: 30_000 }],
      [
        'batch_actions',
        {
          tabId: 7,
          actions: [{ kind: 'click', params: { element: 'Submit', ref: 's1_7' } }],
        },
      ],
    ];

    for (const [name, params] of fixtures) expectAcceptedAtBothBoundaries(name, params);
  });

  it('keeps numeric and ref constraints identical across both boundaries', () => {
    expectAcceptedAtBothBoundaries('read_page', { maxTokens: 0 });
    expectRejectedAtBothBoundaries('read_page', { maxTokens: -1 });
    expectRejectedAtBothBoundaries('read_page', { maxTokens: 6001 });

    expectRejectedAtBothBoundaries('click', { element: 'Submit', ref: '' });
    expectRejectedAtBothBoundaries('scroll', { target: '', direction: 'down' });
    expectRejectedAtBothBoundaries('scroll', { direction: 'down', amount: -1 });

    expectAcceptedAtBothBoundaries('wait_for', { timeMs: 0 });
    expectRejectedAtBothBoundaries('wait_for', { timeMs: -1 });
    expectRejectedAtBothBoundaries('wait_for', { timeMs: 30_001 });

    const invalidBatch = {
      actions: [{ kind: 'click', params: { element: 'Submit', ref: '' } }],
    };
    expect(getTool('batch_actions').parameters.safeParse(invalidBatch).success).toBe(false);
    expect(
      parseContentToolCall('batch_actions', contentBoundaryParams('batch_actions', invalidBatch))
        .ok,
    ).toBe(false);
  });

  it('removes background-only fields before dispatching to the content script', async () => {
    const callContentTool = vi.fn(async (_threadId: string, _tool: string, _params: unknown) => ({
      resultText: 'ok',
    }));
    const gateway = {
      getOperationTab: vi.fn(async () => 7),
      callContentTool,
    } as unknown as BrowserToolGateway;
    const localTools = new Map(
      createL1Tools(gateway, () => 'thread-1').map((tool) => [tool.name, tool]),
    );
    const signal = new AbortController().signal;
    const click = localTools.get('click');
    const batch = localTools.get('batch_actions');
    if (!click || !batch) throw new Error('Missing content-backed L1 tools');

    await click.execute('call-1', { tabId: 7, element: 'Submit', ref: 's1_1' }, signal);
    await batch.execute(
      'call-2',
      {
        tabId: 7,
        actions: [{ kind: 'click', params: { element: 'Submit', ref: 's1_2' } }],
      },
      signal,
    );

    expect(callContentTool.mock.calls[0]?.[2]).toEqual({ ref: 's1_1' });
    expect(callContentTool.mock.calls[1]?.[2]).toEqual({
      actions: [{ kind: 'click', params: { ref: 's1_2' } }],
    });
  });
});
