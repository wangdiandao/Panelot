import JSZip, { type JSZipObject } from 'jszip';
import type { PanelotDB } from '../db/schema';
import type { PluginAssetRecord, PluginRecord, SkillRecord } from '../db/types';
import { listSkillFileDependencies, parseSkill } from '../skills/parse';
import { parsePluginPresetAsset, parsePluginSiteInstructionAsset } from './assets';
import {
  freezeInstallPlan,
  MAX_PLUGIN_FILES,
  parsePluginManifest,
  type PluginInstallPlan,
  type PluginInstallSource,
  type PluginManifest,
} from './manifest';

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MANIFEST_PATH = '.codex-plugin/plugin.json';
const DEFAULT_INSTALL_PLAN_TTL_MS = 5 * 60 * 1_000;
const EXECUTABLE_EXTENSIONS = new Set([
  'bat',
  'cmd',
  'com',
  'dll',
  'exe',
  'jar',
  'js',
  'jse',
  'msi',
  'ps1',
  'scr',
  'vbs',
  'wsf',
]);

interface ZipEntryMetadata {
  unsafeOriginalName?: string;
  unixPermissions?: number | string | null;
}

interface ZipEntryStream {
  on(event: 'data', listener: (chunk: Uint8Array) => void): ZipEntryStream;
  on(event: 'end', listener: () => void): ZipEntryStream;
  on(event: 'error', listener: (error: Error) => void): ZipEntryStream;
  pause(): ZipEntryStream;
  resume(): ZipEntryStream;
}

interface StreamableZipEntry extends JSZipObject {
  internalStream(type: 'uint8array'): ZipEntryStream;
}

interface ArchiveOutputBudget {
  outputBytes: number;
}

interface NormalizedZipEntry {
  entry: JSZipObject;
  path: string;
}

interface PreparedAsset {
  path: string;
  kind: PluginManifest['assets'][number]['kind'];
  mime: string;
  bytes: Uint8Array;
}

interface PreparedSkill {
  path: string;
  raw: string;
  frontmatter: ReturnType<typeof parseSkill>['frontmatter'];
  body: string;
}

interface PreparedArchive {
  manifest: PluginManifest;
  assets: PreparedAsset[];
  skills: PreparedSkill[];
  presets: PluginInstallPlan['presets'];
  siteInstructions: PluginInstallPlan['siteInstructions'];
}

interface InstallPlanContext {
  source: PluginRecord['source'];
  localBytes?: ArrayBuffer;
  url?: string;
}

export interface PluginManagerOptions {
  now?: () => number;
  fetch?: typeof fetch;
  installPlanTtlMs?: number;
}

export function pluginDownloadPermissionOrigins(value: string | URL): string[] {
  const parsed = typeof value === 'string' ? new URL(value) : value;
  assertGitHubPluginUrl(parsed);
  if (parsed.hostname === 'github.com') {
    return [parsed.origin, 'https://api.github.com', 'https://codeload.github.com'];
  }
  return [parsed.origin];
}

export class PluginManager {
  private readonly installPlans = new WeakMap<PluginInstallPlan, InstallPlanContext>();
  private readonly now: () => number;
  private readonly fetch: typeof fetch;
  private readonly installPlanTtlMs: number;

  constructor(
    private db: PanelotDB,
    options: PluginManagerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.fetch =
      options.fetch ??
      ((input: URL | RequestInfo, init?: RequestInit) => globalThis.fetch(input, init));
    this.installPlanTtlMs = options.installPlanTtlMs ?? DEFAULT_INSTALL_PLAN_TTL_MS;
    if (!Number.isFinite(this.installPlanTtlMs) || this.installPlanTtlMs <= 0) {
      throw new Error('Plugin install plan TTL must be positive');
    }
  }

  async analyzeZip(
    input: ArrayBuffer,
    source: { kind: 'zip'; ref?: string } = { kind: 'zip' },
  ): Promise<PluginInstallPlan> {
    const bytes = input.slice(0);
    return this.analyzeBytes(bytes, { kind: 'zip', label: source.ref ?? 'Local ZIP' }, source, {
      localBytes: bytes,
    });
  }

