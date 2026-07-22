import type { SkillRecord } from '../db/types';
import { normalizeEndpointUrl, validateEndpointUrl } from '../security/endpointUrl';
import { unsealSecretWithRawKey } from '../security/secretStore';
import {
  IMPORT_SETTINGS_KEYS,
  type ExportBundle,
  type ImportValidationResult,
} from './importContract';
import { parseImportedSkillRaw } from './importSkillYaml';
import { normalizePermissionPolicy } from '../settings/permissionPolicy';

const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_THREADS = 10_000;
const MAX_NODES = 100_000;
const MAX_ASSETS = 10_000;
const MAX_JSON_DEPTH = 100;
const PERMISSION_POLICIES = ['always', 'untrusted', 'auto'];
const LEGACY_APPROVAL_POLICIES = ['always', 'untrusted', 'on-request', 'never', 'granular', 'auto'];
const LEGACY_CAPABILITY_SCOPES = ['read-only', 'same-origin-write', 'cross-origin', 'full'];
const TOOL_LEVELS = ['L0', 'L1', 'L2', 'mcp'];

type SecretMode = 'sanitized' | 'materialized';
type JsonRecord = Record<string, unknown>;

interface ValidatedDomain {
  threads: ExportBundle['threads'];
  nodes: ExportBundle['nodes'];
  skills: ExportBundle['skills'];
  memories: ExportBundle['memories'];
  settings: Record<string, unknown>;
  report: Omit<ImportValidationResult, 'hasEncryptedSecrets'>;
}

interface NodeRelation {
  threadId: string;
  parentId: string | null;
  seq: number;
}

export async function validatePortableExport(input: unknown): Promise<{
  bundle: ExportBundle;
  report: ImportValidationResult;
}> {
  const bytes = assertJsonValue(input);
  const root = object(input, 'IMPORT_ROOT');
  exact(
    root,
    [
      'version',
      'exportedAt',
      'threads',
      'nodes',
      'skills',
      'memories',
      'settings',
      'encryptedSecrets',
    ],
    'IMPORT_ROOT',
  );
  if (root.version !== 2) throw new Error(`不支持的导出版本：${String(root.version)}`);
  const validated = validateDomain(root, bytes, 'sanitized');
  await validateSkillRawConsistency(validated.skills);
  validateEncryptedBackup(root.encryptedSecrets);
  return {
    bundle: {
      version: 2,
      exportedAt: root.exportedAt as number,
      threads: validated.threads,
      nodes: validated.nodes,
      skills: validated.skills,
      memories: validated.memories,
      settings: validated.settings,
      ...(root.encryptedSecrets !== undefined
        ? { encryptedSecrets: root.encryptedSecrets as ExportBundle['encryptedSecrets'] }
        : {}),
    },
    report: { ...validated.report, hasEncryptedSecrets: root.encryptedSecrets !== undefined },
  };
}

export async function validateCanonicalImportPlan(input: unknown): Promise<ExportBundle> {
  const bytes = assertJsonValue(input);
  const root = object(input, 'IMPORT_PLAN');
  exact(
    root,
    [
      'version',
      'exportedAt',
      'threads',
      'nodes',
      'skills',
      'memories',
      'settings',
      'secretBackupDigest',
    ],
    'IMPORT_PLAN',
  );
  if (root.version !== 1) throw new Error('IMPORT_PLAN_VERSION');
  if (
    root.secretBackupDigest !== undefined &&
    (!string(root.secretBackupDigest) || !/^[0-9a-f]{64}$/i.test(root.secretBackupDigest))
  ) {
    throw new Error('IMPORT_SECRET_BACKUP_DIGEST');
  }
  const validated = validateDomain(root, bytes, 'sanitized');
  await validateSkillRawConsistency(validated.skills);
  return {
    version: 2,
    exportedAt: root.exportedAt as number,
    threads: validated.threads,
    nodes: validated.nodes,
    skills: validated.skills,
    memories: validated.memories,
    settings: validated.settings,
  };
}

export async function validateMaterializedSettings(
  input: unknown,
  localSecretKey: unknown,
  existingKey: unknown,
  plannedSettings: Record<string, unknown>,
): Promise<void> {
  assertJsonValue(input);
  const settings = object(input, 'IMPORT_SETTINGS');
  validateSettings(settings, 'materialized');
  if (JSON.stringify(sanitizeMaterializedSettings(settings)) !== JSON.stringify(plannedSettings)) {
    throw new Error('IMPORT_SETTINGS_CHANGED');
  }
  if (localSecretKey !== undefined && !validLocalSecretKey(localSecretKey)) {
    throw new Error('IMPORT_SECRET_KEY');
  }
  const local = validLocalSecretKey(localSecretKey) ? localSecretKey : undefined;
  const existing = validLocalSecretKey(existingKey) ? existingKey : undefined;
  if (local && existing && local.some((byte, index) => byte !== existing[index])) {
    throw new Error('IMPORT_SECRET_KEY_CHANGED');
  }
  const key = local ?? existing;
  const secrets = materializedSecrets(settings);
  if (secrets.length && !key) throw new Error('IMPORT_SECRET_KEY_MISSING');
  if (!key) return;
  for (const secret of secrets) {
    try {
      await unsealSecretWithRawKey(secret.value, secret.purpose, key);
    } catch {
      throw new Error(`IMPORT_SECRET_AUTH:${secret.label}`);
    }
  }
}

export function portableSkills(values: readonly SkillRecord[]): SkillRecord[] {
  return values.filter((value) => value.source === 'user' || value.source === 'imported');
}

