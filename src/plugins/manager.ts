import JSZip, { type JSZipObject } from 'jszip';
import { z } from 'zod';
import type { PanelotDB } from '../db/schema';
import type { PluginAssetRecord, PluginRecord, SkillRecord } from '../db/types';
import { parseSkill } from '../skills/parse';
import { parsePluginPresetAsset, parsePluginSiteInstructionAsset } from './assets';

const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 1_000;
const MANIFEST_PATH = '.codex-plugin/plugin.json';
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

const PluginManifest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  assets: z
    .array(
      z.object({
        path: z.string().min(1),
        kind: z.enum(['skill', 'preset', 'site-instruction', 'other']),
      }),
    )
    .max(MAX_FILES),
});

type PluginManifest = z.infer<typeof PluginManifest>;

export function pluginDownloadPermissionOrigins(value: string | URL): string[] {
  const parsed = typeof value === 'string' ? new URL(value) : value;
  assertGitHubPluginUrl(parsed);
  if (parsed.hostname === 'github.com') {
    return [parsed.origin, 'https://api.github.com', 'https://codeload.github.com'];
  }
  return [parsed.origin];
}

interface ZipEntryMetadata {
  unsafeOriginalName?: string;
  unixPermissions?: number | string | null;
  _data?: { uncompressedSize?: number };
}

interface NormalizedZipEntry {
  entry: JSZipObject;
  path: string;
}

export class PluginManager {
  constructor(private db: PanelotDB) {}

  async installZip(input: ArrayBuffer, source: PluginRecord['source']): Promise<PluginRecord> {
    if (input.byteLength > MAX_COMPRESSED_BYTES) {
      throw new Error('Plugin ZIP exceeds the 10 MB compressed limit');
    }
    const zip = await JSZip.loadAsync(input);
    const archiveFiles = Object.values(zip.files).filter((entry) => !entry.dir);
    if (archiveFiles.length > MAX_FILES)
      throw new Error(`Plugin ZIP exceeds the ${MAX_FILES} file limit`);
    this.validateEntries(archiveFiles);
    const files = normalizeArchiveEntries(archiveFiles);

    const fileBytes = new Map<string, Uint8Array>();
    let uncompressedBytes = 0;
    for (const { entry, path } of files) {
      const bytes = await entry.async('uint8array');
      uncompressedBytes += bytes.byteLength;
      if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('Plugin ZIP exceeds the 50 MB uncompressed limit');
      }
      fileBytes.set(path, bytes);
    }

    const manifestEntry = files.find((file) => file.path === MANIFEST_PATH)?.entry;
    if (!manifestEntry) throw new Error(`Plugin manifest not found: ${MANIFEST_PATH}`);
    const manifest = PluginManifest.parse(JSON.parse(await manifestEntry.async('text')));
    const declaredPaths = new Set(manifest.assets.map((asset) => validatePath(asset.path)));
    if (declaredPaths.size !== manifest.assets.length)
      throw new Error('Plugin manifest has duplicate assets');
    for (const file of files) {
      if (file.path !== MANIFEST_PATH && !declaredPaths.has(file.path)) {
        throw new Error(`Plugin file is not declared in the manifest: ${file.path}`);
      }
    }

    const assets: PluginAssetRecord[] = [];
    const skills: SkillRecord[] = [];
    const now = Date.now();
    for (const declared of manifest.assets) {
      const path = validatePath(declared.path);
      const bytes = fileBytes.get(path);
      if (!bytes) throw new Error(`Plugin asset not found: ${path}`);
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      assets.push({
        id: `${manifest.id}\u0000${path}`,
        pluginId: manifest.id,
        path,
        kind: declared.kind,
        mime: mimeFor(path),
        bytes: new Blob([buffer], { type: mimeFor(path) }),
        readOnly: true,
        createdAt: now,
      });
      if (declared.kind === 'skill') {
        const raw = new TextDecoder().decode(bytes);
        const parsed = parseSkill(raw);
        skills.push({
          id: crypto.randomUUID(),
          name: parsed.frontmatter.name,
          raw,
          frontmatter: parsed.frontmatter,
          body: parsed.body,
          enabled: true,
          source: 'plugin',
          sourceRef: manifest.id,
          createdAt: now,
          updatedAt: now,
        });
      } else if (declared.kind === 'preset') {
        parsePluginPresetAsset(bytes, manifest.id, `${manifest.id}\u0000${path}`, path);
      } else if (declared.kind === 'site-instruction') {
        parsePluginSiteInstructionAsset(bytes, manifest.id, `${manifest.id}\u0000${path}`, path);
      }
    }

