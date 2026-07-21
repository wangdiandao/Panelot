import {
  CONTENT_SCRIPT_PROTOCOL,
  CONTENT_SCRIPT_SCHEMA_HASH,
  type ContentScriptOp,
  type ContentScriptResult,
  type Op,
  type ThreadStreamCursor,
} from './protocol';
import {
  parseContentToolCall,
  validateActionFailure,
  validateExecuteResult,
} from '../tools/content/protocol';
import { validateBoundedJsonValue, validateCrossContextValueSize } from './resourceLimits';

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

const nonNegativeInteger: Check = (value, path) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? undefined
    : expected(path, 'non-negative integer');

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

const interactionResponse: Check = (value, path) =>
  recordCheck(value, path, (response, current) => {
    if (response.kind === 'submit') {
      return first(
        requiredField(response, 'value', current),
        validateBoundedJsonValue(response.value, `${current}.value`, {
          maxDepth: 32,
          maxNodes: 10_000,
          maxArrayLength: 4_096,
          maxObjectKeys: 4_096,
          maxStringCodeUnits: 8 * 1_024 * 1_024,
        }),
      );
    }
    if (response.kind === 'cancel') return optionalField(response, 'note', stringValue, current);
    if (response.kind === 'timeout') return undefined;
    return expected(`${current}.kind`, 'submit | cancel | timeout');
  });

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
  const type = value.type as Op['type'];
  switch (type) {
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
    case 'thread.delete':
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
    case 'interaction.response':
      return first(
        field(value, 'interactionId', nonEmptyString, '<root>'),
        field(value, 'response', interactionResponse, '<root>'),
      );
    case 'ping':
      return undefined;
    default: {
      const unsupported: never = type;
      return expected('<root>.type', `known engine command, received ${String(unsupported)}`);
    }
  }
}

export function parseOp(value: unknown): ProtocolParseResult<Op> {
  const resourceIssue = validateCrossContextValueSize(
    value,
    '<root>',
    {
      maxDepth: 64,
      maxNodes: 25_000,
      maxArrayLength: 8_192,
      maxObjectKeys: 8_192,
      maxStringCodeUnits: 32 * 1_024 * 1_024,
      maxBinaryBytes: 32 * 1_024 * 1_024,
    },
    { rejectCycles: true },
  );
  if (resourceIssue) {
    return failed(resourceIssue, { submissionId: idFrom(value, 'submissionId') });
  }
  const diagnostic = validateOp(value);
  return diagnostic
    ? failed(diagnostic, { submissionId: idFrom(value, 'submissionId') })
    : valid<Op>(value);
}

function contentEnvelope(value: ObjectValue): string | undefined {
  return first(
    field(value, 'protocol', literal(CONTENT_SCRIPT_PROTOCOL), '<root>'),
    field(value, 'schemaHash', literal(CONTENT_SCRIPT_SCHEMA_HASH), '<root>'),
    field(value, 'requestId', nonEmptyString, '<root>'),
  );
}

const CONTENT_SCRIPT_RESOURCE_LIMITS = {
  maxDepth: 64,
  maxNodes: 150_000,
  maxArrayLength: 50_000,
  maxObjectKeys: 16_384,
  maxStringCodeUnits: 64 * 1_024 * 1_024,
  maxBinaryBytes: 64 * 1_024 * 1_024,
} as const;

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
        typeof value.tool === 'string' && Object.hasOwn(value, 'params')
          ? (() => {
              const parsed = parseContentToolCall(value.tool, value.params);
              return parsed.ok ? undefined : `<root>.${parsed.diagnostic}`;
            })()
          : undefined,
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
  const resourceIssue = validateCrossContextValueSize(
    value,
    '<root>',
    CONTENT_SCRIPT_RESOURCE_LIMITS,
    { rejectCycles: true },
  );
  if (resourceIssue) return failed(resourceIssue, { requestId: idFrom(value, 'requestId') });
  const diagnostic = validateContentScriptOp(value);
  return diagnostic
    ? failed(diagnostic, { requestId: idFrom(value, 'requestId') })
    : valid<ContentScriptOp>(value);
}

function validateContentScriptResult(value: unknown): string | undefined {
  if (!isObject(value)) return expected('<root>', 'object');
  const envelope = contentEnvelope(value);
  if (envelope) return envelope;
  if (value.ok === true) {
    const required = requiredField(value, 'result', '<root>');
    if (required) return required;
    if (value.result === 'pong' || value.result === 'cancelled') return undefined;
    const diagnostic = validateExecuteResult(value.result);
    return diagnostic ? `<root>.${diagnostic}` : undefined;
  }
  if (value.ok === false) {
    return first(
      field(value, 'error', stringValue, '<root>'),
      Object.hasOwn(value, 'failure') && value.failure !== undefined
        ? (() => {
            const diagnostic = validateActionFailure(value.failure);
            return diagnostic ? `<root>.${diagnostic}` : undefined;
          })()
        : undefined,
    );
  }
  return expected('<root>.ok', 'true | false');
}

export function parseContentScriptResult(value: unknown): ProtocolParseResult<ContentScriptResult> {
  const resourceIssue = validateCrossContextValueSize(
    value,
    '<root>',
    CONTENT_SCRIPT_RESOURCE_LIMITS,
    { rejectCycles: true },
  );
  if (resourceIssue) return failed(resourceIssue, { requestId: idFrom(value, 'requestId') });
  const diagnostic = validateContentScriptResult(value);
  return diagnostic
    ? failed(diagnostic, { requestId: idFrom(value, 'requestId') })
    : valid<ContentScriptResult>(value);
}

export function compareStreamCursor(left: ThreadStreamCursor, right: ThreadStreamCursor): number {
  return left.epoch - right.epoch || left.sequence - right.sequence;
}
