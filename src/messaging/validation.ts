import {
  CONTENT_SCRIPT_PROTOCOL,
  CONTENT_SCRIPT_SCHEMA_HASH,
  ENGINE_PROTOCOL,
  ENGINE_SCHEMA_HASH,
  type AgentEvent,
  type ContentScriptOp,
  type ContentScriptResult,
  type Op,
  type ThreadStreamCursor,
} from './protocol';

export type ProtocolParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostic: string; submissionId?: string; requestId?: string };

type ObjectValue = Record<string, unknown>;
type Check = (value: unknown, path: string) => string | undefined;

const isObject = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const expected = (path: string, description: string): string => `${path}: expected ${description}`;

const stringValue: Check = (value, path) =>
  typeof value === 'string' ? undefined : expected(path, 'string');

const nonEmptyString: Check = (value, path) =>
  typeof value === 'string' && value.length > 0 ? undefined : expected(path, 'non-empty string');

const numberValue: Check = (value, path) =>
  typeof value === 'number' && Number.isFinite(value) ? undefined : expected(path, 'finite number');

const nonNegativeInteger: Check = (value, path) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? undefined
    : expected(path, 'non-negative integer');

const positiveInteger: Check = (value, path) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? undefined
    : expected(path, 'positive integer');

const booleanValue: Check = (value, path) =>
  typeof value === 'boolean' ? undefined : expected(path, 'boolean');

const objectValue: Check = (value, path) =>
  isObject(value) ? undefined : expected(path, 'object');

function literal<T extends string | boolean>(expectedValue: T): Check {
  return (value, path) =>
    value === expectedValue ? undefined : expected(path, JSON.stringify(expectedValue));
}

function oneOf(values: readonly string[]): Check {
  return (value, path) =>
    typeof value === 'string' && values.includes(value)
      ? undefined
      : expected(path, values.join(' | '));
}

function arrayOf(item: Check): Check {
  return (value, path) => {
    if (!Array.isArray(value)) return expected(path, 'array');
    for (let index = 0; index < value.length; index += 1) {
      const issue = item(value[index], `${path}.${index}`);
      if (issue) return issue;
    }
    return undefined;
  };
}

function field(value: ObjectValue, key: string, check: Check, path: string): string | undefined {
  return check(value[key], `${path}.${key}`);
}

function optionalField(
  value: ObjectValue,
  key: string,
  check: Check,
  path: string,
): string | undefined {
  return value[key] === undefined ? undefined : check(value[key], `${path}.${key}`);
}

function requiredField(value: ObjectValue, key: string, path: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? undefined
    : expected(`${path}.${key}`, 'present value');
}

function first(...issues: (string | undefined)[]): string | undefined {
  return issues.find((issue): issue is string => issue !== undefined);
}

function recordCheck(
  value: unknown,
  path: string,
  validate: (record: ObjectValue, path: string) => string | undefined,
): string | undefined {
  return isObject(value) ? validate(value, path) : expected(path, 'object');
}

const tabIdentity: Check = (value, path) =>
  recordCheck(value, path, (tab, current) =>
    first(
      field(tab, 'tabId', nonNegativeInteger, current),
      field(tab, 'url', stringValue, current),
      field(tab, 'title', stringValue, current),
    ),
  );

const browserContext: Check = (value, path) =>
  recordCheck(value, path, (context, current) =>
    first(
      field(context, 'capturedAt', nonNegativeInteger, current),
      optionalField(context, 'defaultTab', tabIdentity, current),
      field(context, 'referencedTabs', arrayOf(tabIdentity), current),
    ),
  );

const contentBlock: Check = (value, path) =>
  recordCheck(value, path, (block, current) => {
    if (block.type === 'text') return field(block, 'text', stringValue, current);
    if (block.type === 'image') {
      return first(
        field(block, 'mime', nonEmptyString, current),
        field(block, 'data', stringValue, current),
      );
    }
    return expected(`${current}.type`, 'text | image');
  });