function validateDomain(root: JsonRecord, bytes: number, mode: SecretMode): ValidatedDomain {
  timestamp(root.exportedAt, 'IMPORT_EXPORTED_AT');
  const threads = array(root.threads, MAX_THREADS, 'IMPORT_THREADS');
  const nodes = array(root.nodes, MAX_NODES, 'IMPORT_NODES');
  const skills = array(root.skills, MAX_ASSETS, 'IMPORT_SKILLS');
  const memories = array(root.memories, MAX_ASSETS, 'IMPORT_MEMORIES');
  const settings = object(root.settings, 'IMPORT_SETTINGS');

  const threadIds = uniqueIds(threads, 'THREAD');
  const nodeIds = uniqueIds(nodes, 'NODE');
  const nodeRecords = new Map<string, NodeRelation>();
  const nodeIdsByThread = new Map<string, string[]>();
  const sequences = new Set<string>();
  for (const value of nodes) {
    const node = object(value, 'IMPORT_NODE');
    exact(
      node,
      ['id', 'threadId', 'parentId', 'seq', 'ts', 'type', 'payload', 'deleted', 'evicted'],
      'IMPORT_NODE',
    );
    requiredString(node.id, 'IMPORT_NODE_ID');
    const threadId = requiredString(node.threadId, 'IMPORT_NODE_THREAD');
    if (!threadIds.has(threadId)) throw new Error('IMPORT_NODE_THREAD');
    if (node.parentId !== null && !string(node.parentId)) throw new Error('IMPORT_NODE_PARENT');
    const seq = nonnegativeInteger(node.seq, 'IMPORT_NODE_SEQ');
    timestamp(node.ts, 'IMPORT_NODE_TS');
    optionalBoolean(node.deleted, 'IMPORT_NODE_DELETED');
    optionalBoolean(node.evicted, 'IMPORT_NODE_EVICTED');
    validateNodePayload(node.type, node.payload);
    const sequence = `${threadId}\u0000${seq}`;
    if (sequences.has(sequence)) throw new Error('IMPORT_NODE_SEQ_DUPLICATE');
    sequences.add(sequence);
    nodeRecords.set(node.id as string, {
      threadId,
      parentId: node.parentId as string | null,
      seq,
    });
    const threadNodeIds = nodeIdsByThread.get(threadId) ?? [];
    threadNodeIds.push(node.id as string);
    nodeIdsByThread.set(threadId, threadNodeIds);
  }
  for (const node of nodeRecords.values()) {
    if (node.parentId === null) continue;
    const parent = nodeRecords.get(node.parentId);
    if (!parent || parent.threadId !== node.threadId)
      throw new Error('node parent reference invalid');
    if (parent.seq >= node.seq) throw new Error('node parent ordering invalid');
    if (!nodeIds.has(node.parentId)) throw new Error('node parent reference invalid');
  }
  assertAcyclic(nodeRecords);

  const threadParents = new Map<string, { parentId: string | null }>();
  for (const value of threads) {
    const thread = validateThread(value, nodeRecords, nodeIdsByThread);
    threadParents.set(thread.id, { parentId: thread.parentThreadId });
  }
  for (const [threadId, relation] of threadParents) {
    if (relation.parentId === null) continue;
    if (relation.parentId === threadId || !threadParents.has(relation.parentId)) {
      throw new Error('IMPORT_THREAD_PARENT');
    }
  }
  assertAcyclic(threadParents, 'IMPORT_THREAD_PARENT_CYCLE');
  uniqueIds(skills, 'SKILL');
  for (const value of skills) validateSkill(value);
  uniqueIds(memories, 'MEMORY');
  for (const value of memories) validateMemory(value);
  validateSettings(settings, mode);
  const canonicalSettings = canonicalizeSettings(settings);

  return {
    threads: threads as ExportBundle['threads'],
    nodes: canonicalizeNodes(nodes),
    skills: skills as ExportBundle['skills'],
    memories: memories as ExportBundle['memories'],
    settings: canonicalSettings,
    report: {
      bytes,
      threadCount: threads.length,
      nodeCount: nodes.length,
      skillCount: skills.length,
      memoryCount: memories.length,
    },
  };
}

function validateThread(
  value: unknown,
  nodes: Map<string, NodeRelation>,
  nodeIdsByThread: ReadonlyMap<string, readonly string[]>,
): { id: string; parentThreadId: string | null } {
  const thread = object(value, 'IMPORT_THREAD');
  exact(
    thread,
    [
      'id',
      'revision',
      'title',
      'createdAt',
      'updatedAt',
      'leafId',
      'folderId',
      'tags',
      'pinned',
      'archived',
      'preset',
      'parentThreadId',
      'stats',
      'scopeOrigins',
      'deleting',
    ],
    'IMPORT_THREAD',
  );
  const id = requiredString(thread.id, 'IMPORT_THREAD_ID');
  nonnegativeInteger(thread.revision, 'IMPORT_THREAD_REVISION');
  requiredString(thread.title, 'IMPORT_THREAD_TITLE', true);
  const createdAt = timestamp(thread.createdAt, 'IMPORT_THREAD_CREATED');
  const updatedAt = timestamp(thread.updatedAt, 'IMPORT_THREAD_UPDATED');
  if (updatedAt < createdAt) throw new Error('IMPORT_THREAD_TIME_ORDER');
  const threadNodeIds = nodeIdsByThread.get(id) ?? [];
  if (threadNodeIds.length > 0 && !string(thread.leafId)) throw new Error('IMPORT_THREAD_LEAF');
  if (thread.leafId !== null) {
    if (!string(thread.leafId) || nodes.get(thread.leafId)?.threadId !== id) {
      throw new Error('IMPORT_THREAD_LEAF');
    }
  }
  if (threadNodeIds.length > 0) {
    const roots = threadNodeIds.filter((nodeId) => nodes.get(nodeId)?.parentId === null);
    if (roots.length !== 1) throw new Error('IMPORT_THREAD_ROOT');
    let current: string | null = thread.leafId as string;
    while (current !== null && current !== roots[0]) current = nodes.get(current)?.parentId ?? null;
    if (current !== roots[0]) throw new Error('IMPORT_THREAD_LEAF_PATH');
  }
  optionalString(thread.folderId, 'IMPORT_THREAD_FOLDER');
  stringArray(thread.tags, 'IMPORT_THREAD_TAGS');
  boolean(thread.pinned, 'IMPORT_THREAD_PINNED');
  boolean(thread.archived, 'IMPORT_THREAD_ARCHIVED');
  optionalString(thread.preset, 'IMPORT_THREAD_PRESET');
  optionalString(thread.parentThreadId, 'IMPORT_THREAD_PARENT');
  optionalBoolean(thread.deleting, 'IMPORT_THREAD_DELETING');
  stringArray(thread.scopeOrigins, 'IMPORT_THREAD_ORIGINS');
  const stats = object(thread.stats, 'IMPORT_THREAD_STATS');
  exact(stats, ['turns', 'totalTokens', 'costUsd'], 'IMPORT_THREAD_STATS');
  nonnegativeInteger(stats.turns, 'IMPORT_THREAD_TURNS');
  nonnegativeFinite(stats.totalTokens, 'IMPORT_THREAD_TOKENS');
  nonnegativeFinite(stats.costUsd, 'IMPORT_THREAD_COST');
  return {
    id,
    parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null,
  };
}

