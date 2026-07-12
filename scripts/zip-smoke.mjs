import { readFile, readdir } from 'node:fs/promises';
import JSZip from 'jszip';

const requested = process.argv.slice(2);
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const paths =
  requested.length > 0
    ? requested
    : (await readdir('dist'))
        .filter((name) =>
          new RegExp(`^panelot-${packageJson.version}-(chrome|edge)\\.zip$`).test(name),
        )
        .map((name) => `dist/${name}`);
if (paths.length === 0) throw new Error('No extension ZIPs found; run pnpm zip and pnpm zip:edge');

for (const path of paths) {
  const zip = await JSZip.loadAsync(await readFile(path));
  const names = Object.keys(zip.files);
  for (const required of ['manifest.json', 'background.js']) {
    if (!zip.file(required)) throw new Error(`${path}: missing ${required}`);
  }
  const manifest = JSON.parse(await zip.file('manifest.json').async('text'));
  if (manifest.version !== packageJson.version) {
    throw new Error(`${path}: expected version ${packageJson.version}`);
  }
  if (manifest.host_permissions?.length)
    throw new Error(`${path}: permanent host permissions are not allowed`);
  if (!manifest.optional_host_permissions?.includes('<all_urls>')) {
    throw new Error(`${path}: optional host permission is missing`);
  }
  if (names.some((name) => name.endsWith('.map')))
    throw new Error(`${path}: source maps must not ship`);
  console.log(`PASS ${path}: ${names.length} files`);
}
