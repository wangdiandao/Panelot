import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist/chrome-mv3');
const limits = {
  totalJs: 4 * 1024 * 1024,
  eagerJs: 500 * 1024,
  background: 350 * 1024,
};

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    }),
  );
  return nested.flat();
}

const files = await filesBelow(root);
const javascript = files.filter((file) => file.endsWith('.js'));
const totalJs = (await Promise.all(javascript.map(async (file) => (await stat(file)).size))).reduce(
  (total, size) => total + size,
  0,
);
const background = (await stat(join(root, 'background.js'))).size;

const eagerByPage = [];
for (const htmlPath of files.filter(
  (file) => file.endsWith('.html') && !file.endsWith('mcp-worker.html'),
)) {
  const html = await readFile(htmlPath, 'utf8');
  const referenced = new Set(
    [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((match) => match[1].replace(/^\//, '')),
  );
  eagerByPage.push({ page: htmlPath.slice(root.length + 1), referenced });
}
const sharedPaths =
  eagerByPage.length === 0
    ? new Set()
    : new Set(
        [...eagerByPage[0].referenced].filter((path) =>
          eagerByPage.every((page) => page.referenced.has(path)),
        ),
      );
const eagerJs = (
  await Promise.all([...sharedPaths].map(async (path) => (await stat(join(root, path))).size))
).reduce((total, bytes) => total + bytes, 0);

const results = [
  ['production JS', totalJs, limits.totalJs],
  ['shared eager JS', eagerJs, limits.eagerJs],
  ['background.js', background, limits.background],
];
let failed = false;
for (const [label, actual, limit] of results) {
  const ok = actual <= limit;
  failed ||= !ok;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}: ${(actual / 1024).toFixed(1)} KiB / ${(limit / 1024).toFixed(1)} KiB`,
  );
}
if (failed) process.exitCode = 1;