    const plugin: PluginRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      source,
      enabled: true,
      manifest,
      assetIds: assets.map((asset) => asset.id),
      installedAt: now,
      updatedAt: now,
    };
    await this.db.transaction(
      'rw',
      [this.db.plugins, this.db.pluginAssets, this.db.skills],
      async () => {
        await this.validateConflicts(manifest, skills);
        await this.db.plugins.add(plugin);
        await this.db.pluginAssets.bulkAdd(assets);
        await this.db.skills.bulkAdd(skills);
      },
    );
    return plugin;
  }

  async installFromUrl(url: string): Promise<PluginRecord> {
    const parsed = new URL(url);
    assertGitHubPluginUrl(parsed);
    const archiveUrl = await resolveGitHubArchiveUrl(parsed);
    const response = await fetch(archiveUrl);
    if (!response.ok) throw new Error(`Plugin download failed: HTTP ${response.status}`);
    return this.installZip(await response.arrayBuffer(), { kind: 'github', ref: url });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.db.transaction('rw', [this.db.plugins, this.db.skills], async () => {
      const plugin = await this.db.plugins.get(id);
      if (!plugin) throw new Error(`Plugin not found: ${id}`);
      await this.db.plugins.update(id, { enabled, updatedAt: Date.now() });
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
    const now = Date.now();
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

  private validateEntries(entries: JSZipObject[]): void {
    let declaredSize = 0;
    for (const entry of entries) {
      const metadata = entry as JSZipObject & ZipEntryMetadata;
      const original = metadata.unsafeOriginalName ?? entry.name;
      const path = validatePath(original);
      const permissions =
        typeof metadata.unixPermissions === 'string'
          ? Number.parseInt(metadata.unixPermissions, 8)
          : (metadata.unixPermissions ?? 0);
      if ((permissions & 0o170000) === 0o120000)
        throw new Error(`Plugin symlink rejected: ${path}`);
      if ((permissions & 0o111) !== 0 || EXECUTABLE_EXTENSIONS.has(extension(path))) {
        throw new Error(`Plugin executable rejected: ${path}`);
      }
      declaredSize += metadata._data?.uncompressedSize ?? 0;
      if (declaredSize > MAX_UNCOMPRESSED_BYTES) {
        throw new Error('Plugin ZIP exceeds the 50 MB uncompressed limit');
      }
    }
  }

  private async validateConflicts(manifest: PluginManifest, skills: SkillRecord[]): Promise<void> {
    if (await this.db.plugins.get(manifest.id))
      throw new Error(`Plugin id conflict: ${manifest.id}`);
    if (await this.db.plugins.where('name').equals(manifest.name).first()) {
      throw new Error(`Plugin name conflict: ${manifest.name}`);
    }
    const names = new Set<string>();
    for (const skill of skills) {
      if (
        names.has(skill.name) ||
        (await this.db.skills.where('name').equals(skill.name).first())
      ) {
        throw new Error(`Plugin skill name conflict: ${skill.name}`);
      }
      names.add(skill.name);
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

function assertGitHubPluginUrl(parsed: URL): void {
  if (
    parsed.protocol !== 'https:' ||
    !['github.com', 'codeload.github.com'].includes(parsed.hostname)
  ) {
    throw new Error('Plugin URL must be an HTTPS GitHub archive URL');
  }
}

function normalizeArchiveEntries(entries: JSZipObject[]): NormalizedZipEntry[] {
  const paths = entries.map((entry) => validatePath(entry.name));
  const roots = new Set(paths.map((path) => path.split('/')[0]));
  const root = roots.size === 1 ? paths[0]!.split('/')[0]! : '';
  const commonRoot = paths.includes(`${root}/${MANIFEST_PATH}`) ? `${root}/` : '';
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const path = validatePath(commonRoot ? paths[index]!.slice(commonRoot.length) : paths[index]!);
    if (seen.has(path)) throw new Error(`Plugin archive has duplicate path: ${path}`);
    seen.add(path);
    return { entry, path };
  });
}

async function resolveGitHubArchiveUrl(parsed: URL): Promise<string> {
  if (parsed.hostname === 'codeload.github.com') return parsed.href;
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments.length < 2) throw new Error('GitHub plugin URL must identify a repository');
  const owner = segments[0]!;
  const repository = segments[1]!.replace(/\.git$/i, '');
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
  const metadataResponse = await fetch(`https://api.github.com/repos/${owner}/${repository}`, {
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
    normalized.includes('\0') ||
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..' || segment === '')
  ) {
    throw new Error(`Plugin path traversal rejected: ${value}`);
  }
  return normalized;
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
