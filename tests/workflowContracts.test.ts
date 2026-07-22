import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));

function read(relativePath: string): string {
  return readFileSync(path.join(root, relativePath), 'utf8').replaceAll('\r\n', '\n');
}

const actionPins = new Map([
  ['actions/checkout@v7.0.0', '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0'],
  ['pnpm/action-setup@v6.0.9', '0ebf47130e4866e96fce0953f49152a61190b271'],
  ['actions/setup-node@v7.0.0', '820762786026740c76f36085b0efc47a31fe5020'],
  ['actions/upload-artifact@v7.0.1', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
  ['anchore/sbom-action@v0.24.0', 'e22c389904149dbc22b58101806040fa8d37a610'],
  ['actions/configure-pages@v6.0.0', '45bfe0192ca1faeb007ade9deae92b16b8254a0d'],
  ['actions/upload-pages-artifact@v5.0.0', 'fc324d3547104276b827a68afc52ff2a11cc49c9'],
  ['actions/deploy-pages@v5.0.0', 'cd2ce8fcbc39b97be8ca5fce6e763baed58fa128'],
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
      if (!match) throw new Error(`Invalid Action reference: ${line}`);
      const [, action, sha, tag] = match;
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

    const subjects = [...release.matchAll(/^\s+file: release\/panelot-(chrome|edge)\.zip$/gm)].map(
      (match) => match[1],
    );
    expect(subjects.sort()).toEqual(['chrome', 'edge']);
    expect(release).toContain('cp "dist/panelot-${VERSION}-chrome.zip" release/panelot-chrome.zip');
    expect(release).toContain('cp "dist/panelot-${VERSION}-edge.zip" release/panelot-edge.zip');
    expect(release).toContain('output-file: release/panelot-chrome.cdx.json');
    expect(release).toContain('output-file: release/panelot-edge.cdx.json');
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

  it('keeps the runtime and quality-gate contracts aligned', () => {
    const tsconfig = JSON.parse(read('tsconfig.json')) as {
      compilerOptions?: Record<string, unknown>;
      exclude?: string[];
    };
    expect(tsconfig.exclude).toContain('scratch');
    expect(tsconfig.compilerOptions).toMatchObject({
      noImplicitReturns: true,
      noFallthroughCasesInSwitch: true,
      allowUnreachableCode: false,
      allowUnusedLabels: false,
    });
    const packageJson = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    const supportedNodeRange = '^20.19.0 || >=22.12.0';
    expect(packageJson.engines?.node).toBe(supportedNodeRange);
    expect(read('README.md')).toContain(`Node.js \`${supportedNodeRange}\``);
    expect(read('README.zh-CN.md')).toContain(`Node.js **\`${supportedNodeRange}\`**`);
    expect(read('CONTRIBUTING.md')).toContain(`Node.js \`${supportedNodeRange}\``);
    const developmentGuide = read('docs/development/index.md');
    expect(developmentGuide.replaceAll('\\|', '|')).toContain(`\`${supportedNodeRange}\``);
    expect(developmentGuide).toContain('GitHub Actions 固定使用 `22.12.0`');

    const scripts = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(scripts.scripts.compile).toContain('tsconfig.entrypoints.json');
    expect(scripts.scripts.compile).toContain('tsconfig.e2e.json');
    expect(scripts.scripts.compile).toContain('tsconfig.preview.json');
    expect(scripts.scripts['docs:build']).toBe('pnpm docs:i18n:check && vitepress build docs');
    expect(scripts.scripts['format:check']).toContain('preview');
    expect(read('.github/workflows/ci.yml')).toContain('- run: pnpm compile');
    expect(read('.github/workflows/ci.yml')).toContain('- run: pnpm docs:build');
    expect(read('.github/workflows/pages.yml')).toContain('- public/icon/**');
    expect(read('.github/workflows/release.yml')).toContain('- run: pnpm compile');
    expect(read('.github/workflows/release.yml')).toContain('- run: pnpm docs:build');
  });

  it('keeps coding rules enforceable and exceptions narrowly scoped', () => {
    const config = read('eslint.config.mjs');
    for (const rule of [
      'no-console',
      'no-eval',
      'no-new-func',
      'react-hooks/refs',
      'react-hooks/set-state-in-effect',
      'react-hooks/static-components',
      '@typescript-eslint/no-explicit-any',
      '@typescript-eslint/no-non-null-assertion',
    ]) {
      expect(config).toContain(`'${rule}': 'error'`);
    }
    expect(config).toContain("reportUnusedDisableDirectives: 'error'");
    expect(config.match(/'react-hooks\/static-components': 'off'/g)).toHaveLength(1);
    expect(config.match(/'no-console': 'off'/g)).toHaveLength(1);
    expect(config).toContain("files: ['scripts/**/*.{js,mjs,cjs}']");
    expect(config.match(/'@typescript-eslint\/no-non-null-assertion': 'off'/g)).toHaveLength(1);
    expect(config).toContain("files: ['tests/**/*.{ts,tsx}']");
  });
});
