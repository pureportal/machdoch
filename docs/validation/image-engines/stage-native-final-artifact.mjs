import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const source = path.resolve('.cache/rust/debug');
const destination = path.resolve('.cache/image-engine-native-final-artifact');
await mkdir(destination, { recursive: true });
const files = (await readdir(source)).filter(name => name === 'machdoch.exe' || name.endsWith('.dll'));
const config = JSON.parse(await readFile('apps/client/src-tauri/tauri.conf.json', 'utf8'));
const inventory = [];
for (const name of files) {
  await cp(path.join(source, name), path.join(destination, name));
  inventory.push({ path: name, sha256: createHash('sha256').update(await readFile(path.join(destination, name))).digest('hex') });
}
for (const [from, to] of Object.entries(config.bundle.resources)) {
  if (!from.startsWith('python/')) continue;
  const target = path.resolve(destination, to);
  if (!target.startsWith(destination + path.sep)) throw new Error('Resource escapes verification artifact');
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.resolve(root, 'apps/client/src-tauri', from), target, { recursive: true });
}
await writeFile('docs/validation/image-engines/research-2026-10-13/native-final-artifact.json', JSON.stringify({ destination, inventory }, null, 2));
console.log(JSON.stringify({ destination, files: files.length }));
