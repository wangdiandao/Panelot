import {
  ERROR_CODE_CATALOG,
  ENGINE_PROTOCOL,
  ENGINE_SCHEMA_HASH,
  ITEM_KIND_CATALOG,
  PROVIDER_ERROR_KIND_CATALOG,
  STOP_REASON_CATALOG,
  TURN_KIND_CATALOG,
  type ApprovalFlag,
  type AgentEvent,
  type InteractionRequestPayload,
  type RunRecoveryState,
  type ThreadStreamCursor,
  isKnownAgentEventType,
} from './protocol';
import { validateCrossContextValueSize } from './resourceLimits';

export type AgentEventParseResult =
  | { ok: true; value: AgentEvent }
  | {
      ok: false;
      kind: 'malformed';
      diagnostic: string;
      submissionId?: string;
    }
  | {
      ok: false;
      kind: 'unsupported';
      diagnostic: string;
      eventType: string;
      submissionId?: string;
    };

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

const APPROVAL_FLAG_CATALOG = {
  cross_scope: true,
  sensitive_payload: true,
  escalation_l2: true,
  host_permission: true,
} as const satisfies Record<ApprovalFlag, true>;

const INTERACTION_KIND_CATALOG = {
  ask_user: true,
  user_action: true,
  watch_page: true,
  schedule: true,
  mcp_elicitation: true,
} as const satisfies Record<InteractionRequestPayload['kind'], true>;

const RECOVERY_STATE_CATALOG = {
  waiting_approval: true,
  waiting_interaction: true,
  paused_budget: true,
  paused_uncertain: true,
  interrupted: true,
} as const satisfies Record<RunRecoveryState['state'], true>;

const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/u;

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
  recordCheck(value, path, (overrides, current) =>
    first(
      optionalField(
        overrides,
        'model',
        (modelValue, modelPath) =>
          recordCheck(modelValue, modelPath, (model, nested) =>
            first(
              field(model, 'connectionId', nonEmptyString, nested),
              field(model, 'modelId', nonEmptyString, nested),
            ),
          ),
        current,
      ),
      optionalField(overrides, 'permissionPolicy', oneOf(['always', 'untrusted', 'auto']), current),
      optionalField(
        overrides,
        'enabledToolLevels',
        arrayOf(oneOf(['L0', 'L1', 'L2', 'mcp'])),
        current,
      ),
    ),
  );

const approvalRequest: Check = (value, path) =>
  recordCheck(value, path, (request, current) =>
    first(
      field(request, 'tool', nonEmptyString, current),
      field(request, 'label', nonEmptyString, current),
      requiredField(request, 'params', current),
      field(request, 'targetOrigin', stringValue, current),
      field(request, 'flags', arrayOf(oneOf(Object.keys(APPROVAL_FLAG_CATALOG))), current),
      optionalField(
        request,
        'preview',
        (previewValue, previewPath) =>
          recordCheck(previewValue, previewPath, (preview, nested) =>
            first(
              optionalField(preview, 'snapshotLine', stringValue, nested),
              optionalField(preview, 'screenshotAttachmentId', nonEmptyString, nested),
            ),
          ),
        current,
      ),
    ),
  );

const askUserOption: Check = (value, path) =>
  recordCheck(value, path, (option, current) =>
    first(
      field(option, 'value', nonEmptyString, current),
      field(option, 'label', nonEmptyString, current),
      optionalField(option, 'description', stringValue, current),
    ),
  );

const askUserQuestion: Check = (value, path) =>
  recordCheck(value, path, (question, current) =>
    first(
      field(question, 'id', nonEmptyString, current),
      field(question, 'question', nonEmptyString, current),
      optionalField(question, 'options', arrayOf(askUserOption), current),
    ),
  );

const interactionRequest: Check = (value, path) =>
  recordCheck(value, path, (request, current) => {
    const kindIssue = field(request, 'kind', oneOf(Object.keys(INTERACTION_KIND_CATALOG)), current);
    if (kindIssue) return kindIssue;
    const kind = request.kind as InteractionRequestPayload['kind'];
    switch (kind) {
      case 'ask_user':
        return field(request, 'questions', arrayOf(askUserQuestion), current);
      case 'user_action':
        return first(
          field(request, 'instruction', nonEmptyString, current),
          optionalField(request, 'tabId', nonNegativeInteger, current),
        );
      case 'watch_page':
        return first(
          field(request, 'tabId', nonNegativeInteger, current),
          field(
            request,
            'condition',
            (conditionValue, conditionPath) =>
              recordCheck(conditionValue, conditionPath, (condition, nested) => {
                const typeIssue = field(
                  condition,
                  'type',
                  oneOf(['text', 'text_gone', 'url', 'download']),
                  nested,
                );
                if (typeIssue) return typeIssue;
                return condition.type === 'download'
                  ? field(condition, 'downloadId', nonNegativeInteger, nested)
                  : field(condition, 'value', stringValue, nested);
              }),
            current,
          ),
          field(request, 'deadlineAt', nonNegativeInteger, current),
        );
      case 'schedule':
        return first(
          field(request, 'resumeAt', nonNegativeInteger, current),
          field(request, 'reason', nonEmptyString, current),
        );
      case 'mcp_elicitation':
        return first(
          field(request, 'serverId', nonEmptyString, current),
          field(request, 'message', stringValue, current),
          field(request, 'requestedSchema', objectValue, current),
        );
      default: {
        const unhandled: never = kind;
        return expected(
          `${current}.kind`,
          `handled interaction kind, received ${String(unhandled)}`,
        );
      }
    }
  });

