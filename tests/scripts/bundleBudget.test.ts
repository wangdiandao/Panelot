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
      `export const value = 1;\n${' '.repeat(100 * 1024)}`,
    );

    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('PASS production JS');
    expect(result.stdout).toContain('FAIL background static graph');
    expect(result.stdout).toContain('INFO background.js entry: 180.1 KiB');
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
    expect(result.stdout).toContain('PASS background static graph');
  });
});