const contextBlock: Check = (value, path) =>
  recordCheck(value, path, (context, current) =>
    first(
      field(
        context,
        'kind',
        oneOf(['page', 'selection', 'screenshot', 'tab', 'mcp_resource', 'file', 'skill']),
        current,
      ),
      field(context, 'label', stringValue, current),
      optionalField(context, 'origin', stringValue, current),
      optionalField(context, 'trust', oneOf(['trusted', 'untrusted']), current),
      optionalField(
        context,
        'provenance',
        oneOf(['user', 'page', 'mcp', 'tool', 'import', 'plugin']),
        current,
      ),
      optionalField(context, 'sourceRef', stringValue, current),
      optionalField(context, 'tab', tabIdentity, current),
      field(context, 'content', arrayOf(contentBlock), current),
      optionalField(context, 'approxTokens', nonNegativeInteger, current),
    ),
  );

const userInput: Check = (value, path) =>
  recordCheck(value, path, (input, current) =>
    first(
      field(input, 'text', stringValue, current),
      optionalField(input, 'attachmentIds', arrayOf(nonEmptyString), current),
      optionalField(input, 'attachedContext', arrayOf(contextBlock), current),
      optionalField(input, 'browserContext', browserContext, current),
    ),
  );

const turnOverrides: Check = (value, path) =>
  recordCheck(value, path, (overrides, current) => {
    const model = optionalField(
      overrides,
      'model',
      (modelValue, modelPath) =>
        recordCheck(modelValue, modelPath, (record, nested) =>
          first(
            field(record, 'connectionId', nonEmptyString, nested),
            field(record, 'modelId', nonEmptyString, nested),
          ),
        ),
      current,
    );
    return first(
      model,
      optionalField(overrides, 'permissionPolicy', oneOf(['always', 'untrusted', 'auto']), current),
      optionalField(
        overrides,
        'enabledToolLevels',
        arrayOf(oneOf(['L0', 'L1', 'L2', 'mcp'])),
        current,
      ),
    );
  });

const approvalDecision: Check = (value, path) =>
  recordCheck(value, path, (decision, current) => {
    if (
      decision.kind === 'accept' ||
      decision.kind === 'acceptForSession' ||
      decision.kind === 'acceptForSite' ||
      decision.kind === 'cancel'
    ) {
      return undefined;
    }
    if (decision.kind === 'decline') {
      return optionalField(decision, 'note', stringValue, current);
    }
    return expected(`${current}.kind`, 'valid approval decision');
  });

const streamCursor: Check = (value, path) =>
  recordCheck(value, path, (stream, current) =>
    first(
      field(stream, 'threadId', nonEmptyString, current),
      field(stream, 'epoch', positiveInteger, current),
      field(stream, 'sequence', positiveInteger, current),
    ),
  );

const snapshotMeta: Check = (value, path) =>
  recordCheck(value, path, (meta, current) =>
    first(
      field(meta, 'id', nonEmptyString, current),
      field(meta, 'revision', nonNegativeInteger, current),
      field(meta, 'title', stringValue, current),
      field(meta, 'createdAt', nonNegativeInteger, current),
      field(meta, 'updatedAt', nonNegativeInteger, current),
      meta.leafId === null ? undefined : field(meta, 'leafId', stringValue, current),
      optionalField(meta, 'preset', stringValue, current),
      field(meta, 'archived', booleanValue, current),
      field(meta, 'pinned', booleanValue, current),
      field(
        meta,
        'stats',
        (statsValue, statsPath) =>
          recordCheck(statsValue, statsPath, (stats, nested) =>
            first(
              field(stats, 'turns', nonNegativeInteger, nested),
              field(stats, 'totalTokens', nonNegativeInteger, nested),
              field(stats, 'costUsd', numberValue, nested),
            ),
          ),
        current,
      ),
    ),
  );

const snapshotItem: Check = (value, path) =>
  recordCheck(value, path, (item, current) =>
    first(
      field(item, 'nodeId', nonEmptyString, current),
      field(item, 'kind', nonEmptyString, current),
      field(item, 'ts', nonNegativeInteger, current),
      requiredField(item, 'payload', current),
    ),
  );

const snapshot: Check = (value, path) =>
  recordCheck(value, path, (state, current) =>
    first(
      field(state, 'stream', streamCursor, current),
      field(state, 'meta', snapshotMeta, current),
      field(state, 'items', arrayOf(snapshotItem), current),
      requiredField(state, 'activeTurn', current),
      field(
        state,
        'pendingApprovals',
        arrayOf(() => undefined),
        current,
      ),
      field(state, 'queuedInputs', nonNegativeInteger, current),
      field(
        state,
        'queuedRuns',
        arrayOf(() => undefined),
        current,
      ),
      field(
        state,
        'recoverableRuns',
        arrayOf(() => undefined),
        current,
      ),
    ),
  );

