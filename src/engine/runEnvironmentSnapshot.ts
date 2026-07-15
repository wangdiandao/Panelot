import { ToolRegistry, type AnyAgentTool } from '../agent/tool';
import type {
  ProviderEnvironmentBinding,
  ResolvedRunEnvironment,
  RunEnvironmentSnapshot,
  RunSkillSnapshot,
  RunToolSnapshot,
  ToolExecutionBinding,
} from '../db/types';
import type { UserInput } from '../messaging/protocol';
import { normalizePermissionPolicy } from '../settings/permissionPolicy';

export const RUN_ENVIRONMENT_SNAPSHOT_LIMITS = {
  totalBytes: 2 * 1024 * 1024,
  depth: 64,
  skills: 128,
  tools: 256,
  skillBodyBytes: 256 * 1024,
  totalSkillBodyBytes: 1024 * 1024,
  toolSchemaBytes: 128 * 1024,
  systemPromptBytes: 256 * 1024,
  containerEntries: 10_000,
  nodes: 100_000,
} as const;

const textEncoder = new TextEncoder();

export class RunEnvironmentSnapshotError extends Error {
  readonly code: 'environment_snapshot_unsupported' | 'environment_snapshot_invalid';

  constructor(code: RunEnvironmentSnapshotError['code'], message: string) {
    super(message);
    this.name = 'RunEnvironmentSnapshotError';
    this.code = code;
  }
}

export function isRunEnvironmentSnapshot(
  environment: ResolvedRunEnvironment | RunEnvironmentSnapshot | undefined,
): environment is RunEnvironmentSnapshot {
  return (
    !!environment &&
    (environment as Partial<RunEnvironmentSnapshot>).snapshotVersion === 1 &&
    typeof (environment as Partial<RunEnvironmentSnapshot>).digest === 'string'
  );
}

