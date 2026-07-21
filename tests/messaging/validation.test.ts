import { describe, expect, it } from 'vitest';
import {
  AGENT_EVENT_TYPE_CATALOG,
  CONTENT_SCRIPT_PROTOCOL,
  CONTENT_SCRIPT_SCHEMA_HASH,
  ENGINE_PROTOCOL,
  ENGINE_SCHEMA_HASH,
  OP_TYPE_CATALOG,
} from '../../src/messaging/protocol';
import {
  parseContentScriptOp,
  parseContentScriptResult,
  parseOp,
} from '../../src/messaging/validation';
import { parseAgentEvent } from '../../src/messaging/agentEventValidation';
import { createDirectPair, decodeAgentEvent } from '../../src/messaging/transport';

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

  it('rejects cyclic, non-JSON, and pathologically deep interaction values before fingerprinting', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let depth = 0; depth < 40; depth += 1) {
      const nested: Record<string, unknown> = {};
      cursor.next = nested;
      cursor = nested;
    }

    for (const value of [cyclic, new Map([['answer', true]]), deep]) {
      expect(
        parseOp({
          type: 'interaction.response',
          submissionId: 'bounded-interaction',
          interactionId: 'interaction-1',
          response: { kind: 'submit', value },
        }),
      ).toMatchObject({ ok: false, submissionId: 'bounded-interaction' });
    }
  });

  it('rejects cross-context messages whose collection fan-out exceeds the resource budget', () => {
    const parsed = parseOp({
      type: 'turn.submit',
      submissionId: 'oversized-array',
      threadId: 'thread-1',
      input: { text: '', attachmentIds: Array.from({ length: 8_193 }, () => 'attachment') },
    });

    expect(parsed).toMatchObject({ ok: false, submissionId: 'oversized-array' });
    if (!parsed.ok) expect(parsed.diagnostic).toContain('message array is too large');
  });

  it('keeps a generous event budget while rejecting pathological snapshot fan-out', () => {
    const parsed = parseAgentEvent({
      type: 'tabs.updated',
      threadId: 'thread-1',
      tabs: Array.from({ length: 100_001 }),
      stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
    });

    expect(parsed).toMatchObject({ ok: false, kind: 'malformed' });
    if (!parsed.ok) expect(parsed.diagnostic).toContain('message array is too large');
  });

  it('accepts thread deletion commands and streamed deletion events', () => {
    expect(
      parseOp({
        type: 'thread.delete',
        submissionId: 'delete-1',
        threadId: 'thread-1',
      }).ok,
    ).toBe(true);
    expect(
      parseAgentEvent({
        type: 'thread.deleted',
        threadId: 'thread-1',
        stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
      }).ok,
    ).toBe(true);
    expect(
      parseAgentEvent({
        type: 'thread.deleted',
        threadId: 'thread-1',
      }).ok,
    ).toBe(false);
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
  ])('rejects invalid engine event envelopes %#', (value, diagnosticPath) => {
    const parsed = parseAgentEvent(value);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.diagnostic).toContain(diagnosticPath);
  });

  it('keeps protocol catalogs aligned with validator dispatch and compatibility policy', () => {
    for (const type of Object.keys(OP_TYPE_CATALOG)) {
      const parsed = parseOp({ type, submissionId: 'catalog-probe' });
      if (!parsed.ok) expect(parsed.diagnostic).not.toContain('known engine command');
    }
    for (const type of Object.keys(AGENT_EVENT_TYPE_CATALOG)) {
      expect(parseAgentEvent({ type })).toMatchObject({ ok: false, kind: 'malformed' });
    }

    const future = parseAgentEvent({ type: 'future.event', payload: { version: 2 } });
    expect(future).toMatchObject({
      ok: false,
      kind: 'unsupported',
      eventType: 'future.event',
    });
    expect(decodeAgentEvent({ type: 'future.event', payload: { version: 2 } })).toBeUndefined();
  });

  it('reports malformed known events instead of treating them as forward-compatible', () => {
    expect(
      parseAgentEvent({
        type: 'turn.start',
        threadId: 'thread-1',
        turnId: 'turn-1',
        turnKind: 'invented',
        steerable: true,
        stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
      }),
    ).toMatchObject({ ok: false, kind: 'malformed' });
    expect(
      decodeAgentEvent({
        type: 'command.rejected',
        submissionId: 'bad-known-event',
        code: 'invented',
        message: 'bad',
      }),
    ).toMatchObject({
      type: 'error',
      code: 'protocol_mismatch',
      submissionId: 'bad-known-event',
    });
  });

  it.each([
    {
      type: 'approval.request',
      threadId: 'thread-1',
      turnId: 'turn-1',
      approvalId: 'approval-1',
      request: null,
      stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
    },
    {
      type: 'interaction.request',
      threadId: 'thread-1',
      turnId: 'turn-1',
      interactionId: 'interaction-1',
      itemId: 'call-1',
      request: { kind: 'ask_user', questions: [{ id: 'choice' }] },
      stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
    },
    {
      type: 'queue.updated',
      threadId: 'thread-1',
      pending: 1,
      runs: [null],
      stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
    },
    {
      type: 'run.recovery_required',
      threadId: 'thread-1',
      run: null,
      stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
    },
  ])('rejects malformed nested payloads on known events %#', (event) => {
    expect(parseAgentEvent(event)).toMatchObject({ ok: false, kind: 'malformed' });
    expect(decodeAgentEvent(event)).toMatchObject({
      type: 'error',
      code: 'protocol_mismatch',
    });
  });

  it.each([
    ['pendingApprovals', { pendingApprovals: [null] }],
    ['pendingInteractions', { pendingInteractions: [{ interactionId: 'bad' }] }],
    ['queuedRuns', { queuedRuns: [{ runId: 'bad' }] }],
    ['recoverableRuns', { recoverableRuns: [{ runId: 'bad' }] }],
    ['activeTurn', { activeTurn: { turnId: 'bad' } }],
  ])('rejects malformed %s entries in initialized snapshots', (_label, snapshotPatch) => {
    const event = {
      type: 'initialized',
      submissionId: 'subscribe-1',
      protocol: ENGINE_PROTOCOL,
      schemaHash: ENGINE_SCHEMA_HASH,
      stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
      snapshot: {
        stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
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
        pendingInteractions: [],
        queuedInputs: 0,
        queuedRuns: [],
        recoverableRuns: [],
        ...snapshotPatch,
      },
    };

    expect(parseAgentEvent(event)).toMatchObject({ ok: false, kind: 'malformed' });
  });

  it.each([' ', '.future', 'future..event', 'turn.start\0'])(
    'classifies malformed event name %j separately from future events',
    (type) => {
      expect(parseAgentEvent({ type })).toMatchObject({ ok: false, kind: 'malformed' });
      expect(decodeAgentEvent({ type })).toMatchObject({
        type: 'error',
        code: 'protocol_mismatch',
      });
    },
  );

  it('applies the same event decoder to direct and Port-compatible transports', async () => {
    const { transport, connection } = createDirectPair();
    const events: unknown[] = [];
    transport.onEvent((event) => events.push(event));

    connection.post({
      type: 'run.recovery_required',
      threadId: 'thread-1',
      run: null,
      stream: { threadId: 'thread-1', epoch: 1, sequence: 1 },
    } as never);
    await Promise.resolve();
    expect(events).toEqual([expect.objectContaining({ type: 'error', code: 'protocol_mismatch' })]);

    connection.post({ type: 'future.event' } as never);
    await Promise.resolve();
    expect(events).toHaveLength(1);
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

  it('validates content-tool parameters at the cross-context boundary', () => {
    const envelope = {
      protocol: CONTENT_SCRIPT_PROTOCOL,
      schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
      kind: 'execute' as const,
      requestId: 'execute-params',
      deadlineAt: 100,
    };
    expect(
      parseContentScriptOp({
        ...envelope,
        tool: 'click',
        params: { ref: 'ref-1', button: 'left' },
      }).ok,
    ).toBe(true);
    expect(
      parseContentScriptOp({
        ...envelope,
        tool: 'click',
        params: { element: 'Submit', ref: 'ref-1' },
      }).ok,
    ).toBe(false);
    expect(
      parseContentScriptOp({
        ...envelope,
        tool: 'click',
        params: { ref: 17 },
      }),
    ).toMatchObject({ ok: false, requestId: 'execute-params' });
    expect(
      parseContentScriptOp({
        ...envelope,
        tool: 'unknown_tool',
        params: {},
      }).ok,
    ).toBe(false);
    expect(
      parseContentScriptOp({
        ...envelope,
        tool: 'batch_actions',
        params: { actions: [{ kind: 'type', params: { ref: 'ref-1' } }] },
      }).ok,
    ).toBe(false);
  });

  it('bounds content-script params and results before their detailed schema traversal', () => {
    const oversized = Array.from({ length: 50_001 });
    const request = parseContentScriptOp({
      protocol: CONTENT_SCRIPT_PROTOCOL,
      schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
      kind: 'execute',
      requestId: 'oversized-content-request',
      tool: 'click',
      params: { ref: 'ref-1', oversized },
      deadlineAt: 100,
    });
    expect(request).toMatchObject({ ok: false, requestId: 'oversized-content-request' });
    if (!request.ok) expect(request.diagnostic).toContain('message array is too large');

    const result = parseContentScriptResult({
      protocol: CONTENT_SCRIPT_PROTOCOL,
      schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
      requestId: 'oversized-content-result',
      ok: true,
      result: { resultText: 'done', oversized },
    });
    expect(result).toMatchObject({ ok: false, requestId: 'oversized-content-result' });
    if (!result.ok) expect(result.diagnostic).toContain('message array is too large');
  });

  it('validates content-tool results and structured failures', () => {
    const envelope = {
      protocol: CONTENT_SCRIPT_PROTOCOL,
      schemaHash: CONTENT_SCRIPT_SCHEMA_HASH,
      requestId: 'execute-result',
    };
    expect(
      parseContentScriptResult({
        ...envelope,
        ok: true,
        result: {
          resultText: 'clicked',
          rect: { x: 1, y: 2, width: 3, height: 4 },
          evidence: {
            attemptId: 'attempt-1',
            attempts: [],
            effectState: 'verified',
            observedEffects: ['focus_changed'],
            outcome: 'verified',
          },
        },
      }).ok,
    ).toBe(true);
    expect(parseContentScriptResult({ ...envelope, ok: true, result: { resultText: 17 } }).ok).toBe(
      false,
    );
    expect(
      parseContentScriptResult({
        ...envelope,
        ok: false,
        error: 'failed',
        failure: {
          code: 'stale_ref',
          message: 'stale',
          phase: 'resolve',
          retryable: true,
        },
      }).ok,
    ).toBe(true);
    expect(
      parseContentScriptResult({
        ...envelope,
        ok: false,
        error: 'failed',
        failure: { code: 'invented', message: 'bad', phase: 'resolve', retryable: true },
      }).ok,
    ).toBe(false);
  });
});
