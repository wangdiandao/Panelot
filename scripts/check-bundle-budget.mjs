import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const root = resolve(process.argv[2] ?? 'dist/chrome-mv3');
const limits = {
  totalJs: 4 * 1024 * 1024,
  eagerJs: 500 * 1024,
  // MV3 service workers forbid dynamic import(), so their runtime-only modules stay in the entry.
  // The caps include durable recovery, command transactions, bounded protocol admission,
  // deletion, snapshot admission, and immutable tool/MCP identity checks.
  backgroundEntry: 230 * 1024,
  backgroundStatic: 406 * 1024,
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

function staticImportSpecifiers(source) {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    'bundle.js',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  for (const statement of sourceFile.statements) {
    const moduleSpecifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      specifiers.push(moduleSpecifier.text);
    }
  }
  return specifiers;
}

function dynamicImportSpecifiers(source) {
  const specifiers = [];
  const sourceFile = ts.createSourceFile(
    'bundle.js',
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      specifiers.push(node.arguments[0]?.getText(sourceFile) ?? '(unknown)');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function resolveImport(rootDirectory, importer, specifier) {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  if (!cleanSpecifier.startsWith('.') && !cleanSpecifier.startsWith('/')) return undefined;
  const imported = cleanSpecifier.startsWith('/')
    ? resolve(rootDirectory, cleanSpecifier.slice(1))
    : resolve(dirname(importer), cleanSpecifier);
  const importedRelative = relative(rootDirectory, imported);
  if (
    importedRelative === '..' ||
    importedRelative.startsWith(`..${sep}`) ||
    isAbsolute(importedRelative)
  ) {
    throw new Error(`Static import escapes build root: ${specifier} from ${importer}`);
  }
  return imported;
}

export async function staticJavaScriptClosure(rootDirectory, entry) {
  const seen = new Set();
  const visit = async (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const specifier of staticImportSpecifiers(source)) {
      const imported = resolveImport(rootDirectory, file, specifier);
      if (imported) await visit(imported);
    }
  };
  await visit(entry);
  return seen;
}

const files = await filesBelow(root);
const javascript = files.filter((file) => file.endsWith('.js'));
const totalJs = (await Promise.all(javascript.map(async (file) => (await stat(file)).size))).reduce(
  (total, size) => total + size,
  0,
);
const background = (await stat(join(root, 'background.js'))).size;
const backgroundStaticFiles = await staticJavaScriptClosure(root, join(root, 'background.js'));
const backgroundStaticEntries = await Promise.all(
  [...backgroundStaticFiles].map(async (file) => ({ file, bytes: (await stat(file)).size })),
);
const backgroundStatic = backgroundStaticEntries.reduce((total, entry) => total + entry.bytes, 0);
const backgroundStaticSources = await Promise.all(
  [...backgroundStaticFiles].map(async (file) => ({
    file,
    source: await readFile(file, 'utf8'),
  })),
);
const backgroundWindowOnlyPreloadFiles = backgroundStaticSources.filter(
  ({ source }) => source.includes('vite:preloadError') && source.includes('window.dispatchEvent'),
);
const backgroundDynamicImportFiles = backgroundStaticSources
  .map(({ file, source }) => ({ file, specifiers: dynamicImportSpecifiers(source) }))
  .filter(({ specifiers }) => specifiers.length > 0);

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
  ['background.js entry', background, limits.backgroundEntry],
  ['background static graph', backgroundStatic, limits.backgroundStatic],
];
let failed = false;
for (const [label, actual, limit] of results) {
  const ok = actual <= limit;
  failed ||= !ok;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label}: ${(actual / 1024).toFixed(1)} KiB / ${(limit / 1024).toFixed(1)} KiB`,
  );
}
const backgroundModulePreloadSafe = backgroundWindowOnlyPreloadFiles.length === 0;
failed ||= !backgroundModulePreloadSafe;
console.log(
  `${backgroundModulePreloadSafe ? 'PASS' : 'FAIL'} background worker excludes window-only preload runtime`,
);
if (!backgroundModulePreloadSafe) {
  for (const entry of backgroundWindowOnlyPreloadFiles) {
    console.log(`  ${relative(root, entry.file)}`);
  }
}
const backgroundDynamicImportsSafe = backgroundDynamicImportFiles.length === 0;
failed ||= !backgroundDynamicImportsSafe;
console.log(
  `${backgroundDynamicImportsSafe ? 'PASS' : 'FAIL'} background worker excludes dynamic import()`,
);
if (!backgroundDynamicImportsSafe) {
  for (const entry of backgroundDynamicImportFiles) {
    console.log(`  ${relative(root, entry.file)}: ${entry.specifiers.join(', ')}`);
  }
}
if (backgroundStatic > limits.backgroundStatic) {
  console.log('INFO largest background static modules:');
  for (const entry of backgroundStaticEntries.sort((a, b) => b.bytes - a.bytes).slice(0, 8)) {
    console.log(`  ${(entry.bytes / 1024).toFixed(1)} KiB  ${relative(root, entry.file)}`);
  }
}
if (failed) process.exitCode = 1;
