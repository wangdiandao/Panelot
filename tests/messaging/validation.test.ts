import { describe, expect, it } from 'vitest';
import {
  CONTENT_SCRIPT_PROTOCOL,
  CONTENT_SCRIPT_SCHEMA_HASH,
  ENGINE_PROTOCOL,
  ENGINE_SCHEMA_HASH,
} from '../../src/messaging/protocol';
import {
  parseContentScriptOp,
  parseContentScriptResult,
  parseOp,
} from '../../src/messaging/validation';
import { parseAgentEvent } from '../../src/messaging/agentEventValidation';

describe('cross-context runtime validation', () => {
  it('rejects malformed fields on a known engine command', () => {
    const parsed = parseOp({
      type: 'turn.submit',
      submissionId: 'submit-1',
      threadId: 'thread-1',
      input: { text: 42 },
    });

    expect(parsed).toMatchObject({ ok: false, submissionId: 'submit-1' });
  });

  it('requires a matching stream identity on thread events and snapshots', () => {
    expect(
      parseAgentEvent({
        type: 'thread.updated',
        threadId: 'thread-1',
        revision: 1,
        patch: {},
      }).ok,
    ).toBe(false);

    const parsed = parseAgentEvent({
      type: 'initialized',
      submissionId: 'subscribe-1',
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
      stream: { threadId: 'thread-1', epoch: 4, sequence: 2 },
      snapshot: {
        stream: { threadId: 'thread-2', epoch: 4, sequence: 2 },
        meta: {
          id: 'thread-1',
          revision: 0,
          title: 'Thread',
          createdAt: 1,
          updatedAt: 1,
          leafId: null,
          archived: false,
          pinned: false,
          stats: { turns: 0, totalTokens: 0, costUsd: 0 },
        },
        items: [],
        activeTurn: null,
        pendingApprovals: [],
        queuedInputs: 0,
        queuedRuns: [],
        recoverableRuns: [],
      },
    });
    expect(parsed.ok).toBe(false);
  });

  it('accepts interaction responses and streamed interaction requests', () => {
    expect(
      parseOp({
        type: 'interaction.response',
        submissionId: 'interaction-response-1',
        interactionId: 'interaction-1',
        response: { kind: 'submit', value: { answers: [{ id: 'choice', value: 'a' }] } },
      }).ok,
    ).toBe(true);
    expect(
      parseAgentEvent({
        type: 'interaction.request',
        threadId: 'thread-1',
        turnId: 'turn-1',
        interactionId: 'interaction-1',
        itemId: 'call-1',
        request: {
          kind: 'ask_user',
          questions: [{ id: 'choice', question: 'Choose one' }],
        },
        requestedAt: 1,
        stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
      }).ok,
    ).toBe(true);
  });

  it('accepts only the current content-script protocol and schema hash', () => {
    expect(
      parseContentScriptOp({
        protocol: CONTENT_SCRIPT_PROTOCOL,
        schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
        kind: 'ping',
        requestId: 'ping-1',
      }).ok,
    ).toBe(true);
    expect(
      parseContentScriptResult({
        protocol: CONTENT_SCRIPT_PROTOCOL,
        schemaHash: 'stale-hash',
        requestId: 'ping-1',
        ok: true,
        result: 'pong',
      }).ok,
    ).toBe(false);
  });

  it('accepts the stable fatal envelope across engine protocol versions only', () => {
    expect(
      parseAgentEvent({
        type: 'fatal.reload_required',
        submissionId: 'stale-init',
        protocol: 'panelot/engine-v0',
        schemaHash: 'future-schema',
        message: 'Reload required.',
      }).ok,
    ).toBe(true);

    expect(
      parseAgentEvent({
        type: 'initialized',
        submissionId: 'stale-init',
        protocol: 'panelot/engine-v0',
        schemaHash: ENGINE_SCHEMA_HASH,
      }).ok,
    ).toBe(false);

    expect(
      parseAgentEvent({
        type: 'fatal.reload_required',
        submissionId: 'stale-init',
        protocol: '',
        schemaHash: 'future-schema',
        message: 'Reload required.',
      }).ok,
    ).toBe(false);
  });

  it.each(['end', 'max_tokens', 'content_filter', 'done'])(
    'accepts terminal stop reason %s, including the prior done label',
    (stopReason) => {
      expect(
        parseAgentEvent({
          type: 'turn.complete',
          threadId: 'thread-1',
          turnId: 'turn-1',
          stopReason,
          stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
        }).ok,
      ).toBe(true);
    },
  );

  it('rejects tool_use as a terminal turn reason', () => {
    expect(
      parseAgentEvent({
        type: 'turn.complete',
        threadId: 'thread-1',
        turnId: 'turn-1',
        stopReason: 'tool_use',
        stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
      }).ok,
    ).toBe(false);
  });

  it.each([
    [{ type: 'unknown', submissionId: 'unknown-1' }, '<root>.type'],
    [{ type: 'ping', submissionId: '' }, '<root>.submissionId'],
    [
      {
        type: 'turn.submit',
        submissionId: 'submit-2',
        threadId: '',
        input: { text: 'hello' },
      },
      '<root>.threadId',
    ],
    [
      {
        type: 'turn.enqueue',
        submissionId: 'enqueue-1',
        threadId: 'thread-1',
        input: {
          text: 'hello',
          browserContext: { capturedAt: -1, referencedTabs: [] },
        },
      },
      '<root>.input.browserContext.capturedAt',
    ],
    [
      {
        type: 'approval.response',
        submissionId: 'approval-1',
        approvalId: 'approval-1',
        decision: { kind: 'allow-everything' },
      },
      '<root>.decision.kind',
    ],
    [
      {
        type: 'interaction.response',
        submissionId: 'interaction-2',
        interactionId: 'interaction-2',
        response: { kind: 'finished' },
      },
      '<root>.response.kind',
    ],
  ])('rejects invalid engine command envelopes %#', (value, diagnosticPath) => {
    const parsed = parseOp(value);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.diagnostic).toContain(diagnosticPath);
  });

  it.each([
    [
      {
        type: 'turn.complete',
        threadId: 'thread-1',
        turnId: 'turn-1',
        stopReason: 'done',
        stream: { threadId: 'thread-1', epoch: 0, sequence: 1 },
      },
      '<root>.stream.epoch',
    ],
    [
      {
        type: 'turn.start',
        threadId: 'thread-1',
        turnId: 'turn-1',
        turnKind: 'user',
        steerable: true,
        stream: { threadId: 'thread-2', epoch: 1, sequence: 1 },
      },
      '<root>.stream.threadId',
    ],
    [
      {
        type: 'error',
        threadId: 'thread-1',
        code: 'internal',
        message: 'failed',
        retryable: false,
      },
      '<root>.stream',
    ],
    [{ type: 'future.event' }, '<root>.type'],
  ])('rejects invalid engine event envelopes %#', (value, diagnosticPath) => {
    const parsed = parseAgentEvent(value);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.diagnostic).toContain(diagnosticPath);
  });

  it('preserves identifiers in malformed-envelope diagnostics', () => {
    expect(
      parseOp({ type: 'turn.interrupt', submissionId: 'submit-bad', threadId: 17 }),
    ).toMatchObject({ ok: false, submissionId: 'submit-bad' });
    expect(
      parseContentScriptResult({
        protocol: CONTENT_SCRIPT_PROTOCOL,
        schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
        requestId: 'request-bad',
        ok: false,
        error: 17,
      }),
    ).toMatchObject({ ok: false, requestId: 'request-bad' });
  });

  it('requires complete content-script envelopes and request ownership fields', () => {
    expect(
      parseContentScriptOp({
        protocol: CONTENT_SCRIPT_PROTOCOL,
        schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
        kind: 'execute',
        requestId: 'execute-1',
        tool: 'click',
        deadlineAt: 100,
      }).ok,
    ).toBe(false);
    expect(
      parseContentScriptResult({
        protocol: CONTENT_SCRIPT_PROTOCOL,
        schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
        requestId: '',
        ok: true,
        result: 'pong',
      }).ok,
    ).toBe(false);
  });
});