function validateNodePayload(type: unknown, value: unknown): void {
  const payload = object(value, 'IMPORT_NODE_PAYLOAD');
  switch (type) {
    case 'user_message':
      exact(payload, ['content', 'attachedContext', 'steered'], 'IMPORT_USER_PAYLOAD');
      contentBlocks(payload.content, 'IMPORT_USER_CONTENT');
      if (payload.attachedContext !== undefined) contextBlocks(payload.attachedContext);
      optionalBoolean(payload.steered, 'IMPORT_USER_STEERED');
      return;
    case 'assistant_message':
      exact(
        payload,
        [
          'content',
          'model',
          'connectionId',
          'reasoning',
          'providerState',
          'usage',
          'providerStopReason',
        ],
        'IMPORT_ASSISTANT_PAYLOAD',
      );
      contentBlocks(payload.content, 'IMPORT_ASSISTANT_CONTENT');
      requiredString(payload.model, 'IMPORT_ASSISTANT_MODEL');
      requiredString(payload.connectionId, 'IMPORT_ASSISTANT_CONNECTION');
      optionalString(payload.reasoning, 'IMPORT_ASSISTANT_REASONING', true);
      if (payload.providerState !== undefined) providerAssistantState(payload.providerState);
      if (payload.usage !== undefined) usage(payload.usage);
      optionalEnum(
        payload.providerStopReason,
        ['end', 'tool_use', 'max_tokens', 'content_filter'],
        'IMPORT_ASSISTANT_STOP',
      );
      return;
    case 'tool_call':
      exact(payload, ['itemId', 'toolName', 'params', 'level'], 'IMPORT_TOOL_CALL');
      requiredString(payload.itemId, 'IMPORT_TOOL_ITEM');
      requiredString(payload.toolName, 'IMPORT_TOOL_NAME');
      requiredJsonValue(payload, 'params', 'IMPORT_TOOL_PARAMS');
      if (!['L0', 'L1', 'L2', 'mcp', 'builtin'].includes(String(payload.level)))
        throw new Error('IMPORT_TOOL_LEVEL');
      return;
    case 'tool_result':
      exact(
        payload,
        ['itemId', 'ok', 'contentForLlm', 'details', 'trust', 'provenance', 'origin'],
        'IMPORT_TOOL_RESULT',
      );
      requiredString(payload.itemId, 'IMPORT_TOOL_ITEM');
      boolean(payload.ok, 'IMPORT_TOOL_OK');
      contentBlocks(payload.contentForLlm, 'IMPORT_TOOL_CONTENT');
      optionalEnum(payload.trust, ['trusted', 'untrusted'], 'IMPORT_TOOL_TRUST');
      optionalEnum(
        payload.provenance,
        ['user', 'page', 'mcp', 'tool', 'import', 'plugin'],
        'IMPORT_TOOL_PROVENANCE',
      );
      optionalString(payload.origin, 'IMPORT_TOOL_ORIGIN');
      return;
    case 'approval_decision':
      exact(payload, ['approvalId', 'request', 'decision', 'decidedAt'], 'IMPORT_APPROVAL');
      requiredString(payload.approvalId, 'IMPORT_APPROVAL_ID');
      approvalRequest(payload.request);
      approvalDecision(payload.decision);
      timestamp(payload.decidedAt, 'IMPORT_APPROVAL_TIME');
      return;
    case 'turn_context':
      exact(
        payload,
        [
          'turnId',
          'model',
          'permissionPolicy',
          'approvalPolicy',
          'capabilityScope',
          'activeSkills',
          'promptVersion',
          'browserContext',
        ],
        'IMPORT_TURN_CONTEXT',
      );
      requiredString(payload.turnId, 'IMPORT_TURN_ID');
      modelRef(payload.model, 'IMPORT_TURN_MODEL');
      if (payload.permissionPolicy === undefined && payload.approvalPolicy === undefined) {
        throw new Error('IMPORT_PERMISSION_POLICY');
      }
      optionalEnum(payload.permissionPolicy, PERMISSION_POLICIES, 'IMPORT_PERMISSION_POLICY');
      optionalEnum(payload.approvalPolicy, LEGACY_APPROVAL_POLICIES, 'IMPORT_APPROVAL_POLICY');
      optionalEnum(payload.capabilityScope, LEGACY_CAPABILITY_SCOPES, 'IMPORT_CAPABILITY_SCOPE');
      stringArray(payload.activeSkills, 'IMPORT_ACTIVE_SKILLS');
      optionalString(payload.promptVersion, 'IMPORT_PROMPT_VERSION');
      if (payload.browserContext !== undefined) browserContext(payload.browserContext);
      return;
    case 'system_notice':
      exact(payload, ['text', 'noticeKind'], 'IMPORT_SYSTEM_NOTICE');
      requiredString(payload.text, 'IMPORT_NOTICE_TEXT', true);
      optionalEnum(
        payload.noticeKind,
        ['paused', 'step_reminder', 'recovered', 'generic'],
        'IMPORT_NOTICE_KIND',
      );
      return;
    default:
      throw new Error('IMPORT_NODE_TYPE');
  }
}

function validateSkill(value: unknown): void {
  const skill = object(value, 'IMPORT_SKILL');
  exact(
    skill,
    [
      'id',
      'name',
      'raw',
      'frontmatter',
      'body',
      'enabled',
      'source',
      'sourceRef',
      'createdAt',
      'updatedAt',
    ],
    'IMPORT_SKILL',
  );
  requiredString(skill.id, 'IMPORT_SKILL_ID');
  const name = requiredString(skill.name, 'IMPORT_SKILL_NAME');
  const raw = requiredString(skill.raw, 'IMPORT_SKILL_RAW');
  boolean(skill.enabled, 'IMPORT_SKILL_ENABLED');
  enumValue(skill.source, ['builtin', 'user', 'imported', 'plugin'], 'IMPORT_SKILL_SOURCE');
  optionalString(skill.sourceRef, 'IMPORT_SKILL_SOURCE_REF');
  const createdAt = timestamp(skill.createdAt, 'IMPORT_SKILL_CREATED');
  const updatedAt = timestamp(skill.updatedAt, 'IMPORT_SKILL_UPDATED');
  if (updatedAt < createdAt) throw new Error('IMPORT_SKILL_TIME_ORDER');
  const rawParts = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim());
  if (!rawParts || (rawParts[1] ?? '').trim() !== skill.body) {
    throw new Error('IMPORT_SKILL_CONTENT');
  }
  validateSkillFrontmatter(skill.frontmatter, name);
}

async function validateSkillRawConsistency(skills: readonly SkillRecord[]): Promise<void> {
  for (const skill of skills) {
    let parsed: ReturnType<typeof parseImportedSkillRaw>;
    try {
      parsed = parseImportedSkillRaw(skill.raw);
    } catch {
      throw new Error('IMPORT_SKILL_CONTENT');
    }
    if (parsed.body !== skill.body || !sameJsonValue(parsed.frontmatter, skill.frontmatter)) {
      throw new Error('IMPORT_SKILL_CONTENT');
    }
  }
}

function validateSkillFrontmatter(value: unknown, name: string): void {
  const frontmatter = object(value, 'IMPORT_SKILL_FRONTMATTER');
  if (
    frontmatter.name !== name ||
    !/^[a-z0-9-]{1,64}$/.test(name) ||
    typeof frontmatter.description !== 'string' ||
    frontmatter.description.length < 1 ||
    frontmatter.description.length > 500
  ) {
    throw new Error('IMPORT_SKILL_FRONTMATTER');
  }
  if (frontmatter.panelot === undefined) return;
  const panelot = object(frontmatter.panelot, 'IMPORT_SKILL_PANELOT');
  exact(panelot, ['sites', 'auto_suggest', 'command', 'variables'], 'IMPORT_SKILL_PANELOT');
  if (panelot.sites !== undefined) stringArray(panelot.sites, 'IMPORT_SKILL_SITES');
  optionalBoolean(panelot.auto_suggest, 'IMPORT_SKILL_AUTO_SUGGEST');
  if (panelot.command !== undefined) {
    const command = requiredString(panelot.command, 'IMPORT_SKILL_COMMAND');
    if (!/^\/[a-z0-9:-]+$/.test(command)) throw new Error('IMPORT_SKILL_COMMAND');
  }
  if (panelot.variables === undefined) return;
  for (const candidate of array(panelot.variables, MAX_ASSETS, 'IMPORT_SKILL_VARIABLES')) {
    const variable = object(candidate, 'IMPORT_SKILL_VARIABLE');
    exact(
      variable,
      ['key', 'label', 'type', 'options', 'default', 'required'],
      'IMPORT_SKILL_VARIABLE',
    );
    requiredString(variable.key, 'IMPORT_SKILL_VARIABLE_KEY');
    requiredString(variable.label, 'IMPORT_SKILL_VARIABLE_LABEL');
    enumValue(variable.type, ['text', 'select', 'date', 'url'], 'IMPORT_SKILL_VARIABLE_TYPE');
    if (variable.options !== undefined)
      stringArray(variable.options, 'IMPORT_SKILL_VARIABLE_OPTIONS');
    optionalString(variable.default, 'IMPORT_SKILL_VARIABLE_DEFAULT', true);
    optionalBoolean(variable.required, 'IMPORT_SKILL_VARIABLE_REQUIRED');
  }
}

