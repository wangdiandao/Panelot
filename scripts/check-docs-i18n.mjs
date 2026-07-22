import { readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const repositoryRoot = process.cwd();
const docsRoot = path.join(repositoryRoot, 'docs');
const englishRoot = path.join(docsRoot, 'en');

async function collectMarkdownFiles(root, relativeDirectory = '', ignoredDirectories = new Set()) {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(relativePath)) {
        files.push(...(await collectMarkdownFiles(root, relativePath, ignoredDirectories)));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')) {
      files.push(relativePath);
    }
  }

  return files;
}

const canonicalPages = (
  await collectMarkdownFiles(docsRoot, '', new Set(['.vitepress', 'en']))
).sort();
const englishPages = (await collectMarkdownFiles(englishRoot)).sort();
const canonicalSet = new Set(canonicalPages);
const englishSet = new Set(englishPages);
const missingEnglishPages = canonicalPages.filter((page) => !englishSet.has(page));
const unexpectedEnglishPages = englishPages.filter((page) => !canonicalSet.has(page));

if (missingEnglishPages.length > 0 || unexpectedEnglishPages.length > 0) {
  if (missingEnglishPages.length > 0) {
    console.error('English documentation is missing these canonical Chinese pages:');
    for (const page of missingEnglishPages) console.error(`  - ${page}`);
  }
  if (unexpectedEnglishPages.length > 0) {
    console.error('English documentation has pages without a canonical Chinese counterpart:');
    for (const page of unexpectedEnglishPages) console.error(`  - ${page}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Documentation locale paths match (${canonicalPages.length} pages per locale).`);
}
