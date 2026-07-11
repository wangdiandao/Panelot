import 'fake-indexeddb/auto';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelotDB } from '../../src/db/schema';
import { PluginManager, pluginDownloadPermissionOrigins } from '../../src/plugins/manager';
import {
  listEnabledPluginPresets,
  listEnabledPluginSiteInstructions,
} from '../../src/plugins/assets';

let db: PanelotDB;
let manager: PluginManager;
let n = 0;

beforeEach(() => {
  vi.restoreAllMocks();
  db = new PanelotDB(`plugin-test-${Date.now()}-${n++}`);
  manager = new PluginManager(db);
});

async function githubPluginZip(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    'example-main/.codex-plugin/plugin.json',
    JSON.stringify({
      id: 'github-plugin',
      name: 'GitHub Plugin',
      version: '1.0.0',
      assets: [{ path: 'skills/example/SKILL.md', kind: 'skill' }],
    }),
  );
  zip.file(
    'example-main/skills/example/SKILL.md',
    '---\nname: github-skill\ndescription: GitHub skill\n---\nFollow the instructions.',
  );
  return zip.generateAsync({ type: 'arraybuffer' });
}

async function pluginZip(extra?: (zip: JSZip) => void): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    '.codex-plugin/plugin.json',
    JSON.stringify({
      id: 'example-plugin',
      name: 'Example Plugin',
      version: '1.0.0',
      assets: [{ path: 'skills/example/SKILL.md', kind: 'skill' }],
    }),
  );
  zip.file(
    'skills/example/SKILL.md',
    `---
name: plugin-example
description: Example plugin skill
---
Follow the example instructions.`,
  );
  extra?.(zip);
  return zip.generateAsync({ type: 'arraybuffer' });
}

describe('PluginManager', () => {
  it('reports every origin needed to resolve and download a GitHub repository', () => {
    expect(pluginDownloadPermissionOrigins('https://github.com/example/example')).toEqual([
      'https://github.com',
      'https://api.github.com',
      'https://codeload.github.com',
    ]);
    expect(
      pluginDownloadPermissionOrigins(
        'https://codeload.github.com/example/example/zip/refs/heads/main',
      ),
    ).toEqual(['https://codeload.github.com']);
    expect(() => pluginDownloadPermissionOrigins('https://example.com/plugin.zip')).toThrow(
      /GitHub/i,
    );
  });

  it('installs a manifest and owned read-only assets atomically', async () => {
    const plugin = await manager.installZip(await pluginZip(), { kind: 'zip' });

    expect(plugin).toMatchObject({ id: 'example-plugin', enabled: true });
    expect(await db.pluginAssets.where('pluginId').equals(plugin.id).count()).toBe(1);
    expect(await db.skills.where('name').equals('plugin-example').first()).toMatchObject({
      source: 'plugin',
      sourceRef: plugin.id,
    });
  });

  it('rejects traversal names even when the ZIP library sanitizes them', async () => {
    await expect(
      manager.installZip(await pluginZip((zip) => zip.file('../outside.txt', 'escape')), {
        kind: 'zip',
      }),
    ).rejects.toThrow(/path|traversal/i);
    expect(await db.plugins.count()).toBe(0);
  });

  it('rejects executable payloads and oversized compressed input before install', async () => {
    await expect(
      manager.installZip(await pluginZip((zip) => zip.file('payload.exe', 'MZ')), { kind: 'zip' }),
    ).rejects.toThrow(/executable/i);
    await expect(
      manager.installZip(new ArrayBuffer(10 * 1024 * 1024 + 1), { kind: 'zip' }),
    ).rejects.toThrow(/10 MB/);
  });

  it('materializes declared preset and site-instruction assets only while enabled', async () => {
    const zip = new JSZip();
    zip.file(
      '.codex-plugin/plugin.json',
      JSON.stringify({
        id: 'profile-plugin',
        name: 'Profile Plugin',
        version: '1.0.0',
        assets: [
          { path: 'presets/research.json', kind: 'preset' },
          { path: 'sites/example.json', kind: 'site-instruction' },
        ],
      }),
    );
    zip.file(
      'presets/research.json',
      JSON.stringify({
        id: 'research',
        name: 'Research',
        base: { connectionId: 'connection-a', modelId: 'model-a' },
      }),
    );
    zip.file('sites/example.json', JSON.stringify({ 'example.com': 'Prefer concise tables.' }));

    await manager.installZip(await zip.generateAsync({ type: 'arraybuffer' }), { kind: 'zip' });
    await expect(listEnabledPluginPresets(db)).resolves.toEqual([
      expect.objectContaining({
        pluginId: 'profile-plugin',
        preset: expect.objectContaining({ id: 'profile-plugin:research', name: 'Research' }),
      }),
    ]);
    await expect(listEnabledPluginSiteInstructions(db)).resolves.toEqual([
      expect.objectContaining({
        pluginId: 'profile-plugin',
        pattern: 'example.com',
        prompt: 'Prefer concise tables.',
      }),
    ]);

    await manager.setEnabled('profile-plugin', false);
    await expect(listEnabledPluginPresets(db)).resolves.toEqual([]);
    await expect(listEnabledPluginSiteInstructions(db)).resolves.toEqual([]);
  });

  it('installs a prefixed archive from a plain GitHub repository URL', async () => {
    const archive = await githubPluginZip();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ default_branch: 'main' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(archive, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      manager.installFromUrl('https://github.com/example/example'),
    ).resolves.toMatchObject({
      id: 'github-plugin',
      source: { kind: 'github', ref: 'https://github.com/example/example' },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/example/example',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: expect.any(String) }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://codeload.github.com/example/example/zip/refs/heads/main',
    );
    expect(await db.skills.where('name').equals('github-skill').count()).toBe(1);
  });
});