function validateMemory(value: unknown): void {
  const memory = object(value, 'IMPORT_MEMORY');
  exact(memory, ['id', 'key', 'value', 'updatedAt'], 'IMPORT_MEMORY');
  requiredString(memory.id, 'IMPORT_MEMORY_ID');
  requiredString(memory.key, 'IMPORT_MEMORY_KEY');
  requiredString(memory.value, 'IMPORT_MEMORY_VALUE', true);
  timestamp(memory.updatedAt, 'IMPORT_MEMORY_TIME');
}

function validateSettings(settings: JsonRecord, mode: SecretMode): void {
  exact(settings, IMPORT_SETTINGS_KEYS, 'IMPORT_SETTING');
  for (const key of IMPORT_SETTINGS_KEYS) {
    const value = settings[key];
    if (value === null) continue;
    switch (key) {
      case 'connections':
        connections(value, mode);
        break;
      case 'model_presets':
        presets(value);
        break;
      case 'global_settings':
        globalSettings(value);
        break;
      case 'permission_rules':
        permissionRules(value);
        break;
      case 'sensitive_origins':
        stringArray(value, 'IMPORT_SENSITIVE_ORIGINS');
        break;
      case 'mcp_servers':
        mcpServers(value, mode);
        break;
      case 'site_prompts':
        sitePrompts(value);
        break;
    }
  }
}

function canonicalizeSettings(settings: JsonRecord): Record<string, unknown> {
  const canonical = structuredClone(settings);
  if (Array.isArray(canonical.connections)) {
    canonical.connections = canonical.connections.map((candidate) => {
      const connection = object(candidate, 'IMPORT_CONNECTION');
      return {
        ...connection,
        baseUrl: normalizeEndpointUrl(connection.baseUrl as string, {
          label: 'Provider endpoint URL',
          stripTrailingSlashes: true,
        }),
      };
    });
  }
  if (Array.isArray(canonical.model_presets)) {
    canonical.model_presets = canonical.model_presets.map((candidate) => {
      const preset = object(candidate, 'IMPORT_PRESET');
      const { defaultApprovalPolicy, defaultCapabilityScope, ...current } = preset;
      return {
        ...current,
        defaultPermissionPolicy:
          current.defaultPermissionPolicy ??
          normalizePermissionPolicy(
            defaultApprovalPolicy as string | undefined,
            defaultCapabilityScope as string | undefined,
          ),
      };
    });
  }
  if (canonical.global_settings !== null && canonical.global_settings !== undefined) {
    const global = object(canonical.global_settings, 'IMPORT_GLOBAL_SETTINGS');
    const { defaultApprovalPolicy, defaultCapabilityScope, ...current } = global;
    canonical.global_settings = {
      ...current,
      defaultPermissionPolicy:
        current.defaultPermissionPolicy ??
        normalizePermissionPolicy(
          defaultApprovalPolicy as string | undefined,
          defaultCapabilityScope as string | undefined,
        ),
    };
  }
  return canonical;
}

function canonicalizeNodes(nodes: unknown[]): ExportBundle['nodes'] {
  return structuredClone(nodes).map((candidate) => {
    const node = candidate as JsonRecord;
    if (node.type !== 'turn_context') return node;
    const payload = node.payload as JsonRecord;
    const { approvalPolicy, capabilityScope, ...current } = payload;
    return {
      ...node,
      payload: {
        ...current,
        permissionPolicy:
          current.permissionPolicy ??
          normalizePermissionPolicy(
            approvalPolicy as string | undefined,
            capabilityScope as string | undefined,
          ) ??
          'untrusted',
      },
    };
  }) as unknown as ExportBundle['nodes'];
}

function connections(value: unknown, mode: SecretMode): void {
  const values = array(value, MAX_ASSETS, 'IMPORT_CONNECTIONS');
  const ids = new Set<string>();
  for (const candidate of values) {
    const connection = object(candidate, 'IMPORT_CONNECTION');
    if (Array.isArray(connection.apiKeys)) {
      for (const key of connection.apiKeys) {
        validateSecretValue(
          key,
          mode,
          mode === 'sanitized' ? '导入设置不能包含明文 Provider Key' : 'IMPORT_CONNECTION_KEY',
        );
      }
    }
    if (typeof connection.baseUrl !== 'string') throw new Error('IMPORT_CONNECTION_URL');
    validateEndpointUrl(connection.baseUrl, {
      label: 'Provider endpoint URL',
      stripTrailingSlashes: true,
    });
    exact(
      connection,
      [
        'id',
        'name',
        'kind',
        'baseUrl',
        'apiKeys',
        'customHeaders',
        'prefixId',
        'modelIds',
        'models',
        'enabled',
        'quirks',
      ],
      'IMPORT_CONNECTION',
    );
    const id = requiredString(connection.id, 'IMPORT_CONNECTION_ID');
    if (ids.has(id)) throw new Error('IMPORT_CONNECTION_ID');
    ids.add(id);
    requiredString(connection.name, 'IMPORT_CONNECTION_NAME');
    enumValue(connection.kind, ['openai', 'anthropic'], 'IMPORT_CONNECTION_KIND');
    boolean(connection.enabled, 'IMPORT_CONNECTION_ENABLED');
    const keys = stringArray(connection.apiKeys, 'IMPORT_CONNECTION_KEYS');
    for (const key of keys) validateSecretValue(key, mode, 'IMPORT_CONNECTION_KEY');
    if (connection.customHeaders !== undefined) {
      if (mode === 'sanitized') throw new Error('IMPORT_CONNECTION_HEADERS');
      const headers = object(connection.customHeaders, 'IMPORT_CONNECTION_HEADERS');
      for (const [name, secret] of Object.entries(headers)) {
        requiredString(name, 'IMPORT_CONNECTION_HEADER_NAME');
        validateSecretValue(secret, mode, 'IMPORT_CONNECTION_HEADER');
      }
    }
    optionalString(connection.prefixId, 'IMPORT_CONNECTION_PREFIX');
    if (connection.modelIds !== undefined)
      stringArray(connection.modelIds, 'IMPORT_CONNECTION_MODELS');
    if (connection.models !== undefined) models(connection.models);
    if (connection.quirks !== undefined) quirks(connection.quirks);
  }
}