const pendingApproval: Check = (value, path) =>
  recordCheck(value, path, (approval, current) =>
    first(
      field(approval, 'approvalId', nonEmptyString, current),
      field(approval, 'turnId', nonEmptyString, current),
      field(approval, 'request', approvalRequest, current),
      field(approval, 'requestedAt', nonNegativeInteger, current),
    ),
  );

const pendingInteraction: Check = (value, path) =>
  recordCheck(value, path, (interaction, current) =>
    first(
      field(interaction, 'interactionId', nonEmptyString, current),
      field(interaction, 'turnId', nonEmptyString, current),
      field(interaction, 'itemId', nonEmptyString, current),
      field(interaction, 'request', interactionRequest, current),
      field(interaction, 'requestedAt', nonNegativeInteger, current),
    ),
  );

const queuedRun: Check = (value, path) =>
  recordCheck(value, path, (run, current) =>
    first(
      field(run, 'runId', nonEmptyString, current),
      field(run, 'input', userInput, current),
      optionalField(run, 'overrides', turnOverrides, current),
      field(run, 'revision', nonNegativeInteger, current),
    ),
  );

const recoveryTarget: Check = (value, path) =>
  recordCheck(value, path, (target, current) =>
    first(
      optionalField(target, 'tabId', nonNegativeInteger, current),
      optionalField(target, 'frameId', nonNegativeInteger, current),
      optionalField(target, 'origin', stringValue, current),
      optionalField(target, 'serverId', nonEmptyString, current),
    ),
  );

const pendingRecoveryTool: Check = (value, path) =>
  recordCheck(value, path, (tool, current) =>
    first(
      field(tool, 'toolName', nonEmptyString, current),
      requiredField(tool, 'params', current),
      optionalField(tool, 'target', recoveryTarget, current),
      field(tool, 'effect', oneOf(['read', 'write']), current),
      field(tool, 'recovery', oneOf(['retry-safe', 'inspect-first', 'never-retry']), current),
    ),
  );

const runRecoveryState: Check = (value, path) =>
  recordCheck(value, path, (run, current) =>
    first(
      field(run, 'runId', nonEmptyString, current),
      field(run, 'state', oneOf(Object.keys(RECOVERY_STATE_CATALOG)), current),
      field(run, 'revision', nonNegativeInteger, current),
      optionalField(run, 'stopReason', stringValue, current),
      optionalField(run, 'pendingTool', pendingRecoveryTool, current),
    ),
  );

const activeTurn: Check = (value, path) =>
  recordCheck(value, path, (turn, current) =>
    first(
      // An interrupted legacy turn is represented by an empty id until the
      // user explicitly resumes it.
      field(turn, 'turnId', stringValue, current),
      field(turn, 'turnKind', oneOf(Object.keys(TURN_KIND_CATALOG)), current),
      field(turn, 'steerable', booleanValue, current),
      field(turn, 'startedAt', nonNegativeInteger, current),
      optionalField(turn, 'wasInterrupted', booleanValue, current),
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
      field(
        item,
        'kind',
        oneOf([
          'user_message',
          'assistant_message',
          'tool_call',
          'tool_result',
          'approval_decision',
          'system_notice',
        ]),
        current,
      ),
      field(item, 'ts', nonNegativeInteger, current),
      requiredField(item, 'payload', current),
      optionalField(
        item,
        'branch',
        (branchValue, branchPath) =>
          recordCheck(branchValue, branchPath, (branch, nested) => {
            const issue = first(
              field(branch, 'index', positiveInteger, nested),
              field(branch, 'count', positiveInteger, nested),
            );
            if (issue) return issue;
            return (branch.index as number) <= (branch.count as number)
              ? undefined
              : `${nested}.index: must not exceed branch count`;
          }),
        current,
      ),
    ),
  );