function idFrom(value: unknown, key: 'submissionId' | 'requestId'): string | undefined {
  if (!isObject(value)) return undefined;
  const id = value[key];
  return typeof id === 'string' && id ? id : undefined;
}

function failed<T>(
  diagnostic: string,
  ids: { submissionId?: string; requestId?: string },
): ProtocolParseResult<T> {
  return { ok: false, diagnostic, ...ids };
}

function valid<T>(value: unknown): ProtocolParseResult<T> {
  return { ok: true, value: value as T };
}

function validateOp(value: unknown): string | undefined {
  if (!isObject(value)) return expected('<root>', 'object');
  const base = first(
    field(value, 'type', nonEmptyString, '<root>'),
    field(value, 'submissionId', nonEmptyString, '<root>'),
  );
  if (base) return base;

  const thread = () => field(value, 'threadId', nonEmptyString, '<root>');
  const input = () => field(value, 'input', userInput, '<root>');
  const overrides = () => optionalField(value, 'overrides', turnOverrides, '<root>');
  switch (value.type) {
    case 'initialize':
      return first(
        optionalField(value, 'protocol', stringValue, '<root>'),
        optionalField(value, 'schemaHash', stringValue, '<root>'),
        optionalField(value, 'clientId', stringValue, '<root>'),
        optionalField(value, 'protocolVersion', nonNegativeInteger, '<root>'),
        optionalField(
          value,
          'subscribe',
          (subscribe, path) =>
            recordCheck(subscribe, path, (record, nested) =>
              field(record, 'threadId', nonEmptyString, nested),
            ),
          '<root>',
        ),
      );
    case 'thread.create':
      return first(
        optionalField(value, 'preset', stringValue, '<root>'),
        optionalField(value, 'folderId', stringValue, '<root>'),
      );
    case 'thread.subscribe':
      return thread();
    case 'thread.fork':
      return first(thread(), field(value, 'atNodeId', nonEmptyString, '<root>'));
    case 'thread.selectBranch':
      return first(thread(), field(value, 'nodeId', nonEmptyString, '<root>'));
    case 'turn.submit':
    case 'turn.enqueue':
      return first(thread(), input(), overrides());
    case 'turn.fork':
      return first(
        thread(),
        field(value, 'siblingOfNodeId', nonEmptyString, '<root>'),
        input(),
        overrides(),
      );
    case 'turn.steer':
      return first(thread(), field(value, 'expectedTurnId', nonEmptyString, '<root>'), input());
    case 'turn.interrupt':
      return thread();
    case 'queue.update':
      return first(thread(), field(value, 'runId', nonEmptyString, '<root>'), input(), overrides());
    case 'queue.remove':
    case 'run.resume':
      return first(thread(), field(value, 'runId', nonEmptyString, '<root>'));
    case 'run.resolveUncertain':
      return first(
        thread(),
        field(value, 'runId', nonEmptyString, '<root>'),
        field(value, 'resolution', oneOf(['retry', 'mark_done', 'fail']), '<root>'),
      );
    case 'approval.response':
      return first(
        field(value, 'approvalId', nonEmptyString, '<root>'),
        field(value, 'decision', approvalDecision, '<root>'),
      );
    case 'ping':
      return undefined;
    default:
      return expected('<root>.type', 'known engine command');
  }
}

export function parseOp(value: unknown): ProtocolParseResult<Op> {
  const diagnostic = validateOp(value);
  return diagnostic
    ? failed(diagnostic, { submissionId: idFrom(value, 'submissionId') })
    : valid<Op>(value);
}

function threadStream(event: ObjectValue, path = '<root>'): string | undefined {
  const issue = field(event, 'stream', streamCursor, path);
  if (issue) return issue;
  const stream = event.stream as ThreadStreamCursor;
  return typeof event.threadId === 'string' && stream.threadId !== event.threadId
    ? `${path}.stream.threadId: does not match event threadId`
    : undefined;
}