function models(value: unknown): void {
  const values = array(value, MAX_ASSETS, 'IMPORT_MODELS');
  const ids = new Set<string>();
  for (const candidate of values) {
    const model = object(candidate, 'IMPORT_MODEL');
    exact(model, ['id', 'displayName', 'capabilities', 'pricing'], 'IMPORT_MODEL');
    const id = requiredString(model.id, 'IMPORT_MODEL_ID');
    if (ids.has(id)) throw new Error('IMPORT_MODEL_ID');
    ids.add(id);
    optionalString(model.displayName, 'IMPORT_MODEL_NAME', true);
    const capabilities = object(model.capabilities, 'IMPORT_MODEL_CAPABILITIES');
    exact(
      capabilities,
      ['toolUse', 'vision', 'reasoning', 'maxContext'],
      'IMPORT_MODEL_CAPABILITIES',
    );
    boolean(capabilities.toolUse, 'IMPORT_MODEL_TOOL_USE');
    boolean(capabilities.vision, 'IMPORT_MODEL_VISION');
    optionalBoolean(capabilities.reasoning, 'IMPORT_MODEL_REASONING');
    if (capabilities.maxContext !== undefined)
      nonnegativeInteger(capabilities.maxContext, 'IMPORT_MODEL_CONTEXT');
    if (model.pricing !== undefined) pricing(model.pricing);
  }
}

function pricing(value: unknown): void {
  const price = object(value, 'IMPORT_PRICING');
  exact(price, ['input', 'output', 'cacheRead'], 'IMPORT_PRICING');
  nonnegativeFinite(price.input, 'IMPORT_PRICE_INPUT');
  nonnegativeFinite(price.output, 'IMPORT_PRICE_OUTPUT');
  if (price.cacheRead !== undefined) nonnegativeFinite(price.cacheRead, 'IMPORT_PRICE_CACHE');
}

function quirks(value: unknown): void {
  const flags = object(value, 'IMPORT_QUIRKS');
  exact(
    flags,
    [
      'noStreamOptions',
      'thinkTagReasoning',
      'noParallelToolCalls',
      'anthropicManualThinking',
      'maxTokensField',
      'noSystemRole',
    ],
    'IMPORT_QUIRKS',
  );
  optionalBoolean(flags.noStreamOptions, 'IMPORT_QUIRK');
  optionalBoolean(flags.thinkTagReasoning, 'IMPORT_QUIRK');
  optionalBoolean(flags.noParallelToolCalls, 'IMPORT_QUIRK');
  optionalBoolean(flags.anthropicManualThinking, 'IMPORT_QUIRK');
  optionalBoolean(flags.noSystemRole, 'IMPORT_QUIRK');
  optionalEnum(flags.maxTokensField, ['max_tokens', 'max_completion_tokens'], 'IMPORT_QUIRK');
}

function presets(value: unknown): void {
  const values = array(value, MAX_ASSETS, 'IMPORT_PRESETS');
  uniqueIds(values, 'PRESET');
  for (const candidate of values) {
    const preset = object(candidate, 'IMPORT_PRESET');
    exact(
      preset,
      [
        'id',
        'name',
        'icon',
        'base',
        'systemPrompt',
        'params',
        'enabledToolLevels',
        'defaultPermissionPolicy',
        'defaultApprovalPolicy',
        'defaultCapabilityScope',
        'skills',
        'promptVersion',
      ],
      'IMPORT_PRESET',
    );
    requiredString(preset.id, 'IMPORT_PRESET_ID');
    requiredString(preset.name, 'IMPORT_PRESET_NAME');
    optionalString(preset.icon, 'IMPORT_PRESET_ICON', true);
    modelRef(preset.base, 'IMPORT_PRESET_BASE');
    optionalString(preset.systemPrompt, 'IMPORT_PRESET_PROMPT', true);
    if (preset.params !== undefined) generationParams(preset.params);
    if (preset.enabledToolLevels !== undefined)
      enumArray(preset.enabledToolLevels, TOOL_LEVELS, 'IMPORT_PRESET_TOOLS');
    optionalEnum(preset.defaultPermissionPolicy, PERMISSION_POLICIES, 'IMPORT_PRESET_POLICY');
    optionalEnum(
      preset.defaultApprovalPolicy,
      LEGACY_APPROVAL_POLICIES,
      'IMPORT_PRESET_LEGACY_POLICY',
    );
    optionalEnum(
      preset.defaultCapabilityScope,
      LEGACY_CAPABILITY_SCOPES,
      'IMPORT_PRESET_LEGACY_SCOPE',
    );
    if (preset.skills !== undefined) stringArray(preset.skills, 'IMPORT_PRESET_SKILLS');
    optionalString(preset.promptVersion, 'IMPORT_PRESET_VERSION');
  }
}

function generationParams(value: unknown): void {
  const params = object(value, 'IMPORT_GEN_PARAMS');
  exact(
    params,
    ['temperature', 'topP', 'maxTokens', 'stopSequences', 'reasoningEffort'],
    'IMPORT_GEN_PARAMS',
  );
  if (params.temperature !== undefined) finite(params.temperature, 'IMPORT_TEMPERATURE');
  if (params.topP !== undefined) finite(params.topP, 'IMPORT_TOP_P');
  if (params.maxTokens !== undefined) nonnegativeInteger(params.maxTokens, 'IMPORT_MAX_TOKENS');
  if (params.stopSequences !== undefined)
    stringArray(params.stopSequences, 'IMPORT_STOP_SEQUENCES');
  optionalEnum(params.reasoningEffort, ['low', 'medium', 'high'], 'IMPORT_REASONING_EFFORT');
}

function globalSettings(value: unknown): void {
  const settings = object(value, 'IMPORT_GLOBAL_SETTINGS');
  exact(
    settings,
    [
      'taskModel',
      'defaultModel',
      'userGlobalPrompt',
      'language',
      'theme',
      'defaultPermissionPolicy',
      'defaultApprovalPolicy',
      'defaultCapabilityScope',
      'turnTokenBudget',
      'sidebarWidth',
      'sidebarCollapsed',
      'sidebarGroupsCollapsed',
    ],
    'IMPORT_GLOBAL_SETTINGS',
  );
  if (settings.taskModel !== undefined) modelRef(settings.taskModel, 'IMPORT_TASK_MODEL');
  if (settings.defaultModel !== undefined) modelRef(settings.defaultModel, 'IMPORT_DEFAULT_MODEL');
  optionalString(settings.userGlobalPrompt, 'IMPORT_GLOBAL_PROMPT', true);
  optionalEnum(settings.language, ['zh-CN', 'en'], 'IMPORT_LANGUAGE');
  optionalEnum(settings.theme, ['system', 'light', 'dark'], 'IMPORT_THEME');
  optionalEnum(settings.defaultPermissionPolicy, PERMISSION_POLICIES, 'IMPORT_GLOBAL_POLICY');
  optionalEnum(
    settings.defaultApprovalPolicy,
    LEGACY_APPROVAL_POLICIES,
    'IMPORT_GLOBAL_LEGACY_POLICY',
  );
  optionalEnum(
    settings.defaultCapabilityScope,
    LEGACY_CAPABILITY_SCOPES,
    'IMPORT_GLOBAL_LEGACY_SCOPE',
  );
  if (settings.turnTokenBudget !== undefined)
    nonnegativeInteger(settings.turnTokenBudget, 'IMPORT_GLOBAL_BUDGET');
  if (settings.sidebarWidth !== undefined)
    nonnegativeFinite(settings.sidebarWidth, 'IMPORT_SIDEBAR_WIDTH');
  optionalBoolean(settings.sidebarCollapsed, 'IMPORT_SIDEBAR_COLLAPSED');
  if (settings.sidebarGroupsCollapsed !== undefined)
    stringArray(settings.sidebarGroupsCollapsed, 'IMPORT_SIDEBAR_GROUPS');
}

