import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const evidence = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/u, "$1"));
const destination = path.resolve(".cache/image-engine-native-107-artifact");
const source = path.resolve(".cache/rust/debug");
const configuration = JSON.parse(await readFile("apps/client/src-tauri/tauri.conf.json", "utf8"));
const workerVersion = "media-diffusers-worker/1.107.0";
assert.ok((await readFile("apps/client/src-tauri/python/media_diffusers_worker.py", "utf8")).includes(workerVersion));
await mkdir(destination, { recursive: true });
for (const file of await readdir(source)) {
  if (file === "machdoch.exe" || file.endsWith(".dll")) {
    await cp(path.join(source, file), path.join(destination, file));
  }
}
for (const [from, to] of Object.entries(configuration.bundle.resources)) {
  if (!from.startsWith("python/")) continue;
  const target = path.resolve(destination, to);
  assert.ok(target.startsWith(destination + path.sep));
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.resolve(root, "apps/client/src-tauri", from), target, { recursive: true });
}
const hashes = {};
for (const file of ["machdoch.exe", "python/media_diffusers_worker.py", "python/media_open_models.py", "python/media_flux2.py", "python/image_sampling_profiles.json"]) {
  hashes[file] = createHash("sha256").update(await readFile(path.join(destination, file))).digest("hex");
}
const stdout = openSync(path.join(evidence, "native-107-stdout.log"), "w");
const stderr = openSync(path.join(evidence, "native-107-stderr.log"), "w");
const executable = path.join(destination, "machdoch.exe");
const child = spawn(executable, [], {
  cwd: root,
  detached: true,
  windowsHide: true,
  stdio: ["ignore", stdout, stderr],
  env: {
    ...process.env,
    APPDATA: path.resolve(".cache/image-engine-native/app-data"),
    MACHDOCH_USER_CONFIG_DIR: path.resolve(".cache/image-engine-native/user-config"),
    WEBVIEW2_USER_DATA_FOLDER: path.resolve(".cache/image-engine-native/webview-9228"),
  },
});
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
const record = { pid: child.pid, executable, endpoint: "http://127.0.0.1:9228", workerVersion, hashes, startedAt: new Date().toISOString(), expectedModelStore: "D:/Models/machdoch" };
await writeFile(path.join(evidence, "native-107-process.json"), JSON.stringify(record, null, 2));
child.unref();
closeSync(stdout);
closeSync(stderr);
console.log(JSON.stringify({ pid: child.pid, executable, workerVersion }));