export async function digestCanonical(
  value: unknown,
  maxBytes = RUN_ENVIRONMENT_SNAPSHOT_LIMITS.totalBytes,
): Promise<string> {
  const bytes = textEncoder.encode(canonicalJson(value, maxBytes));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function captureSkillCatalog(
  skills: readonly Omit<RunSkillSnapshot, 'digest'>[],
): Promise<RunSkillSnapshot[]> {
  assertSkillCatalogBounds(skills);
  return Promise.all(
    [...skills]
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(async (skill) => ({ ...structuredClone(skill), digest: await digestCanonical(skill) })),
  );
}

export async function captureToolCatalog(
  registry: ToolRegistry,
  enabledLevels: RunEnvironmentSnapshot['enabledToolLevels'],
): Promise<RunToolSnapshot[]> {
  const tools = registry.list(enabledLevels);
  if (tools.length > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.tools) {
    throw invalid('The tool catalog exceeds the environment snapshot limit.');
  }
  const providerSchemas = new Map(
    registry.schemas(enabledLevels).map((toolSchema) => [toolSchema.name, toolSchema]),
  );
  return Promise.all(
    tools
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(async (tool) => {
        const providerSchema = providerSchemas.get(tool.name);
        if (!providerSchema) throw invalid(`Tool schema is missing for ${tool.name}.`);
        const withoutDigest: Omit<RunToolSnapshot, 'digest'> = {
          name: tool.name,
          label: tool.label,
          description: providerSchema.description,
          parameters: providerSchema.parameters,
          level: tool.level,
          effects: tool.effects,
          recovery: tool.recovery ?? (tool.effects === 'read' ? 'retry-safe' : 'never-retry'),
          resultTrust: tool.resultTrust,
          resultProvenance: tool.resultProvenance,
          execution: tool.executionBinding ?? localBinding(tool),
        };
        assertCanonicalLimit(
          withoutDigest,
          RUN_ENVIRONMENT_SNAPSHOT_LIMITS.toolSchemaBytes,
          'A tool schema exceeds the environment snapshot limit.',
        );
        return {
          ...structuredClone(withoutDigest),
          digest: await digestCanonical(
            withoutDigest,
            RUN_ENVIRONMENT_SNAPSHOT_LIMITS.toolSchemaBytes,
          ),
        };
      }),
  );
}

export async function createRunEnvironmentSnapshot(input: {
  environment: ResolvedRunEnvironment;
  normalizedInput: UserInput;
  providerBinding: ProviderEnvironmentBinding;
  systemPrompt: string;
  skillCatalog: RunSkillSnapshot[];
  toolCatalog: RunToolSnapshot[];
  capturedAt?: number;
}): Promise<RunEnvironmentSnapshot> {
  assertCanonicalLimit(
    input.normalizedInput,
    RUN_ENVIRONMENT_SNAPSHOT_LIMITS.totalBytes,
    'The normalized run input exceeds the environment snapshot limit.',
  );
  assertSnapshotCatalogBounds(input.systemPrompt, input.skillCatalog, input.toolCatalog);
  const rawWithoutDigest: Omit<RunEnvironmentSnapshot, 'digest'> = {
    ...input.environment,
    snapshotVersion: 1,
    capturedAt: input.capturedAt ?? Date.now(),
    inputDigest: await digestCanonical(input.normalizedInput),
    providerBinding: input.providerBinding,
    systemPrompt: input.systemPrompt,
    systemPromptDigest: await digestCanonical(input.systemPrompt),
    skillCatalog: input.skillCatalog,
    toolCatalog: input.toolCatalog,
    toolCatalogDigest: await digestCanonical(input.toolCatalog),
  };
  assertCanonicalLimit(
    rawWithoutDigest,
    RUN_ENVIRONMENT_SNAPSHOT_LIMITS.totalBytes,
    'The environment snapshot exceeds its total size limit.',
  );
  const withoutDigest = structuredClone(rawWithoutDigest);
  const snapshot = { ...withoutDigest, digest: await digestCanonical(withoutDigest) };
  assertRunEnvironmentSnapshotBounds(snapshot);
  return snapshot;
}

export async function resealRunEnvironmentSnapshot(
  snapshot: RunEnvironmentSnapshot,
): Promise<RunEnvironmentSnapshot> {
  assertRunEnvironmentSnapshotBounds(snapshot);
  const { digest: discarded, ...withoutDigest } = snapshot;
  void discarded;
  return { ...withoutDigest, digest: await digestCanonical(withoutDigest) };
}

export async function verifyRunEnvironmentSnapshot(
  environment: ResolvedRunEnvironment | RunEnvironmentSnapshot | undefined,
  normalizedInput: UserInput,
): Promise<RunEnvironmentSnapshot> {
  if (!isRunEnvironmentSnapshot(environment)) {
    throw new RunEnvironmentSnapshotError(
      'environment_snapshot_unsupported',
      'This run was started without a recoverable environment snapshot.',
    );
  }
  assertRunEnvironmentSnapshotBounds(environment);
  if (environment.inputDigest !== (await digestCanonical(normalizedInput))) {
    throw invalid('The persisted run input does not match its environment snapshot.');
  }
  if (environment.systemPromptDigest !== (await digestCanonical(environment.systemPrompt))) {
    throw invalid('The persisted system prompt does not match its digest.');
  }
  for (const skill of environment.skillCatalog) {
    const { digest, ...withoutDigest } = skill;
    if (digest !== (await digestCanonical(withoutDigest))) {
      throw invalid(`The persisted skill ${skill.name} does not match its digest.`);
    }
  }
  for (const tool of environment.toolCatalog) {
    const { digest, ...withoutDigest } = tool;
    if (digest !== (await digestCanonical(withoutDigest))) {
      throw invalid(`The persisted tool ${tool.name} does not match its digest.`);
    }
  }
  if (environment.toolCatalogDigest !== (await digestCanonical(environment.toolCatalog))) {
    throw invalid('The persisted tool catalog does not match its digest.');
  }
  const { digest, ...withoutDigest } = environment;
  if (digest !== (await digestCanonical(withoutDigest))) {
    throw invalid('The persisted environment snapshot does not match its digest.');
  }
  return normalizeLegacyRunEnvironmentSnapshot(environment);
}

async function normalizeLegacyRunEnvironmentSnapshot(
  environment: RunEnvironmentSnapshot,
): Promise<RunEnvironmentSnapshot> {
  const legacy = environment as RunEnvironmentSnapshot & {
    approvalPolicy?: string;
    capabilityScope?: string;
  };
  const permissionPolicy =
    normalizePermissionPolicy(
      environment.permissionPolicy ?? legacy.approvalPolicy,
      legacy.capabilityScope,
    ) ?? 'untrusted';
  if (
    environment.permissionPolicy === permissionPolicy &&
    legacy.approvalPolicy === undefined &&
    legacy.capabilityScope === undefined
  ) {
    return environment;
  }

  const {
    digest: discardedDigest,
    approvalPolicy: discardedApprovalPolicy,
    capabilityScope: discardedCapabilityScope,
    ...current
  } = legacy;
  void discardedDigest;
  void discardedApprovalPolicy;
  void discardedCapabilityScope;
  const normalized = { ...current, permissionPolicy };
  return { ...normalized, digest: await digestCanonical(normalized) };
}

export async function bindToolRegistry(
  current: ToolRegistry,
  snapshot: RunEnvironmentSnapshot,
): Promise<ToolRegistry> {
  const capturedCurrent = await captureToolCatalog(current, snapshot.enabledToolLevels);
  const currentByName = new Map(capturedCurrent.map((tool) => [tool.name, tool]));
  const bound = new ToolRegistry();
  for (const persisted of snapshot.toolCatalog) {
    const live = currentByName.get(persisted.name);
    if (!live || live.digest !== persisted.digest) {
      throw invalid(`Tool execution binding changed for ${persisted.name}.`);
    }
    const implementation = current.get(persisted.name);
    if (!implementation) throw invalid(`Tool implementation is missing for ${persisted.name}.`);
    bound.register(implementation);
  }
  return bound;
}

function localBinding(tool: AnyAgentTool): ToolExecutionBinding {
  return { kind: 'local', id: tool.name };
}

function invalid(message: string): RunEnvironmentSnapshotError {
  return new RunEnvironmentSnapshotError('environment_snapshot_invalid', message);
}

function assertRunEnvironmentSnapshotBounds(snapshot: RunEnvironmentSnapshot): void {
  assertSnapshotCatalogBounds(snapshot.systemPrompt, snapshot.skillCatalog, snapshot.toolCatalog);
  assertCanonicalLimit(
    snapshot,
    RUN_ENVIRONMENT_SNAPSHOT_LIMITS.totalBytes,
    'The environment snapshot exceeds its total size limit.',
  );
}

function assertSnapshotCatalogBounds(
  systemPrompt: string,
  skills: readonly RunSkillSnapshot[],
  tools: readonly RunToolSnapshot[],
): void {
  assertTextLimit(
    systemPrompt,
    RUN_ENVIRONMENT_SNAPSHOT_LIMITS.systemPromptBytes,
    'The system prompt exceeds the environment snapshot limit.',
  );
  assertSkillCatalogBounds(skills);
  if (tools.length > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.tools) {
    throw invalid('The tool catalog exceeds the environment snapshot limit.');
  }
  for (const tool of tools) {
    assertCanonicalLimit(
      tool,
      RUN_ENVIRONMENT_SNAPSHOT_LIMITS.toolSchemaBytes,
      'A tool schema exceeds the environment snapshot limit.',
    );
  }
}

function assertSkillCatalogBounds(
  skills: readonly (RunSkillSnapshot | Omit<RunSkillSnapshot, 'digest'>)[],
): void {
  if (skills.length > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.skills) {
    throw invalid('The skill catalog exceeds the environment snapshot limit.');
  }
  let totalBodyBytes = 0;
  for (const skill of skills) {
    const bodyBytes = textEncoder.encode(skill.body).byteLength;
    if (bodyBytes > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.skillBodyBytes) {
      throw invalid('A skill body exceeds the environment snapshot limit.');
    }
    totalBodyBytes += bodyBytes;
    if (totalBodyBytes > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.totalSkillBodyBytes) {
      throw invalid('The skill catalog exceeds the environment snapshot limit.');
    }
  }
  assertCanonicalLimit(
    skills,
    RUN_ENVIRONMENT_SNAPSHOT_LIMITS.totalBytes,
    'The skill catalog exceeds the environment snapshot limit.',
  );
}

function assertTextLimit(value: string, maxBytes: number, message: string): void {
  if (textEncoder.encode(value).byteLength > maxBytes) throw invalid(message);
}

function assertCanonicalLimit(value: unknown, maxBytes: number, message: string): void {
  try {
    canonicalJson(value, maxBytes);
  } catch (error) {
    if (error instanceof RunEnvironmentSnapshotError) throw error;
    throw invalid(message);
  }
}

interface CanonicalState {
  bytes: number;
  nodes: number;
  maxBytes: number;
}

function canonicalJson(value: unknown, maxBytes: number): string {
  const state: CanonicalState = { bytes: 0, nodes: 0, maxBytes };
  const normalized = normalize(value, 0, state);
  const result = JSON.stringify(normalized);
  if (textEncoder.encode(result).byteLength > maxBytes) {
    throw invalid('The environment snapshot exceeds its size limit.');
  }
  return result;
}

function normalize(value: unknown, depth: number, state: CanonicalState): unknown {
  if (depth > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.depth) {
    throw invalid('The environment snapshot exceeds its nesting limit.');
  }
  state.nodes += 1;
  if (state.nodes > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.nodes) {
    throw invalid('The environment snapshot exceeds its structural limit.');
  }
  if (value === undefined) {
    addCanonicalBytes(state, 4);
    return null;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    addCanonicalBytes(state, textEncoder.encode(JSON.stringify(value)).byteLength);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw invalid('Environment snapshot contains a non-finite number.');
    addCanonicalBytes(state, String(value).length);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.containerEntries) {
      throw invalid('The environment snapshot contains an oversized array.');
    }
    addCanonicalBytes(state, 2 + Math.max(0, value.length - 1));
    return value.map((entry) => normalize(entry, depth + 1, state));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries: [string, unknown][] = [];
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key) || record[key] === undefined) continue;
      entries.push([key, record[key]]);
      if (entries.length > RUN_ENVIRONMENT_SNAPSHOT_LIMITS.containerEntries) {
        throw invalid('The environment snapshot contains an oversized object.');
      }
    }
    entries.sort(([left], [right]) => left.localeCompare(right));
    addCanonicalBytes(state, 2 + Math.max(0, entries.length - 1));
    return Object.fromEntries(
      entries.map(([key, entry]) => {
        addCanonicalBytes(state, textEncoder.encode(JSON.stringify(key)).byteLength + 1);
        return [key, normalize(entry, depth + 1, state)];
      }),
    );
  }
  throw invalid('Environment snapshot contains a non-serializable value.');
}

function addCanonicalBytes(state: CanonicalState, bytes: number): void {
  state.bytes += bytes;
  if (state.bytes > state.maxBytes) {
    throw invalid('The environment snapshot exceeds its size limit.');
  }
}