function permissionRules(value: unknown): void {
  const values = array(value, MAX_ASSETS, 'IMPORT_PERMISSION_RULES');
  uniqueIds(values, 'PERMISSION_RULE');
  for (const candidate of values) {
    const rule = object(candidate, 'IMPORT_PERMISSION_RULE');
    exact(
      rule,
      [
        'id',
        'tool',
        'origin',
        'verdict',
        'source',
        'createdAt',
        'sourceThreadId',
        'sourceApprovalId',
      ],
      'IMPORT_PERMISSION_RULE',
    );
    requiredString(rule.id, 'IMPORT_PERMISSION_ID');
    requiredString(rule.tool, 'IMPORT_PERMISSION_TOOL');
    requiredString(rule.origin, 'IMPORT_PERMISSION_ORIGIN');
    enumValue(rule.verdict, ['allow', 'deny', 'ask'], 'IMPORT_PERMISSION_VERDICT');
    enumValue(
      rule.source,
      ['user_setting', 'approval_persist', 'plugin_default'],
      'IMPORT_PERMISSION_SOURCE',
    );
    timestamp(rule.createdAt, 'IMPORT_PERMISSION_TIME');
    optionalString(rule.sourceThreadId, 'IMPORT_PERMISSION_THREAD');
    optionalString(rule.sourceApprovalId, 'IMPORT_PERMISSION_APPROVAL');
  }
}

function mcpServers(value: unknown, mode: SecretMode): void {
  const values = array(value, MAX_ASSETS, 'IMPORT_MCP_SERVERS');
  const ids = new Set<string>();
  for (const candidate of values) {
    const server = object(candidate, 'IMPORT_MCP_SERVER');
    if (typeof server.url !== 'string') throw new Error('IMPORT_MCP_URL');
    validateEndpointUrl(server.url, { label: 'MCP server URL' });
    exact(
      server,
      ['id', 'name', 'url', 'auth', 'enabled', 'disabledTools', 'connectOnStartup'],
      'IMPORT_MCP_SERVER',
    );
    const id = requiredString(server.id, 'IMPORT_MCP_ID');
    if (ids.has(id)) throw new Error('IMPORT_MCP_ID');
    ids.add(id);
    requiredString(server.name, 'IMPORT_MCP_NAME');
    boolean(server.enabled, 'IMPORT_MCP_ENABLED');
    stringArray(server.disabledTools, 'IMPORT_MCP_DISABLED_TOOLS');
    boolean(server.connectOnStartup, 'IMPORT_MCP_CONNECT');
    mcpAuth(server.auth, mode);
  }
}

function mcpAuth(value: unknown, mode: SecretMode): void {
  const auth = object(value, 'IMPORT_MCP_AUTH');
  switch (auth.kind) {
    case 'none':
      exact(auth, ['kind'], 'IMPORT_MCP_AUTH');
      return;
    case 'bearer':
      exact(auth, ['kind', 'token'], 'IMPORT_MCP_AUTH');
      validateSecretValue(auth.token, mode, 'IMPORT_MCP_BEARER');
      return;
    case 'oauth': {
      exact(auth, ['kind', 'clientId', 'scopes', 'binding', 'tokens'], 'IMPORT_MCP_AUTH');
      optionalString(auth.clientId, 'IMPORT_MCP_CLIENT');
      if (auth.scopes !== undefined) stringArray(auth.scopes, 'IMPORT_MCP_SCOPES');
      if (auth.binding !== undefined) oauthBinding(auth.binding);
      if (auth.tokens !== undefined) {
        const tokens = object(auth.tokens, 'IMPORT_MCP_TOKENS');
        exact(tokens, ['access', 'refresh', 'expiresAt'], 'IMPORT_MCP_TOKENS');
        if (tokens.access !== '') throw new Error('IMPORT_MCP_ACCESS');
        if (tokens.refresh !== undefined)
          validateSecretValue(tokens.refresh, mode, 'IMPORT_MCP_REFRESH');
        timestamp(tokens.expiresAt, 'IMPORT_MCP_EXPIRES');
      }
      return;
    }
    default:
      throw new Error('IMPORT_MCP_AUTH');
  }
}

function oauthBinding(value: unknown): void {
  const binding = object(value, 'IMPORT_MCP_BINDING');
  exact(binding, ['resource', 'issuer', 'planDigest'], 'IMPORT_MCP_BINDING');
  const resource = requiredString(binding.resource, 'IMPORT_MCP_RESOURCE');
  const issuer = requiredString(binding.issuer, 'IMPORT_MCP_ISSUER');
  validateEndpointUrl(resource, { label: 'MCP OAuth resource URL' });
  validateEndpointUrl(issuer, { label: 'MCP OAuth issuer URL' });
  if (
    binding.planDigest !== undefined &&
    (!string(binding.planDigest) || !/^[0-9a-f]{64}$/i.test(binding.planDigest))
  ) {
    throw new Error('IMPORT_MCP_PLAN_DIGEST');
  }
}

function sitePrompts(value: unknown): void {
  for (const candidate of array(value, MAX_ASSETS, 'IMPORT_SITE_PROMPTS')) {
    const prompt = object(candidate, 'IMPORT_SITE_PROMPT');
    exact(prompt, ['pattern', 'prompt'], 'IMPORT_SITE_PROMPT');
    requiredString(prompt.pattern, 'IMPORT_SITE_PATTERN');
    requiredString(prompt.prompt, 'IMPORT_SITE_TEXT', true);
  }
}