  async analyzeUrl(url: string): Promise<PluginInstallPlan> {
    const parsed = new URL(url);
    assertGitHubPluginUrl(parsed);
    const archiveUrl = await resolveGitHubArchiveUrl(parsed, this.fetch);
    const bytes = await downloadArchive(archiveUrl, this.fetch);
    return this.analyzeBytes(
      bytes,
      { kind: 'github', label: parsed.href, resolvedUrl: archiveUrl },
      { kind: 'github', ref: parsed.href },
      { url: parsed.href },
    );
  }

  async commit(plan: PluginInstallPlan, confirmation: { confirmed: true }): Promise<PluginRecord> {
    if (confirmation?.confirmed !== true) {
      throw new Error('Plugin installation requires explicit confirmation');
    }
    const context = this.installPlans.get(plan);
    if (!context) throw new Error('Plugin install plan was not created by this manager');
    if (this.now() > plan.expiresAt) throw new Error('Plugin install plan expired; analyze again');

    let input: ArrayBuffer;
    if (context.url) {
      const parsed = new URL(context.url);
      const archiveUrl = await resolveGitHubArchiveUrl(parsed, this.fetch);
      input = await downloadArchive(archiveUrl, this.fetch);
    } else if (context.localBytes) {
      input = context.localBytes.slice(0);
    } else {
      throw new Error('Plugin install plan has no verified source');
    }

    const digest = await digestArchive(input);
    if (digest !== plan.digest) {
      throw new Error('Plugin source changed after analysis; analyze again');
    }
    const prepared = await prepareArchive(input);
    const now = this.now();

    const result = await this.db.transaction(
      'rw',
      [this.db.plugins, this.db.pluginAssets, this.db.skills],
      async () => {
        const existing = await this.db.plugins.get(prepared.manifest.id);
        assertPlanDatabaseState(plan, existing);
        await this.validateConflicts(prepared.manifest, prepared.skills, existing);

        const assets = createAssetRecords(prepared, now);
        const skills = createSkillRecords(prepared, now);
        const plugin: PluginRecord = {
          id: prepared.manifest.id,
          name: prepared.manifest.name,
          version: prepared.manifest.version,
          description: prepared.manifest.description,
          source: context.source,
          enabled: false,
          manifest: prepared.manifest,
          assetIds: assets.map((asset) => asset.id),
          installedAt: existing?.installedAt ?? now,
          updatedAt: now,
        };

        if (existing) {
          await this.db.skills.where('sourceRef').equals(existing.id).delete();
          await this.db.pluginAssets.where('pluginId').equals(existing.id).delete();
        }
        await this.db.plugins.put(plugin);
        if (assets.length > 0) await this.db.pluginAssets.bulkAdd(assets);
        if (skills.length > 0) await this.db.skills.bulkAdd(skills);
        return plugin;
      },
    );
    this.installPlans.delete(plan);
    return result;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.transaction('rw', [this.db.plugins, this.db.skills], async () => {
      const plugin = await this.db.plugins.get(id);
      if (!plugin) throw new Error(`Plugin not found: ${id}`);
      await this.db.plugins.update(id, { enabled, updatedAt: this.now() });
      await this.db.skills.where('sourceRef').equals(id).modify({ enabled });
    });
  }

