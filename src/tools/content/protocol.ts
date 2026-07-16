import { schema, type Infer, type RuntimeSchema } from '../../agent/schema';
import type { ActionFailure } from '../action/types';

export const contentToolFieldSchemas = {
  element: schema.string({
    description: 'Human-readable description of the element, shown to the user in approvals',
  }),
  ref: schema.string({
    min: 1,
    description:
      'Exact opaque ref copied from the latest snapshot. Re-run read_page when it is stale.',
  }),
} as const;

const optionalRecovery = schema.optional(schema.boolean());

export const contentToolParameterShapes = {
  read_page: {
    mode: schema.optional(schema.enum(['snapshot', 'article'])),
    maxTokens: schema.optional(schema.number({ min: 0, max: 6000 })),
  },
  find_in_page: { query: schema.string({ min: 1 }) },
  extract: {
    scope: schema.optional(
      schema.string({
        description: 'Ref of a container from the latest snapshot to limit extraction',
      }),
    ),
  },
  get_selection: {},
  get_rect: {
    ref: contentToolFieldSchemas.ref,
    coordinateSpace: schema.optional(schema.enum(['viewport', 'document'])),
  },
  validate_ref: { ref: contentToolFieldSchemas.ref },
  annotate_refs: {},
  clear_annotations: {},
  click: {
    ref: contentToolFieldSchemas.ref,
    button: schema.optional(schema.enum(['left', 'right'])),
    doubleClick: schema.optional(schema.boolean()),
  },
  type: {
    ref: contentToolFieldSchemas.ref,
    text: schema.string(),
    mode: schema.optional(schema.enum(['replace', 'append'])),
    submit: schema.optional(schema.boolean()),
    slowly: schema.optional(schema.boolean()),
  },
  select_option: {
    ref: contentToolFieldSchemas.ref,
    values: schema.array(schema.string(), { min: 1 }),
  },
  focus: { ref: contentToolFieldSchemas.ref },
  press_key: { key: schema.string({ min: 1 }) },
  scroll: {
    target: schema.optional(schema.string({ min: 1 })),
    direction: schema.enum(['up', 'down']),
    amount: schema.optional(
      schema.union([schema.enum(['page', 'end']), schema.number({ min: 0 })]),
    ),
  },
  hover: {
    ref: contentToolFieldSchemas.ref,
  },
  wait_for: {
    text: schema.optional(schema.string()),
    textGone: schema.optional(schema.union([schema.boolean(), schema.string()])),
    timeMs: schema.optional(schema.number({ min: 0, max: 30_000 })),
  },
  batch_actions: {
    actions: schema.array(
      schema.object({
        kind: schema.enum(['click', 'type', 'select_option']),
        params: schema.record(schema.string(), schema.unknown()),
      }),
      { min: 1, max: 4 },
    ),
  },
  upload: {
    ref: contentToolFieldSchemas.ref,
    filename: schema.string({ min: 1 }),
    mime: schema.string({ min: 1 }),
    base64: schema.string(),
  },
} as const;

const readPageParams = schema.object(contentToolParameterShapes.read_page);
const findInPageParams = schema.object(contentToolParameterShapes.find_in_page);
const extractParams = schema.object(contentToolParameterShapes.extract);
const emptyParams = schema.object(contentToolParameterShapes.get_selection);
const refParams = schema.object(contentToolParameterShapes.validate_ref);
const getRectParams = schema.object(contentToolParameterShapes.get_rect);
const clickParams = schema.object({
  ...contentToolParameterShapes.click,
  allowRecovery: optionalRecovery,
});
const typeParams = schema.object({
  ...contentToolParameterShapes.type,
  allowRecovery: optionalRecovery,
});
const selectOptionParams = schema.object({
  ...contentToolParameterShapes.select_option,
  allowRecovery: optionalRecovery,
});
const pressKeyParams = schema.object(contentToolParameterShapes.press_key);
const scrollParams = schema.object(contentToolParameterShapes.scroll);
const hoverParams = schema.object(contentToolParameterShapes.hover);
const waitForParams = schema.object(contentToolParameterShapes.wait_for);
const uploadParams = schema.object(contentToolParameterShapes.upload);

