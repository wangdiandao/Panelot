import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';

const paths = process.argv.slice(2);
if (paths.length === 0) throw new Error('Pass at least one extension ZIP path');

for (const path of paths) {
  const zip = await JSZip.loadAsync(await readFile(path));
  const names = Object.keys(zip.files);
  for (const required of ['manifest.json', 'background.js']) {
    if (!zip.file(required)) throw new Error(`${path}: missing ${required}`);
  }
  const manifest = JSON.parse(await zip.file('manifest.json').async('text'));
  if (manifest.version !== '0.2.0') throw new Error(`${path}: expected version 0.2.0`);
  if (manifest.host_permissions?.length)
    throw new Error(`${path}: permanent host permissions are not allowed`);
  if (!manifest.optional_host_permissions?.includes('<all_urls>')) {
    throw new Error(`${path}: optional host permission is missing`);
  }
  if (names.some((name) => name.endsWith('.map')))
    throw new Error(`${path}: source maps must not ship`);
  console.log(`PASS ${path}: ${names.length} files`);
}