function validateInitialized(event: ObjectValue): string | undefined {
  const issue = first(
    field(event, 'submissionId', nonEmptyString, '<root>'),
    field(event, 'protocol', literal(ENGINE_PROTOCOL), '<root>'),
    field(event, 'schemaHash', literal(ENGINE_SCHEMA_HASH), '<root>'),
    optionalField(event, 'stream', streamCursor, '<root>'),
    optionalField(event, 'snapshot', snapshot, '<root>'),
  );
  if (issue || event.snapshot === undefined) return issue;
  if (event.stream === undefined) return '<root>.stream: snapshot event requires stream cursor';
  const stream = event.stream as ThreadStreamCursor;
  const state = event.snapshot as { stream: ThreadStreamCursor; meta: { id: string } };
  if (new Set([stream.threadId, state.stream.threadId, state.meta.id]).size !== 1) {
    return '<root>.snapshot: snapshot thread identity mismatch';
  }
  if (stream.epoch !== state.stream.epoch || stream.sequence !== state.stream.sequence) {
    return '<root>.snapshot.stream: snapshot cursor mismatch';
  }
  return undefined;
}

function validateAgentEvent(value: unknown): string | undefined {
  if (!isObject(value)) return expected('<root>', 'object');
  const typeIssue = field(value, 'type', nonEmptyString, '<root>');
  if (typeIssue) return typeIssue;

  const submission = () => field(value, 'submissionId', nonEmptyString, '<root>');
  const thread = () => field(value, 'threadId', nonEmptyString, '<root>');
  const stream = () => threadStream(value);
  switch (value.type) {
    case 'initialized':
      return validateInitialized(value);
    case 'fatal.reload_required':
      return first(
        submission(),
        field(value, 'protocol', nonEmptyString, '<root>'),
        field(value, 'schemaHash', nonEmptyString, '<root>'),
        field(value, 'message', nonEmptyString, '<root>'),
      );
    case 'command.ack':
      return submission();
    case 'command.rejected':
      return first(
        submission(),
        field(value, 'code', nonEmptyString, '<root>'),
        field(value, 'message', stringValue, '<root>'),
      );
    case 'pong':
      return submission();
    case 'error': {
      const issue = first(
        field(value, 'code', nonEmptyString, '<root>'),
        field(value, 'message', stringValue, '<root>'),
        field(value, 'retryable', booleanValue, '<root>'),
        optionalField(value, 'submissionId', stringValue, '<root>'),
        optionalField(value, 'threadId', stringValue, '<root>'),
        optionalField(value, 'stream', streamCursor, '<root>'),
      );
      if (issue) return issue;
      if (value.threadId && value.stream === undefined) {
        return '<root>.stream: thread error requires stream cursor';
      }
      if (value.threadId && value.stream) return threadStream(value);
      return undefined;
    }
    case 'thread.created':
      return first(submission(), thread());
    case 'thread.forked':
      return first(submission(), thread(), field(value, 'newThreadId', nonEmptyString, '<root>'));
    case 'turn.start':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(value, 'turnKind', oneOf(['user', 'title']), '<root>'),
        field(value, 'steerable', booleanValue, '<root>'),
        stream(),
      );
    case 'turn.complete':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(
          value,
          'stopReason',
          oneOf([
            'end',
            'max_tokens',
            'content_filter',
            'done',
            'interrupted',
            'error',
            'budget_pause',
          ]),
          '<root>',
        ),
        stream(),
      );
    case 'token.usage':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(
          value,
          'usage',
          (usageValue, path) =>
            recordCheck(usageValue, path, (usage, nested) =>
              first(
                field(usage, 'input', nonNegativeInteger, nested),
                field(usage, 'output', nonNegativeInteger, nested),
                optionalField(usage, 'cacheRead', nonNegativeInteger, nested),
              ),
            ),
          '<root>',
        ),
        optionalField(value, 'costUsd', numberValue, '<root>'),
        stream(),
      );
    case 'item.start':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(value, 'itemId', nonEmptyString, '<root>'),
        field(value, 'kind', nonEmptyString, '<root>'),
        field(value, 'meta', objectValue, '<root>'),
        stream(),
      );
    case 'item.delta':
      return first(
        thread(),
        field(value, 'itemId', nonEmptyString, '<root>'),
        field(
          value,
          'delta',
          (deltaValue, path) =>
            recordCheck(deltaValue, path, (delta, nested) =>
              first(
                optionalField(delta, 'text', stringValue, nested),
                optionalField(delta, 'reasoning', stringValue, nested),
              ),
            ),
          '<root>',
        ),
        stream(),
      );
    case 'item.complete':
      return first(thread(), field(value, 'itemId', nonEmptyString, '<root>'), stream());
    case 'approval.request':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(value, 'approvalId', nonEmptyString, '<root>'),
        requiredField(value, 'request', '<root>'),
        stream(),
      );
    case 'thread.updated':
      return first(
        thread(),
        field(value, 'revision', nonNegativeInteger, '<root>'),
        field(value, 'patch', objectValue, '<root>'),
        stream(),
      );
    case 'queue.updated':
      return first(
        thread(),
        field(value, 'pending', nonNegativeInteger, '<root>'),
        field(
          value,
          'runs',
          arrayOf(() => undefined),
          '<root>',
        ),
        stream(),
      );
    case 'run.recovery_required':
      return first(thread(), requiredField(value, 'run', '<root>'), stream());
    case 'tabs.updated':
      return first(thread(), field(value, 'tabs', arrayOf(tabIdentity), '<root>'), stream());
    case 'activity.updated': {
      const issue = first(
        field(
          value,
          'activity',
          (activityValue, path) =>
            recordCheck(activityValue, path, (activity, nested) =>
              first(
                field(activity, 'threadId', nonEmptyString, nested),
                field(activity, 'running', booleanValue, nested),
                field(activity, 'pendingApprovals', nonNegativeInteger, nested),
              ),
            ),
          '<root>',
        ),
        field(value, 'stream', streamCursor, '<root>'),
      );
      if (issue) return issue;
      const activity = value.activity as { threadId: string };
      const eventStream = value.stream as ThreadStreamCursor;
      return activity.threadId === eventStream.threadId
        ? undefined
        : '<root>.stream.threadId: does not match activity threadId';
    }
    default:
      return expected('<root>.type', 'known engine event');
  }
}

