import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const evidence = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/u, "$1"));
const destination = path.resolve(".cache/image-engine-native-109-artifact");
const workerVersion = "media-diffusers-worker/1.109.0";
const artifact = JSON.parse(await readFile(path.join(evidence, "native-109-artifact.json"), "utf8"));
assert.equal(artifact.workerVersion, workerVersion);
assert.equal(artifact.destination, destination);
const hashes = {};
for (const [file, expected] of Object.entries(artifact.hashes)) {
  const target = path.resolve(destination, file);
  assert.ok(target.startsWith(destination + path.sep));
  hashes[file] = createHash("sha256").update(await readFile(target)).digest("hex");
  assert.equal(hashes[file], expected, file);
}
const stdout = openSync(path.join(evidence, "native-109-stdout.log"), "w");
const stderr = openSync(path.join(evidence, "native-109-stderr.log"), "w");
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
await writeFile(path.join(evidence, "native-109-process.json"), JSON.stringify(record, null, 2));
child.unref();
closeSync(stdout);
closeSync(stderr);
console.log(JSON.stringify({ pid: child.pid, executable, workerVersion }));