export type BatchAction =
  | { kind: 'click'; params: Infer<typeof clickParams> }
  | { kind: 'type'; params: Infer<typeof typeParams> }
  | { kind: 'select_option'; params: Infer<typeof selectOptionParams> };

export type ContentToolCall =
  | { tool: 'read_page'; params: Infer<typeof readPageParams> }
  | { tool: 'find_in_page'; params: Infer<typeof findInPageParams> }
  | { tool: 'extract'; params: Infer<typeof extractParams> }
  | { tool: 'get_selection'; params: Infer<typeof emptyParams> }
  | { tool: 'get_rect'; params: Infer<typeof getRectParams> }
  | { tool: 'validate_ref'; params: Infer<typeof refParams> }
  | { tool: 'annotate_refs'; params: Infer<typeof emptyParams> }
  | { tool: 'clear_annotations'; params: Infer<typeof emptyParams> }
  | { tool: 'click'; params: Infer<typeof clickParams> }
  | { tool: 'type'; params: Infer<typeof typeParams> }
  | { tool: 'select_option'; params: Infer<typeof selectOptionParams> }
  | { tool: 'focus'; params: Infer<typeof refParams> }
  | { tool: 'press_key'; params: Infer<typeof pressKeyParams> }
  | { tool: 'scroll'; params: Infer<typeof scrollParams> }
  | { tool: 'hover'; params: Infer<typeof hoverParams> }
  | { tool: 'wait_for'; params: Infer<typeof waitForParams> }
  | { tool: 'batch_actions'; params: { actions: BatchAction[] } }
  | { tool: 'upload'; params: Infer<typeof uploadParams> };

export interface BatchActionsParams {
  actions: BatchAction[];
}

export type ContentToolParseResult =
  { ok: true; value: ContentToolCall } | { ok: false; diagnostic: string };

function schemaDiagnostic(
  result: ReturnType<RuntimeSchema['safeParse']>,
  root = 'params',
): string | undefined {
  if (result.success) return undefined;
  const issue = result.error.issues[0];
  const path = issue?.path.length ? `.${issue.path.map(String).join('.')}` : '';
  return `${root}${path}: ${issue?.message ?? 'invalid value'}`;
}

function parseWithSchema<Tool extends ContentToolCall['tool'], Params>(
  tool: Tool,
  params: unknown,
  valueSchema: RuntimeSchema<Params>,
): ContentToolParseResult {
  const result = valueSchema.safeParse(params);
  const diagnostic = schemaDiagnostic(result);
  if (diagnostic || !result.success)
    return { ok: false, diagnostic: diagnostic ?? 'invalid params' };
  return { ok: true, value: { tool, params: result.data } as ContentToolCall };
}

function parseBatchActions(params: unknown): ContentToolParseResult {
  const outer = schema.object(contentToolParameterShapes.batch_actions).safeParse(params);
  const outerDiagnostic = schemaDiagnostic(outer);
  if (outerDiagnostic || !outer.success) {
    return { ok: false, diagnostic: outerDiagnostic ?? 'invalid params' };
  }

  const actions: BatchAction[] = [];
  for (const [index, action] of outer.data.actions.entries()) {
    const parsed = parseContentToolCall(action.kind, action.params);
    if (!parsed.ok)
      return { ok: false, diagnostic: `params.actions.${index}.${parsed.diagnostic}` };
    if (
      parsed.value.tool !== 'click' &&
      parsed.value.tool !== 'type' &&
      parsed.value.tool !== 'select_option'
    ) {
      return { ok: false, diagnostic: `params.actions.${index}.kind: unsupported batch action` };
    }
    switch (parsed.value.tool) {
      case 'click':
        actions.push({ kind: 'click', params: parsed.value.params });
        break;
      case 'type':
        actions.push({ kind: 'type', params: parsed.value.params });
        break;
      case 'select_option':
        actions.push({ kind: 'select_option', params: parsed.value.params });
        break;
    }
  }
  return { ok: true, value: { tool: 'batch_actions', params: { actions } } };
}