  async uninstall(id: string): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.plugins, this.db.pluginAssets, this.db.skills],
      async () => {
        await this.db.skills.where('sourceRef').equals(id).delete();
        await this.db.pluginAssets.where('pluginId').equals(id).delete();
        await this.db.plugins.delete(id);
      },
    );
  }

  async copySkillToUser(assetId: string): Promise<SkillRecord> {
    const asset = await this.db.pluginAssets.get(assetId);
    if (!asset || asset.kind !== 'skill')
      throw new Error(`Plugin skill asset not found: ${assetId}`);
    const raw = await asset.bytes.text();
    const parsed = parseSkill(raw);
    const now = this.now();
    const copy: SkillRecord = {
      id: crypto.randomUUID(),
      name: await this.availableSkillName(parsed.frontmatter.name),
      raw,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      enabled: true,
      source: 'user',
      createdAt: now,
      updatedAt: now,
    };
    if (copy.name !== parsed.frontmatter.name) {
      copy.frontmatter = { ...parsed.frontmatter, name: copy.name };
      copy.raw = replaceSkillName(raw, copy.name);
    }
    await this.db.skills.add(copy);
    return copy;
  }

  async copyInstalledSkillToUser(skillId: string): Promise<SkillRecord> {
    const skill = await this.db.skills.get(skillId);
    if (!skill || skill.source !== 'plugin' || !skill.sourceRef) {
      throw new Error(`Plugin skill not found: ${skillId}`);
    }
    const assets = await this.db.pluginAssets
      .where('pluginId')
      .equals(skill.sourceRef)
      .filter((asset) => asset.kind === 'skill')
      .toArray();
    for (const asset of assets) {
      const parsed = parseSkill(await asset.bytes.text());
      if (parsed.frontmatter.name === skill.name) return this.copySkillToUser(asset.id);
    }
    throw new Error(`Plugin asset for skill ${skill.name} not found`);
  }

  private async analyzeBytes(
    input: ArrayBuffer,
    source: PluginInstallSource,
    recordSource: PluginRecord['source'],
    context: Pick<InstallPlanContext, 'localBytes' | 'url'>,
  ): Promise<PluginInstallPlan> {
    const [digest, prepared] = await Promise.all([digestArchive(input), prepareArchive(input)]);
    const existing = await this.db.plugins.get(prepared.manifest.id);
    await this.validateConflicts(prepared.manifest, prepared.skills, existing);
    const analyzedAt = this.now();
    const promptAssets =
      prepared.skills.length > 0 ||
      prepared.siteInstructions.length > 0 ||
      prepared.presets.some((preset) => preset.systemPromptSummary !== undefined);
    const warnings: PluginInstallPlan['warnings'][number][] = [];
    if (promptAssets) warnings.push('prompt-assets-disabled');
    if (existing) warnings.push('upgrade-disables-plugin');
    if (prepared.assets.some((asset) => asset.kind === 'other')) warnings.push('opaque-assets');

    const plan = freezeInstallPlan({
      format: 'panelot-plugin-install-plan',
      digest,
      analyzedAt,
      expiresAt: analyzedAt + this.installPlanTtlMs,
      source,
      operation: existing ? 'upgrade' : 'install',
      existing: existing ? { version: existing.version, enabled: existing.enabled } : undefined,
      manifest: {
        ...prepared.manifest,
        assets: prepared.manifest.assets.map((asset) => ({ ...asset })),
      },
      assets: prepared.assets.map((asset) => ({
        path: asset.path,
        kind: asset.kind,
        mime: asset.mime,
        bytes: asset.bytes.byteLength,
      })),
      skills: prepared.skills.map((skill) => ({
        path: skill.path,
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
      })),
      presets: prepared.presets,
      siteInstructions: prepared.siteInstructions,
      warnings,
    });
    this.installPlans.set(plan, { source: recordSource, ...context });
    return plan;
  }

  private async validateConflicts(
    manifest: PluginManifest,
    skills: readonly PreparedSkill[],
    existing: PluginRecord | undefined,
  ): Promise<void> {
    const nameConflict = await this.db.plugins.where('name').equals(manifest.name).first();
    if (nameConflict && nameConflict.id !== manifest.id) {
      throw new Error(`Plugin name conflict: ${manifest.name}`);
    }
    const names = new Set<string>();
    for (const skill of skills) {
      if (names.has(skill.frontmatter.name)) {
        throw new Error(`Plugin skill name conflict: ${skill.frontmatter.name}`);
      }
      const conflict = await this.db.skills.where('name').equals(skill.frontmatter.name).first();
      if (
        conflict &&
        !(existing && conflict.source === 'plugin' && conflict.sourceRef === existing.id)
      ) {
        throw new Error(`Plugin skill name conflict: ${skill.frontmatter.name}`);
      }
      names.add(skill.frontmatter.name);
    }
  }

  private async availableSkillName(base: string): Promise<string> {
    if (!(await this.db.skills.where('name').equals(base).first())) return base;
    for (let suffix = 2; suffix < 10_000; suffix++) {
      const name = `${base}-${suffix}`;
      if (!(await this.db.skills.where('name').equals(name).first())) return name;
    }
    throw new Error(`Unable to copy skill ${base}`);
  }
}

