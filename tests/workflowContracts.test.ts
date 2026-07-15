import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8').replaceAll('\r\n', '\n');
}

function sourceFiles(relativeDirectory: string): string[] {
  const absoluteDirectory = path.join(root, relativeDirectory);
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [relativePath] : [];
  });
}

const actionPins = new Map([
  ['actions/checkout@v4.3.1', '34e114876b0b11c390a56381ad16ebd13914f8d5'],
  ['pnpm/action-setup@v4.4.0', 'fc06bc1257f339d1d5d8b3a19a8cae5388b55320'],
  ['actions/setup-node@v4.4.0', '49933ea5288caeca8642d1e84afbd3f7d6820020'],
  ['actions/upload-artifact@v4.6.2', 'ea165f8d65b6e75b540449e92b4886f43607fa02'],
  ['anchore/sbom-action@v0.24.0', 'e22c389904149dbc22b58101806040fa8d37a610'],
  ['actions/configure-pages@v5.0.0', '983d7736d9b0ae728b81ab479565c72886d7745b'],
  ['actions/upload-pages-artifact@v3.0.1', '56afc609e74202658d3ffba0e8f6dda462b719fa'],
  ['actions/deploy-pages@v4.0.5', 'd6db90164ac5ed86f2b6aed7e0febac5b3c0c03e'],
]);

describe('repository delivery contracts', () => {
  it('pins every public action to its reviewed commit and records the source tag', () => {
    const workflowFiles = readdirSync(path.join(root, '.github/workflows'));
    const useLines = workflowFiles.flatMap((file) =>
      read(path.join('.github/workflows', file))
        .split('\n')
        .filter((line) => line.includes('uses:')),
    );
    const observed = new Set<string>();

    for (const line of useLines) {
      const match = line.match(/uses:\s+([^@\s]+)@([0-9a-f]{40})\s+#\s+(v[0-9][^\s]*)\s*$/);
      expect(
        match,
        `Action reference is not an immutable SHA with a version comment: ${line}`,
      ).not.toBeNull();
      const [, action, sha, tag] = match!;
      const key = `${action}@${tag}`;
      expect(actionPins.get(key), `Unreviewed Action tag: ${key}`).toBe(sha);
      observed.add(key);
    }

    expect([...observed].sort()).toEqual([...actionPins.keys()].sort());
  });

  it('gates releases on main CI and emits per-package SBOM subjects and digests', () => {
    const release = read('.github/workflows/release.yml');

    expect(release).toContain('permissions: {}');
    expect(release).toContain('actions: read');
    expect(release).toContain('contents: write');
    expect(release).not.toContain('id-token:');
    expect(release).toContain('name: release');
    expect(release).toContain('fetch-depth: 0');
    expect(release).toContain("tags: ['v*']");
    expect(release).not.toContain('workflow_dispatch:');
    expect(release).toContain('release_commit="$(git rev-parse "${GITHUB_SHA}^{commit}")"');
    expect(release).toContain('git merge-base --is-ancestor "$release_commit" origin/main');
    expect(release).toContain(
      'actions/workflows/ci.yml/runs?branch=main&head_sha=${release_commit}',
    );
    expect(release).toContain('status=success');
    expect(release).toContain('.event == "push"');
    expect(release).toContain('.head_branch == "main"');
    expect(release).toContain('.conclusion == "success"');
    expect(release).toContain('pnpm test:coverage');

    const subjects = [
      ...release.matchAll(
        /^\s+file: release\/panelot-\$\{\{ env\.VERSION \}\}-(chrome|edge)\.zip$/gm,
      ),
    ].map((match) => match[1]);
    expect(subjects.sort()).toEqual(['chrome', 'edge']);
    expect(release).toContain('output-file: release/panelot-${{ env.VERSION }}-chrome.cdx.json');
    expect(release).toContain('output-file: release/panelot-${{ env.VERSION }}-edge.cdx.json');
    expect(release.match(/upload-artifact: false/g)).toHaveLength(2);
    expect(release.match(/upload-release-assets: false/g)).toHaveLength(2);
    expect(release).not.toMatch(/^\s+path:\s+\.\s*$/m);
    expect(release).toContain('sha256sum *.zip *.cdx.json > SHA256SUMS.txt');
  });

  it('derives package paths and runtime version assertions from package.json', () => {
    const packageJson = JSON.parse(read('package.json')) as { version: string };
    const ci = read('.github/workflows/ci.yml');
    const release = read('.github/workflows/release.yml');
    const extensionTest = read('e2e/extension.spec.ts');

    expect(ci).not.toContain(packageJson.version);
    expect(ci).toContain("require('./package.json').version");
    expect(ci).toContain('dist/panelot-${{ env.VERSION }}-chrome.zip');
    expect(ci).toContain('dist/panelot-${{ env.VERSION }}-edge.zip');
    expect(release).not.toContain(packageJson.version);
    expect(release).toContain("require('./package.json').version");
    expect(release).toContain('test "${GITHUB_REF_NAME}" = "v${VERSION}"');
    expect(extensionTest).not.toContain(`'${packageJson.version}'`);
    expect(extensionTest).toContain('expect(manifest.version).toBe(packageJson.version)');
  });

  it('keeps scratch out of TypeScript and points contributors at current docs', () => {
    const tsconfig = JSON.parse(read('tsconfig.json')) as { exclude?: string[] };
    expect(tsconfig.exclude).toContain('scratch');
    const packageJson = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    const packageMinimum = packageJson.engines?.node?.match(/^>=(\d+\.\d+)$/)?.[1];
    const readmeMinimum = read('README.zh-CN.md').match(
      /Node\.js\s+\*\*(\d+\.\d+)\s+或更高版本\*\*/,
    )?.[1];
    const contributingMinimum = read('CONTRIBUTING.md').match(
      /Node\.js\s+(\d+\.\d+)\s+or newer/,
    )?.[1];
    const developmentGuide = read('docs/development.md');
    const developmentMinimum = developmentGuide.match(
      /^\|\s*Node\.js\s*\|\s*`>=(\d+\.\d+)`\s*\|/m,
    )?.[1];
    expect(packageMinimum).toBeDefined();
    expect([readmeMinimum, contributingMinimum, developmentMinimum]).toEqual([
      packageMinimum,
      packageMinimum,
      packageMinimum,
    ]);
    expect(developmentGuide).toContain('GitHub Actions 固定使用 `22.12.0`');

    const files = [...sourceFiles('src'), ...sourceFiles('tests')];
    if (existsSync(path.join(root, 'AGENTS.md'))) files.push('AGENTS.md');
    const missingDesignReference = new RegExp(`DES${'IGN'}(?:\\.md|\\s*§)`);
    const offenders = files.filter((file) => missingDesignReference.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