function materializedSecrets(
  settings: JsonRecord,
): { value: string; purpose: string; label: string }[] {
  const result: { value: string; purpose: string; label: string }[] = [];
  for (const candidate of Array.isArray(settings.connections) ? settings.connections : []) {
    const connection = candidate as JsonRecord;
    for (const value of connection.apiKeys as string[]) {
      if (value)
        result.push({ value, purpose: 'provider-key', label: `provider:${String(connection.id)}` });
    }
    for (const [name, value] of Object.entries(
      (connection.customHeaders as JsonRecord | undefined) ?? {},
    )) {
      if (value)
        result.push({
          value: value as string,
          purpose: `provider:${String(connection.id)}:header:${name.toLowerCase()}`,
          label: `header:${String(connection.id)}:${name}`,
        });
    }
  }
  for (const candidate of Array.isArray(settings.mcp_servers) ? settings.mcp_servers : []) {
    const server = candidate as JsonRecord;
    const auth = server.auth as JsonRecord;
    if (auth.kind === 'bearer' && auth.token) {
      result.push({
        value: auth.token as string,
        purpose: `mcp:${String(server.id)}:bearer`,
        label: `mcp:${String(server.id)}:bearer`,
      });
    }
    if (auth.kind === 'oauth' && objectOrUndefined(auth.tokens)?.refresh) {
      const binding = objectOrUndefined(auth.binding);
      const purpose = binding
        ? `mcp:${String(server.id)}:oauth:${encodeURIComponent(String(binding.resource))}:${encodeURIComponent(String(binding.issuer))}:refresh`
        : `mcp:${String(server.id)}:refresh`;
      result.push({
        value: (auth.tokens as JsonRecord).refresh as string,
        purpose,
        label: `mcp:${String(server.id)}:refresh`,
      });
    }
  }
  return result;
}

function sanitizeMaterializedSettings(settings: JsonRecord): Record<string, unknown> {
  const sanitized = structuredClone(settings);
  if (Array.isArray(sanitized.connections)) {
    sanitized.connections = sanitized.connections.map((value) => {
      const connection = value as JsonRecord;
      const result: JsonRecord = { ...connection, apiKeys: [] };
      delete result.customHeaders;
      return result;
    });
  }
  if (Array.isArray(sanitized.mcp_servers)) {
    sanitized.mcp_servers = sanitized.mcp_servers.map((value) => {
      const server = value as JsonRecord;
      const auth = server.auth as JsonRecord;
      if (auth.kind === 'bearer') return { ...server, auth: { kind: 'bearer', token: '' } };
      if (auth.kind !== 'oauth') return server;
      const tokens = objectOrUndefined(auth.tokens);
      const sanitizedTokens = tokens ? { access: '', expiresAt: tokens.expiresAt } : undefined;
      return { ...server, auth: { ...auth, tokens: sanitizedTokens } };
    });
  }
  return sanitized;
}

function validateEncryptedBackup(value: unknown): void {
  if (value === undefined) return;
  const backup = object(value, 'IMPORT_SECRET_BACKUP');
  exact(backup, ['format', 'version', 'kdf', 'cipher', 'iv', 'ciphertext'], 'IMPORT_SECRET_BACKUP');
  const kdf = object(backup.kdf, 'IMPORT_SECRET_BACKUP_KDF');
  exact(kdf, ['name', 'iterations', 'salt'], 'IMPORT_SECRET_BACKUP_KDF');
  if (
    backup.format !== 'panelot-secret-backup' ||
    backup.version !== 1 ||
    backup.cipher !== 'AES-GCM-256' ||
    kdf.name !== 'PBKDF2-SHA-256' ||
    kdf.iterations !== 600_000
  )
    throw new Error('IMPORT_SECRET_BACKUP');
  base64(kdf.salt, 16, 'IMPORT_SECRET_BACKUP_SALT');
  base64(backup.iv, 12, 'IMPORT_SECRET_BACKUP_IV');
  base64(backup.ciphertext, 16, 'IMPORT_SECRET_BACKUP_CIPHERTEXT', true);
}

function approvalRequest(value: unknown): void {
  const request = object(value, 'IMPORT_APPROVAL_REQUEST');
  exact(
    request,
    ['tool', 'label', 'params', 'targetOrigin', 'flags', 'preview'],
    'IMPORT_APPROVAL_REQUEST',
  );
  requiredString(request.tool, 'IMPORT_APPROVAL_TOOL');
  requiredString(request.label, 'IMPORT_APPROVAL_LABEL');
  requiredJsonValue(request, 'params', 'IMPORT_APPROVAL_PARAMS');
  requiredString(request.targetOrigin, 'IMPORT_APPROVAL_ORIGIN', true);
  enumArray(
    request.flags,
    ['cross_scope', 'sensitive_payload', 'escalation_l2', 'host_permission'],
    'IMPORT_APPROVAL_FLAGS',
  );
  if (request.preview !== undefined) {
    const preview = object(request.preview, 'IMPORT_APPROVAL_PREVIEW');
    exact(preview, ['snapshotLine', 'screenshotAttachmentId'], 'IMPORT_APPROVAL_PREVIEW');
    optionalString(preview.snapshotLine, 'IMPORT_APPROVAL_SNAPSHOT', true);
    optionalString(preview.screenshotAttachmentId, 'IMPORT_APPROVAL_SCREENSHOT');
  }
}

function approvalDecision(value: unknown): void {
  const decision = object(value, 'IMPORT_APPROVAL_DECISION');
  if (decision.kind === 'decline') {
    exact(decision, ['kind', 'note'], 'IMPORT_APPROVAL_DECISION');
    optionalString(decision.note, 'IMPORT_APPROVAL_NOTE', true);
  } else {
    exact(decision, ['kind'], 'IMPORT_APPROVAL_DECISION');
    enumValue(
      decision.kind,
      ['accept', 'acceptForSession', 'acceptForSite', 'cancel'],
      'IMPORT_APPROVAL_DECISION',
    );
  }
}

function contentBlocks(value: unknown, label: string): void {
  for (const candidate of array(value, MAX_NODES, label)) {
    const block = object(candidate, label);
    if (block.type === 'text') {
      exact(block, ['type', 'text'], label);
      requiredString(block.text, label, true);
    } else if (block.type === 'image') {
      exact(block, ['type', 'mime', 'data'], label);
      requiredString(block.mime, label);
      requiredString(block.data, label);
    } else throw new Error(label);
  }
}

function contextBlocks(value: unknown): void {
  for (const candidate of array(value, MAX_ASSETS, 'IMPORT_CONTEXT')) {
    const context = object(candidate, 'IMPORT_CONTEXT');
    exact(
      context,
      [
        'kind',
        'label',
        'origin',
        'trust',
        'provenance',
        'sourceRef',
        'tab',
        'content',
        'approxTokens',
      ],
      'IMPORT_CONTEXT',
    );
    enumValue(
      context.kind,
      ['page', 'selection', 'screenshot', 'tab', 'mcp_resource', 'file', 'skill'],
      'IMPORT_CONTEXT_KIND',
    );
    requiredString(context.label, 'IMPORT_CONTEXT_LABEL');
    optionalString(context.origin, 'IMPORT_CONTEXT_ORIGIN');
    optionalEnum(context.trust, ['trusted', 'untrusted'], 'IMPORT_CONTEXT_TRUST');
    optionalEnum(
      context.provenance,
      ['user', 'page', 'mcp', 'tool', 'import', 'plugin'],
      'IMPORT_CONTEXT_PROVENANCE',
    );
    optionalString(context.sourceRef, 'IMPORT_CONTEXT_SOURCE');
    if (context.tab !== undefined) browserTab(context.tab);
    contentBlocks(context.content, 'IMPORT_CONTEXT_CONTENT');
    if (context.approxTokens !== undefined)
      nonnegativeFinite(context.approxTokens, 'IMPORT_CONTEXT_TOKENS');
  }
}

