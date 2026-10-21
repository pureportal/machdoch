import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const series = process.argv[2];
assert.match(series, /^\d+$/u);
const workerVersion = `media-diffusers-worker/1.${series}.0`;
const root = process.cwd();
const evidence = path.resolve("docs/validation/image-engines/resume-2026-10-14");
const destination = path.resolve(`.cache/image-engine-native-${series}-artifact`);
const artifact = JSON.parse(await readFile(path.join(evidence, `native-${series}-artifact.json`), "utf8"));
assert.equal(artifact.workerVersion, workerVersion);
assert.equal(artifact.destination, destination);
for (const [name, expected] of Object.entries(artifact.hashes)) {
  const target = path.resolve(destination, name);
  assert.ok(target.startsWith(destination + path.sep));
  assert.equal(createHash("sha256").update(await readFile(target)).digest("hex"), expected, name);
}
try {
  await fetch("http://127.0.0.1:9228/json/version");
  assert.fail("The verification browser port is already in use");
} catch (error) {
  if (error.cause?.code !== "ECONNREFUSED") throw error;
}
const stdout = openSync(path.join(evidence, `native-${series}-stdout.log`), "w");
const stderr = openSync(path.join(evidence, `native-${series}-stderr.log`), "w");
const executable = path.join(destination, "machdoch.exe");
const child = spawn(executable, [], {
  cwd: root, detached: true, windowsHide: true, stdio: ["ignore", stdout, stderr],
  env: { ...process.env, APPDATA: path.resolve(".cache/image-engine-native/app-data"), MACHDOCH_USER_CONFIG_DIR: path.resolve(".cache/image-engine-native/user-config"), WEBVIEW2_USER_DATA_FOLDER: path.resolve(".cache/image-engine-native/webview-9228") },
});
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
await writeFile(path.join(evidence, `native-${series}-process.json`), JSON.stringify({pid: child.pid, executable, endpoint: "http://127.0.0.1:9228", workerVersion, hashes: artifact.hashes, startedAt: new Date().toISOString(), expectedModelStore: "D:/Models/machdoch"}, null, 2) + "\n");
child.unref();
closeSync(stdout);
closeSync(stderr);
console.log(JSON.stringify({pid: child.pid, executable, workerVersion}));