async function prepareArchive(input: ArrayBuffer): Promise<PreparedArchive> {
  if (input.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error('Plugin ZIP exceeds the 10 MB compressed limit');
  }
  const zip = await JSZip.loadAsync(input);
  const archiveFiles = Object.values(zip.files).filter((entry) => !entry.dir);
  if (archiveFiles.length > MAX_PLUGIN_FILES) {
    throw new Error(`Plugin ZIP exceeds the ${MAX_PLUGIN_FILES} file limit`);
  }
  validateEntries(archiveFiles);
  const files = normalizeArchiveEntries(archiveFiles);

  const fileBytes = new Map<string, Uint8Array>();
  const budget: ArchiveOutputBudget = { outputBytes: 0 };
  for (const { entry, path } of files) {
    const bytes = await readEntryWithinBudget(entry, budget);
    fileBytes.set(path, bytes);
  }

  const manifestBytes = fileBytes.get(MANIFEST_PATH);
  if (!manifestBytes) throw new Error(`Plugin manifest not found: ${MANIFEST_PATH}`);
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (error) {
    throw new Error(
      `Plugin manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = parsePluginManifest(manifestJson);
  const declaredPaths = new Set<string>();
  for (const asset of manifest.assets) {
    const path = validatePath(asset.path);
    if (path === MANIFEST_PATH)
      throw new Error('Plugin manifest cannot declare itself as an asset');
    if (declaredPaths.has(path)) throw new Error('Plugin manifest has duplicate assets');
    declaredPaths.add(path);
  }
  for (const file of files) {
    if (file.path !== MANIFEST_PATH && !declaredPaths.has(file.path)) {
      throw new Error(`Plugin file is not declared in the manifest: ${file.path}`);
    }
  }

  const assets: PreparedAsset[] = [];
  const skills: PreparedSkill[] = [];
  const presets: PluginInstallPlan['presets'][number][] = [];
  const siteInstructions: PluginInstallPlan['siteInstructions'][number][] = [];
  for (const declared of manifest.assets) {
    const path = validatePath(declared.path);
    const bytes = fileBytes.get(path);
    if (!bytes) throw new Error(`Plugin asset not found: ${path}`);
    const assetId = `${manifest.id}\u0000${path}`;
    assets.push({ path, kind: declared.kind, mime: mimeFor(path), bytes });
    if (declared.kind === 'skill') {
      const raw = new TextDecoder().decode(bytes);
      const parsed = parseSkill(raw);
      skills.push({ path, raw, frontmatter: parsed.frontmatter, body: parsed.body });
      validateSkillReferences(path, raw, declaredPaths);
    } else if (declared.kind === 'preset') {
      for (const { preset } of parsePluginPresetAsset(bytes, manifest.id, assetId, path)) {
        presets.push({
          path,
          id: preset.id,
          name: preset.name,
          model: `${preset.base.connectionId}/${preset.base.modelId}`,
          systemPromptSummary: preset.systemPrompt
            ? summarizeInstruction(preset.systemPrompt)
            : undefined,
        });
      }
    } else if (declared.kind === 'site-instruction') {
      for (const instruction of parsePluginSiteInstructionAsset(
        bytes,
        manifest.id,
        assetId,
        path,
      )) {
        siteInstructions.push({
          path,
          pattern: instruction.pattern,
          instructionSummary: summarizeInstruction(instruction.prompt),
        });
      }
    }
  }
  return { manifest, assets, skills, presets, siteInstructions };
}

function createAssetRecords(prepared: PreparedArchive, now: number): PluginAssetRecord[] {
  return prepared.assets.map((asset) => {
    const buffer = asset.bytes.buffer.slice(
      asset.bytes.byteOffset,
      asset.bytes.byteOffset + asset.bytes.byteLength,
    ) as ArrayBuffer;
    return {
      id: `${prepared.manifest.id}\u0000${asset.path}`,
      pluginId: prepared.manifest.id,
      path: asset.path,
      kind: asset.kind,
      mime: asset.mime,
      bytes: new Blob([buffer], { type: asset.mime }),
      readOnly: true,
      createdAt: now,
    };
  });
}

function createSkillRecords(prepared: PreparedArchive, now: number): SkillRecord[] {
  return prepared.skills.map((skill) => ({
    id: crypto.randomUUID(),
    name: skill.frontmatter.name,
    raw: skill.raw,
    frontmatter: skill.frontmatter,
    body: skill.body,
    enabled: false,
    source: 'plugin',
    sourceRef: prepared.manifest.id,
    createdAt: now,
    updatedAt: now,
  }));
}

function assertPlanDatabaseState(
  plan: PluginInstallPlan,
  existing: PluginRecord | undefined,
): void {
  if (plan.operation === 'install' && existing) {
    throw new Error(`Plugin id conflict: ${plan.manifest.id}; analyze again`);
  }
  if (plan.operation === 'upgrade') {
    if (!existing)
      throw new Error(`Plugin ${plan.manifest.id} is no longer installed; analyze again`);
    if (
      existing.version !== plan.existing?.version ||
      existing.enabled !== plan.existing?.enabled
    ) {
      throw new Error(`Plugin ${plan.manifest.id} changed after analysis; analyze again`);
    }
  }
}

function validateEntries(entries: JSZipObject[]): void {
  for (const entry of entries) {
    const metadata = entry as JSZipObject & ZipEntryMetadata;
    const original = metadata.unsafeOriginalName ?? entry.name;
    const path = validatePath(original);
    const permissions =
      typeof metadata.unixPermissions === 'string'
        ? Number.parseInt(metadata.unixPermissions, 8)
        : (metadata.unixPermissions ?? 0);
    if ((permissions & 0o170000) === 0o120000) throw new Error(`Plugin symlink rejected: ${path}`);
    if ((permissions & 0o111) !== 0 || EXECUTABLE_EXTENSIONS.has(extension(path))) {
      throw new Error(`Plugin executable rejected: ${path}`);
    }
  }
}

async function readEntryWithinBudget(
  entry: JSZipObject,
  budget: ArchiveOutputBudget,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let entryBytes = 0;
  const stream = (entry as StreamableZipEntry).internalStream('uint8array');

  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const abort = (error: Error): void => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      try {
        stream.pause();
      } finally {
        reject(error);
      }
    };

    stream
      .on('data', (chunk) => {
        if (settled) return;
        entryBytes += chunk.byteLength;
        budget.outputBytes += chunk.byteLength;

        if (budget.outputBytes > MAX_UNCOMPRESSED_BYTES) {
          abort(new Error('Plugin ZIP exceeds the 50 MB uncompressed limit'));
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        if (settled) return;
        settled = true;
        chunks.length = 0;
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        try {
          const bytes = concatenateChunks(chunks, entryBytes);
          settled = true;
          chunks.length = 0;
          resolve(bytes);
        } catch (error) {
          settled = true;
          chunks.length = 0;
          reject(error);
        }
      })
      .resume();
  });
}

function concatenateChunks(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeArchiveEntries(entries: JSZipObject[]): NormalizedZipEntry[] {
  const paths = entries.map((entry) => validatePath(entry.name));
  const roots = new Set(paths.map((path) => path.split('/')[0]));
  const firstPath = paths[0];
  const root = roots.size === 1 && firstPath ? (firstPath.split('/')[0] ?? '') : '';
  const commonRoot = paths.includes(`${root}/${MANIFEST_PATH}`) ? `${root}/` : '';
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const sourcePath = paths[index];
    if (!sourcePath) throw new Error('Plugin archive entry path is missing');
    const path = validatePath(commonRoot ? sourcePath.slice(commonRoot.length) : sourcePath);
    if (seen.has(path)) throw new Error(`Plugin archive has duplicate path: ${path}`);
    seen.add(path);
    return { entry, path };
  });
}

async function resolveGitHubArchiveUrl(parsed: URL, fetcher: typeof fetch): Promise<string> {
  if (parsed.hostname === 'codeload.github.com') return parsed.href;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) throw new Error('GitHub plugin URL must identify a repository');
  const [owner, rawRepository] = segments;
  if (!owner || !rawRepository) throw new Error('GitHub plugin URL must identify a repository');
  const repository = rawRepository.replace(/\.git$/i, '');
  if (!/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repository)) {
    throw new Error('GitHub plugin repository path is invalid');
  }
  if (segments[2] === 'archive') return parsed.href;
  if (parsed.pathname.toLowerCase().endsWith('.zip')) return parsed.href;
  if (segments[2] === 'tree' && segments.length > 3) {
    const ref = encodePathSegments(segments.slice(3));
    return `https://codeload.github.com/${owner}/${repository}/zip/${ref}`;
  }
  if (segments.length !== 2) {
    throw new Error('Plugin URL must reference a GitHub repository or archive');
  }
  const metadataResponse = await fetcher(`https://api.github.com/repos/${owner}/${repository}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!metadataResponse.ok) {
    throw new Error(`GitHub repository lookup failed: HTTP ${metadataResponse.status}`);
  }
  const metadata = (await metadataResponse.json()) as { default_branch?: unknown };
  if (typeof metadata.default_branch !== 'string' || !metadata.default_branch) {
    throw new Error('GitHub repository has no default branch');
  }
  const branch = encodePathSegments(metadata.default_branch.split('/'));
  return `https://codeload.github.com/${owner}/${repository}/zip/refs/heads/${branch}`;
}

async function downloadArchive(url: string, fetcher: typeof fetch): Promise<ArrayBuffer> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`Plugin download failed: HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_COMPRESSED_BYTES) {
    throw new Error('Plugin ZIP exceeds the 10 MB compressed limit');
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error('Plugin ZIP exceeds the 10 MB compressed limit');
  }
  return bytes;
}

async function digestArchive(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function validateSkillReferences(
  skillPath: string,
  raw: string,
  declaredPaths: ReadonlySet<string>,
): void {
  for (const dependency of listSkillFileDependencies(raw)) {
    const resolved = resolveRelativeAssetPath(skillPath, dependency);
    if (!declaredPaths.has(resolved)) {
      throw new Error(`Plugin skill references an undeclared asset: ${dependency}`);
    }
  }
}

function resolveRelativeAssetPath(from: string, relative: string): string {
  const base = from.split('/').slice(0, -1);
  for (const segment of relative.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (base.length === 0)
        throw new Error(`Plugin asset reference escapes the package: ${relative}`);
      base.pop();
    } else {
      base.push(segment);
    }
  }
  return validatePath(base.join('/'));
}

function summarizeInstruction(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function assertGitHubPluginUrl(parsed: URL): void {
  if (
    parsed.protocol !== 'https:' ||
    !['github.com', 'codeload.github.com'].includes(parsed.hostname)
  ) {
    throw new Error('Plugin URL must be an HTTPS GitHub archive URL');
  }
  if (parsed.username || parsed.password || parsed.port) {
    throw new Error('Plugin URL must not include credentials or a custom port');
  }
}

function encodePathSegments(segments: string[]): string {
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('GitHub archive ref is invalid');
  }
  return segments.map(encodeURIComponent).join('/');
}

function replaceSkillName(raw: string, name: string): string {
  return raw.replace(/^(---\s*[\r\n]+[\s\S]*?^name:\s*).+$/m, `$1${name}`);
}

function validatePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  if (
    !normalized ||
    normalized.length > 1_024 ||
    containsControlCharacter(normalized) ||
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  ) {
    throw new Error(`Plugin path traversal rejected: ${value}`);
  }
  return normalized;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

function extension(path: string): string {
  return path.split('.').at(-1)?.toLowerCase() ?? '';
}

function mimeFor(path: string): string {
  switch (extension(path)) {
    case 'json':
      return 'application/json';
    case 'md':
      return 'text/markdown';
    case 'yaml':
    case 'yml':
      return 'application/yaml';
    default:
      return 'application/octet-stream';
  }
}
