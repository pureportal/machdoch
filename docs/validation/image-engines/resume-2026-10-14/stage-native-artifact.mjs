import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const series = process.argv[2];
assert.match(series, /^\d+$/u);
const workerVersion = `media-diffusers-worker/1.${series}.0`;
const evidence = path.resolve("docs/validation/image-engines/resume-2026-10-14");
const destination = path.resolve(`.cache/image-engine-native-${series}-artifact`);
const built = path.resolve(".cache/rust/debug");
const build = JSON.parse(await readFile(path.join(evidence, `native-app-build-${series}-result.json`), "utf8"));
assert.equal(build.exitCode, 0);
assert.ok((await readFile("apps/client/src-tauri/python/media_diffusers_worker.py", "utf8")).includes(workerVersion));
await mkdir(destination, {recursive: true});
for (const name of await readdir(built)) {
  if (name === "machdoch.exe" || name.endsWith(".dll")) await cp(path.join(built, name), path.join(destination, name));
}
const configuration = JSON.parse(await readFile("apps/client/src-tauri/tauri.conf.json", "utf8"));
for (const [source, target] of Object.entries(configuration.bundle.resources)) {
  if (!source.startsWith("python/")) continue;
  const output = path.resolve(destination, target);
  assert.ok(output.startsWith(destination + path.sep));
  await mkdir(path.dirname(output), {recursive: true});
  await cp(path.resolve("apps/client/src-tauri", source), output, {recursive: true});
}
const hashes = {};
for (const name of await readdir(destination, {recursive: true})) {
  if (name === "machdoch.exe" || name.endsWith(".dll") || name.endsWith(".py") || name.endsWith(".json")) {
    hashes[name.replaceAll(path.sep, "/")] = createHash("sha256").update(await readFile(path.join(destination, name))).digest("hex");
  }
}
await writeFile(path.join(evidence, `native-${series}-artifact.json`), JSON.stringify({workerVersion, destination, stagedAt: new Date().toISOString(), hashes}, null, 2) + "\n");
console.log(JSON.stringify({staged: true, launched: false, workerVersion, files: Object.keys(hashes).length}));