const snapshot: Check = (value, path) =>
  recordCheck(value, path, (state, current) =>
    first(
      field(state, 'stream', streamCursor, current),
      field(state, 'meta', snapshotMeta, current),
      field(state, 'items', arrayOf(snapshotItem), current),
      state.activeTurn === null ? undefined : field(state, 'activeTurn', activeTurn, current),
      field(state, 'pendingApprovals', arrayOf(pendingApproval), current),
      optionalField(state, 'pendingInteractions', arrayOf(pendingInteraction), current),
      field(state, 'queuedInputs', nonNegativeInteger, current),
      field(state, 'queuedRuns', arrayOf(queuedRun), current),
      field(state, 'recoverableRuns', arrayOf(runRecoveryState), current),
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

function validateKnownAgentEvent(
  value: ObjectValue & { type: AgentEvent['type'] },
): string | undefined {
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
      return first(
        submission(),
        optionalField(value, 'threadId', nonEmptyString, '<root>'),
        optionalField(value, 'runId', nonEmptyString, '<root>'),
        optionalField(value, 'revision', nonNegativeInteger, '<root>'),
      );
    case 'pong':
      return submission();
    case 'command.rejected':
      return first(
        submission(),
        field(value, 'code', oneOf(Object.keys(ERROR_CODE_CATALOG)), '<root>'),
        field(value, 'message', stringValue, '<root>'),
        optionalField(value, 'threadId', nonEmptyString, '<root>'),
        optionalField(value, 'revision', nonNegativeInteger, '<root>'),
      );
    case 'error': {
      const issue = first(
        field(value, 'code', oneOf(Object.keys(ERROR_CODE_CATALOG)), '<root>'),
        field(value, 'message', stringValue, '<root>'),
        field(value, 'retryable', booleanValue, '<root>'),
        optionalField(value, 'submissionId', stringValue, '<root>'),
        optionalField(value, 'threadId', stringValue, '<root>'),
        optionalField(
          value,
          'errorKind',
          oneOf(Object.keys(PROVIDER_ERROR_KIND_CATALOG)),
          '<root>',
        ),
        optionalField(value, 'providerDetails', objectValue, '<root>'),
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
    case 'thread.deleted':
      return first(thread(), stream());
    case 'turn.start':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(value, 'turnKind', oneOf(Object.keys(TURN_KIND_CATALOG)), '<root>'),
        field(value, 'steerable', booleanValue, '<root>'),
        stream(),
      );
    case 'turn.complete':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(value, 'stopReason', oneOf(Object.keys(STOP_REASON_CATALOG)), '<root>'),
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
        field(value, 'kind', oneOf(Object.keys(ITEM_KIND_CATALOG)), '<root>'),
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
      return first(
        thread(),
        field(value, 'itemId', nonEmptyString, '<root>'),
        optionalField(
          value,
          'result',
          (resultValue, path) =>
            recordCheck(resultValue, path, (result, nested) =>
              field(result, 'ok', booleanValue, nested),
            ),
          '<root>',
        ),
        stream(),
      );
    case 'approval.request':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(value, 'approvalId', nonEmptyString, '<root>'),
        field(value, 'request', approvalRequest, '<root>'),
        stream(),
      );
    case 'interaction.request':
      return first(
        thread(),
        field(value, 'turnId', nonEmptyString, '<root>'),
        field(value, 'interactionId', nonEmptyString, '<root>'),
        field(value, 'itemId', nonEmptyString, '<root>'),
        field(value, 'request', interactionRequest, '<root>'),
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
        field(value, 'runs', arrayOf(queuedRun), '<root>'),
        stream(),
      );
    case 'run.recovery_required':
      return first(thread(), field(value, 'run', runRecoveryState, '<root>'), stream());
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
    default: {
      const unhandled: never = value.type;
      return expected('<root>.type', `handled engine event, received ${String(unhandled)}`);
    }
  }
}

export function parseAgentEvent(value: unknown): AgentEventParseResult {
  const submissionId =
    isObject(value) && typeof value.submissionId === 'string' ? value.submissionId : undefined;
  if (!isObject(value)) {
    return { ok: false, kind: 'malformed', diagnostic: expected('<root>', 'object') };
  }
  const resourceIssue = validateCrossContextValueSize(value, '<root>', {
    maxDepth: 96,
    maxNodes: 250_000,
    maxArrayLength: 100_000,
    maxObjectKeys: 16_384,
    maxStringCodeUnits: 128 * 1_024 * 1_024,
    maxBinaryBytes: 128 * 1_024 * 1_024,
  });
  if (resourceIssue) {
    return {
      ok: false,
      kind: 'malformed',
      diagnostic: resourceIssue,
      ...(submissionId ? { submissionId } : {}),
    };
  }
  const typeIssue = field(value, 'type', nonEmptyString, '<root>');
  if (typeIssue) {
    return {
      ok: false,
      kind: 'malformed',
      diagnostic: typeIssue,
      ...(submissionId ? { submissionId } : {}),
    };
  }
  if (!EVENT_TYPE_PATTERN.test(value.type as string)) {
    return {
      ok: false,
      kind: 'malformed',
      diagnostic: expected('<root>.type', 'stable dot-separated event name'),
      ...(submissionId ? { submissionId } : {}),
    };
  }
  if (!isKnownAgentEventType(value.type)) {
    return {
      ok: false,
      kind: 'unsupported',
      diagnostic: `<root>.type: unsupported engine event ${JSON.stringify(value.type)}`,
      eventType: value.type as string,
      ...(submissionId ? { submissionId } : {}),
    };
  }
  const diagnostic = validateKnownAgentEvent(value as ObjectValue & { type: AgentEvent['type'] });
  if (!diagnostic) return { ok: true, value: value as AgentEvent };
  return {
    ok: false,
    kind: 'malformed',
    diagnostic,
    ...(submissionId ? { submissionId } : {}),
  };
}