export function parseAgentEvent(value: unknown): ProtocolParseResult<AgentEvent> {
  const diagnostic = validateAgentEvent(value);
  return diagnostic
    ? failed(diagnostic, { submissionId: idFrom(value, 'submissionId') })
    : valid<AgentEvent>(value);
}

function contentEnvelope(value: ObjectValue): string | undefined {
  return first(
    field(value, 'protocol', literal(CONTENT_SCRIPT_PROTOCOL), '<root>'),
    field(value, 'schemaHash', literal(CONTENT_SCRIPT_SCHEMA_HASH), '<root>'),
    field(value, 'requestId', nonEmptyString, '<root>'),
  );
}

function validateContentScriptOp(value: unknown): string | undefined {
  if (!isObject(value)) return expected('<root>', 'object');
  const envelope = contentEnvelope(value);
  if (envelope) return envelope;
  switch (value.kind) {
    case 'execute':
      return first(
        field(value, 'tool', nonEmptyString, '<root>'),
        requiredField(value, 'params', '<root>'),
        field(value, 'deadlineAt', nonNegativeInteger, '<root>'),
      );
    case 'cancel':
      return field(value, 'cancelRequestId', nonEmptyString, '<root>');
    case 'ping':
      return undefined;
    default:
      return expected('<root>.kind', 'execute | cancel | ping');
  }
}

export function parseContentScriptOp(value: unknown): ProtocolParseResult<ContentScriptOp> {
  const diagnostic = validateContentScriptOp(value);
  return diagnostic
    ? failed(diagnostic, { requestId: idFrom(value, 'requestId') })
    : valid<ContentScriptOp>(value);
}

function validateContentScriptResult(value: unknown): string | undefined {
  if (!isObject(value)) return expected('<root>', 'object');
  const envelope = contentEnvelope(value);
  if (envelope) return envelope;
  if (value.ok === true) return requiredField(value, 'result', '<root>');
  if (value.ok === false) return field(value, 'error', stringValue, '<root>');
  return expected('<root>.ok', 'true | false');
}

export function parseContentScriptResult(value: unknown): ProtocolParseResult<ContentScriptResult> {
  const diagnostic = validateContentScriptResult(value);
  return diagnostic
    ? failed(diagnostic, { requestId: idFrom(value, 'requestId') })
    : valid<ContentScriptResult>(value);
}

export function compareStreamCursor(left: ThreadStreamCursor, right: ThreadStreamCursor): number {
  return left.epoch - right.epoch || left.sequence - right.sequence;
}
