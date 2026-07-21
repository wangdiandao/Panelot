import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-bundle-budget.mjs', import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'panelot-budget-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'chunks'));
  return root;
}

describe('bundle budget static graph', () => {
  it('counts recursively imported chunks instead of only the background entry', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'background.js'),
      `import './chunks/a.js?cache=1#fragment';\nconst example = "import './missing.js'";\n${' '.repeat(180 * 1024)}`,
    );
    await writeFile(
      join(root, 'chunks/a.js'),
      `export{value}from'./b.js';\n${' '.repeat(100 * 1024)}`,
    );
    await writeFile(
      join(root, 'chunks/b.js'),
      `export const value = 1;\n${' '.repeat(128 * 1024)}`,
    );

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PASS production JS');
    expect(result.stdout).toContain('PASS background.js entry');
    expect(result.stdout).toContain('FAIL background static graph');
    expect(result.stdout).toContain('INFO largest background static modules:');
    expect(result.stdout).toMatch(/chunks[\\/]b\.js/);
  });

  it('keeps a separate cap on the service worker entry', async () => {
    const root = await fixture();
    await writeFile(join(root, 'background.js'), `${' '.repeat(231 * 1024)}`);

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL background.js entry');
    expect(result.stdout).toContain('PASS background static graph');
  });

  it('allows a bounded static graph larger than the entry budget', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'background.js'),
      `import './chunks/a.js';\n${' '.repeat(189 * 1024)}`,
    );
    await writeFile(join(root, 'chunks/a.js'), `${' '.repeat(162 * 1024)}`);

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS background.js entry');
    expect(result.stdout).toContain('PASS background static graph');
  });

  it('rejects a window-only Vite preload runtime in the service worker static graph', async () => {
    const root = await fixture();
    await writeFile(join(root, 'background.js'), `import './chunks/preload.js';`);
    await writeFile(
      join(root, 'chunks/preload.js'),
      `window.dispatchEvent(new Event('vite:preloadError'));`,
    );

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL background worker excludes window-only preload runtime');
    expect(result.stdout).toMatch(/chunks[\\/]preload\.js/);
  });

  it('allows a worker-safe Vite preload error dispatcher', async () => {
    const root = await fixture();
    await writeFile(join(root, 'background.js'), `import './chunks/preload.js';`);
    await writeFile(
      join(root, 'chunks/preload.js'),
      `globalThis.dispatchEvent(new Event('vite:preloadError'));`,
    );

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS background worker excludes window-only preload runtime');
  });

  it('rejects dynamic imports in the service worker static graph', async () => {
    const root = await fixture();
    await writeFile(join(root, 'background.js'), `void import('./chunks/lazy.js');`);
    await writeFile(join(root, 'chunks/lazy.js'), `export const value = 1;`);

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL background worker excludes dynamic import()');
    expect(result.stdout).toContain(`'./chunks/lazy.js'`);
  });

  it('rejects a static import that escapes the build root', async () => {
    const root = await fixture();
    await writeFile(join(root, 'background.js'), `import '../outside.js';`);

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Static import escapes build root');
  });

  it('allows in-root chunk names that begin with two dots', async () => {
    const root = await fixture();
    await writeFile(join(root, 'background.js'), `export * from './..shared.js';`);
    await writeFile(join(root, '..shared.js'), `export const value = 1;`);

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS background.js entry');
    expect(result.stdout).toContain('PASS background static graph');
  });
});