export function parseContentToolCall(tool: unknown, params: unknown): ContentToolParseResult {
  switch (tool) {
    case 'read_page':
      return parseWithSchema(tool, params, readPageParams);
    case 'find_in_page':
      return parseWithSchema(tool, params, findInPageParams);
    case 'extract':
      return parseWithSchema(tool, params, extractParams);
    case 'get_selection':
    case 'annotate_refs':
    case 'clear_annotations':
      return parseWithSchema(tool, params, emptyParams);
    case 'get_rect':
      return parseWithSchema(tool, params, getRectParams);
    case 'validate_ref':
    case 'focus':
      return parseWithSchema(tool, params, refParams);
    case 'click':
      return parseWithSchema(tool, params, clickParams);
    case 'type':
      return parseWithSchema(tool, params, typeParams);
    case 'select_option':
      return parseWithSchema(tool, params, selectOptionParams);
    case 'press_key':
      return parseWithSchema(tool, params, pressKeyParams);
    case 'scroll':
      return parseWithSchema(tool, params, scrollParams);
    case 'hover':
      return parseWithSchema(tool, params, hoverParams);
    case 'wait_for':
      return parseWithSchema(tool, params, waitForParams);
    case 'batch_actions':
      return parseBatchActions(params);
    case 'upload':
      return parseWithSchema(tool, params, uploadParams);
    default:
      return { ok: false, diagnostic: `tool: unsupported content tool ${String(tool)}` };
  }
}

const actionPhases = ['resolve', 'precheck', 'execute', 'settle', 'verify', 'recover'] as const;
const actionFailureCodes = [
  'stale_ref',
  'detached',
  'not_visible',
  'not_stable',
  'disabled',
  'not_editable',
  'occluded',
  'ambiguous_target',
  'unsupported_frame',
  'l1_not_effective',
  'navigation_uncertain',
  'safety_boundary_unavailable',
  'timeout',
  'aborted',
  'unknown',
] as const;

const actionFailureSchema = schema.object({
  code: schema.enum(actionFailureCodes),
  message: schema.string(),
  phase: schema.enum(actionPhases),
  retryable: schema.boolean(),
  details: schema.optional(schema.record(schema.string(), schema.unknown())),
});

const actionAttemptSchema = schema.object({
  phase: schema.enum(actionPhases),
  strategy: schema.enum(['l0', 'l1', 'l2']),
  startedAt: schema.number(),
  durationMs: schema.number({ min: 0 }),
  failureCode: schema.optional(schema.enum(actionFailureCodes)),
  message: schema.optional(schema.string()),
});

const actionEvidenceSchema = schema.object({
  attemptId: schema.string({ min: 1 }),
  tabId: schema.optional(schema.number({ integer: true, min: 0 })),
  urlBefore: schema.optional(schema.string()),
  urlAfter: schema.optional(schema.string()),
  generationBefore: schema.optional(schema.number({ integer: true, min: 0 })),
  generationAfter: schema.optional(schema.number({ integer: true, min: 0 })),
  attempts: schema.array(actionAttemptSchema),
  effectState: schema.enum(['dispatched', 'observed', 'verified']),
  observedEffects: schema.array(schema.string()),
  outcome: schema.enum(['verified', 'failed', 'uncertain']),
});

const executeResultSchema = schema.object({
  resultText: schema.string(),
  resultTabId: schema.optional(schema.number({ integer: true, min: 0 })),
  snapshot: schema.optional(schema.string()),
  pageStabilized: schema.optional(schema.boolean()),
  rect: schema.optional(
    schema.object({
      x: schema.number(),
      y: schema.number(),
      width: schema.number({ min: 0 }),
      height: schema.number({ min: 0 }),
    }),
  ),
  evidence: schema.optional(actionEvidenceSchema),
});

export type ExecuteResult = Infer<typeof executeResultSchema>;

export function validateExecuteResult(value: unknown): string | undefined {
  return schemaDiagnostic(executeResultSchema.safeParse(value), 'result');
}

export function validateActionFailure(value: unknown): string | undefined {
  return schemaDiagnostic(actionFailureSchema.safeParse(value), 'failure');
}

export function isActionFailure(value: unknown): value is ActionFailure {
  return validateActionFailure(value) === undefined;
}
