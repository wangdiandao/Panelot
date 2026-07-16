import {
  ENGINE_PROTOCOL,
  ENGINE_SCHEMA_HASH,
  type AgentEvent,
  type ThreadStreamCursor,
} from './protocol';
import type { ProtocolParseResult } from './validation';

type ObjectValue = Record<string, unknown>;
type Check = (value: unknown, path: string) => string | undefined;

const isObject = (value: unknown): value is ObjectValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const expected = (path: string, description: string) => `${path}: expected ${description}`;
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

function literal<T extends string>(expectedValue: T): Check {
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

function field(value: ObjectValue, key: string, check: Check, path: string) {
  return check(value[key], `${path}.${key}`);
}

function optionalField(value: ObjectValue, key: string, check: Check, path: string) {
  return value[key] === undefined ? undefined : check(value[key], `${path}.${key}`);
}

function requiredField(value: ObjectValue, key: string, path: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
    ? undefined
    : expected(`${path}.${key}`, 'present value');
}

function first(...issues: (string | undefined)[]) {
  return issues.find((issue): issue is string => issue !== undefined);
}

function recordCheck(
  value: unknown,
  path: string,
  validate: (record: ObjectValue, path: string) => string | undefined,
) {
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
      optionalField(
        state,
        'pendingInteractions',
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

function threadStream(event: ObjectValue, path = '<root>') {
  const issue = field(event, 'stream', streamCursor, path);
  if (issue) return issue;
  const stream = event.stream as ThreadStreamCursor;
  return typeof event.threadId === 'string' && stream.threadId !== event.threadId
    ? `${path}.stream.threadId: does not match event threadId`
    : undefined;
}

function validateInitialized(event: ObjectValue) {
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
    case 'pong':
      return submission();
    case 'command.rejected':
      return first(
        submission(),
        field(value, 'code', nonEmptyString, '<root>'),
        field(value, 'message', stringValue, '<root>'),
      );
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
      if (value.threadId && value.stream === undefined)
        return '<root>.stream: thread error requires stream cursor';
      return value.threadId && value.stream ? threadStream(value) : undefined;
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
    case 'interaction.request':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(value, 'interactionId', nonEmptyString, '<root>'),
        field(value, 'itemId', nonEmptyString, '<root>'),
        field(value, 'request', objectValue, '<root>'),
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
                optionalField(activity, 'pendingInteractions', nonNegativeInteger, nested),
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
  if (!diagnostic) return { ok: true, value: value as AgentEvent };
  const submissionId =
    isObject(value) && typeof value.submissionId === 'string' ? value.submissionId : undefined;
  return { ok: false, diagnostic, ...(submissionId ? { submissionId } : {}) };
}
