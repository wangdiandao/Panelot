/**
 * docs/development/permissions.md §4 anti-spoofing guard: the content script must never import
 * src/ui/ or any Radix-based component — approval UI renders only inside
 * extension pages. This walks the on-demand page executor's static import graph.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');

function collectImports(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  let source: string;
  try {
    source = readFileSync(file, 'utf-8');
  } catch {
    return seen;
  }
  const specs = [...source.matchAll(/from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1] ?? m[2]!)
    .filter((s) => s.startsWith('.') || s.startsWith('@/'));
  for (const spec of specs) {
    const base = spec.startsWith('@/')
      ? resolve(ROOT, spec.slice(2))
      : resolve(dirname(file), spec);
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, 'index.ts')]) {
      try {
        readFileSync(candidate, 'utf-8');
        collectImports(candidate, seen);
        break;
      } catch {
        /* try next */
      }
    }
  }
  return seen;
}

describe('content script isolation (docs/development/permissions.md §4)', () => {
  it('the page executor transitively imports no src/ui/ or radix modules', () => {
    const graph = collectImports(resolve(ROOT, 'entrypoints/page-executor.unlisted.ts'));
    const offenders = [...graph].filter((f) => /[\\/]src[\\/]ui[\\/]/.test(f));
    expect(offenders).toEqual([]);

    // Also assert no file in the graph imports radix-ui directly.
    for (const file of graph) {
      const source = readFileSync(file, 'utf-8');
      expect(source.includes("from 'radix-ui'"), `${file} imports radix-ui`).toBe(false);
      expect(source.includes('from "radix-ui"'), `${file} imports radix-ui`).toBe(false);
    }
  });
});