function browserContext(value: unknown): void {
  const context = object(value, 'IMPORT_BROWSER_CONTEXT');
  exact(context, ['capturedAt', 'defaultTab', 'referencedTabs'], 'IMPORT_BROWSER_CONTEXT');
  timestamp(context.capturedAt, 'IMPORT_BROWSER_TIME');
  if (context.defaultTab !== undefined) browserTab(context.defaultTab);
  for (const tab of array(context.referencedTabs, MAX_ASSETS, 'IMPORT_BROWSER_TABS'))
    browserTab(tab);
}

function browserTab(value: unknown): void {
  const tab = object(value, 'IMPORT_BROWSER_TAB');
  exact(tab, ['tabId', 'url', 'title'], 'IMPORT_BROWSER_TAB');
  nonnegativeInteger(tab.tabId, 'IMPORT_BROWSER_TAB_ID');
  requiredString(tab.url, 'IMPORT_BROWSER_TAB_URL');
  requiredString(tab.title, 'IMPORT_BROWSER_TAB_TITLE', true);
}

function providerAssistantState(value: unknown): void {
  const label = 'IMPORT_ASSISTANT_PROVIDER_STATE';
  const state = object(value, label);
  exact(state, ['kind', 'thinkingBlocks'], label);
  if (state.kind !== 'anthropic') throw new Error(label);
  for (const candidate of array(state.thinkingBlocks, MAX_ASSETS, label)) {
    const block = object(candidate, label);
    if (block.type === 'thinking') {
      exact(block, ['type', 'thinking', 'signature'], label);
      requiredString(block.thinking, label, true);
      requiredString(block.signature, label, true);
    } else if (block.type === 'redacted_thinking') {
      exact(block, ['type', 'data'], label);
      requiredString(block.data, label);
    } else {
      throw new Error(label);
    }
  }
}

function usage(value: unknown): void {
  const stats = object(value, 'IMPORT_USAGE');
  exact(stats, ['input', 'output', 'cacheRead'], 'IMPORT_USAGE');
  nonnegativeFinite(stats.input, 'IMPORT_USAGE_INPUT');
  nonnegativeFinite(stats.output, 'IMPORT_USAGE_OUTPUT');
  if (stats.cacheRead !== undefined) nonnegativeFinite(stats.cacheRead, 'IMPORT_USAGE_CACHE');
}

function modelRef(value: unknown, label: string): void {
  const model = object(value, label);
  exact(model, ['connectionId', 'modelId'], label);
  requiredString(model.connectionId, label);
  requiredString(model.modelId, label);
}

function assertAcyclic(
  nodes: Map<string, { parentId: string | null }>,
  label = 'IMPORT_NODE_PARENT_CYCLE',
): void {
  const complete = new Set<string>();
  for (const id of nodes.keys()) {
    if (complete.has(id)) continue;
    const path = new Set<string>();
    let current: string | null = id;
    while (current !== null && !complete.has(current)) {
      if (path.has(current)) throw new Error(label);
      path.add(current);
      current = nodes.get(current)?.parentId ?? null;
    }
    for (const visited of path) complete.add(visited);
  }
}

function requiredJsonValue(value: JsonRecord, key: string, label: string): void {
  if (!Object.prototype.hasOwnProperty.call(value, key) || value[key] === undefined) {
    throw new Error(label);
  }
  assertJsonValue(value[key], true);
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  const leftRecord = objectOrUndefined(left);
  const rightRecord = objectOrUndefined(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => {
      const rightKey = rightKeys[index];
      return (
        rightKey !== undefined &&
        key === rightKey &&
        sameJsonValue(leftRecord[key], rightRecord[rightKey])
      );
    })
  );
}

function uniqueIds(values: readonly unknown[], label: string): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const id = requiredString(object(value, `IMPORT_${label}`).id, `IMPORT_${label}_ID`);
    if (result.has(id)) throw new Error(`IMPORT_${label}_ID`);
    result.add(id);
  }
  return result;
}

function validateSecretValue(value: unknown, mode: SecretMode, label: string): void {
  if (typeof value !== 'string') throw new Error(label);
  if (mode === 'sanitized') {
    if (value !== '') throw new Error(label);
    return;
  }
  if (value !== '' && !/^secret:v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(label);
  }
}

function validLocalSecretKey(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 32 &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  );
}

function assertJsonValue(value: unknown, rejectUndefinedProperties = false): number {
  const active = new Set<object>();
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_JSON_DEPTH) throw new Error('IMPORT_JSON_DEPTH');
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean')
      return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new Error('IMPORT_JSON_NUMBER');
      return;
    }
    if (typeof candidate !== 'object') throw new Error('IMPORT_JSON_VALUE');
    if (active.has(candidate)) throw new Error('IMPORT_JSON_CYCLE');
    active.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry, depth + 1);
    } else {
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error('IMPORT_JSON_OBJECT');
      for (const entry of Object.values(candidate as JsonRecord)) {
        if (entry === undefined && !rejectUndefinedProperties) continue;
        visit(entry, depth + 1);
      }
    }
    active.delete(candidate);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_IMPORT_BYTES) throw new Error('IMPORT_TOO_LARGE');
  return bytes;
}

function object(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(label);
  return value as JsonRecord;
}

function objectOrUndefined(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function array(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(label);
  return value;
}

function exact(value: JsonRecord, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error(label);
}

function string(value: unknown): value is string {
  return typeof value === 'string';
}

function requiredString(value: unknown, label: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value)) throw new Error(label);
  return value;
}

function optionalString(value: unknown, label: string, empty = false): void {
  if (value !== undefined) requiredString(value, label, empty);
}

function boolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(label);
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined) boolean(value, label);
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(label);
  return value;
}

function nonnegativeFinite(value: unknown, label: string): number {
  const result = finite(value, label);
  if (result < 0) throw new Error(label);
  return result;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(label);
  return value as number;
}

function timestamp(value: unknown, label: string): number {
  return nonnegativeFinite(value, label);
}

function enumValue(value: unknown, allowed: readonly string[], label: string): void {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(label);
}

function optionalEnum(value: unknown, allowed: readonly string[], label: string): void {
  if (value !== undefined) enumValue(value, allowed, label);
}

function stringArray(value: unknown, label: string): string[] {
  const result = array(value, MAX_ASSETS, label);
  if (result.some((entry) => typeof entry !== 'string')) throw new Error(label);
  return result as string[];
}

function enumArray(value: unknown, allowed: readonly string[], label: string): void {
  const result = stringArray(value, label);
  if (result.some((entry) => !allowed.includes(entry))) throw new Error(label);
}

function base64(value: unknown, expectedBytes: number, label: string, minimum = false): void {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(label);
  let bytes: number;
  try {
    bytes = atob(value).length;
  } catch {
    throw new Error(label);
  }
  if (minimum ? bytes < expectedBytes : bytes !== expectedBytes) throw new Error(label);
}
