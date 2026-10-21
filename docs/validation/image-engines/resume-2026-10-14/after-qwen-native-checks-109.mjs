import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve("docs/validation/image-engines/resume-2026-10-14");
const pause = () => new Promise((resolve) => setTimeout(resolve, 5000));
async function jsonIfPresent(name) {
  try { return JSON.parse(await readFile(path.join(evidence, name), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function run(command, arguments_, name) {
  const log = openSync(path.join(evidence, name + ".log"), "w");
  const started = Date.now();
  try {
    const child = spawn(command, arguments_, {windowsHide: true, stdio: ["ignore", log, log]});
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    const record = {exitCode, seconds: (Date.now() - started) / 1000};
    await writeFile(path.join(evidence, name + "-result.json"), JSON.stringify(record, null, 2) + "\n");
    assert.equal(exitCode, 0, name);
    return record;
  } finally { closeSync(log); }
}

let lastUpdate = 0;
for (;;) {
  const checkpoint = await jsonIfPresent("qwen-baseline-checkpoint.json");
  const build = await jsonIfPresent("native-app-build-109-result.json");
  if (build) assert.equal(build.exitCode, 0, "The new native build failed");
  if (checkpoint && build) {
    assert.equal(checkpoint.stoppedOwnedWorker, true);
    assert.equal(checkpoint.pid, 20224);
    break;
  }
  if (Date.now() - lastUpdate > 50_000) {
    console.log(JSON.stringify({waitingForQwenCheckpoint: !checkpoint, waitingForNativeBuild: !build}));
    lastUpdate = Date.now();
  }
  await pause();
}
await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "if (Get-CimInstance Win32_Process -Filter 'ProcessId=20224') { throw 'The reference GPU worker has not exited.' }"], "native-109-previous-worker-exit");
await run(process.execPath, [path.join(evidence, "stage-and-launch-native-109.mjs")], "native-109-launch");
for (;;) {
  try { if ((await fetch("http://127.0.0.1:9228/json/version")).ok) break; }
  catch (error) { if (error.cause?.code !== "ECONNREFUSED") throw error; }
  await pause();
}
await run(process.execPath, [path.join(evidence, "refresh-native-runtime.mjs"), "media-diffusers-worker/1.109.0", path.join(evidence, "native-runtime-109.json")], "native-runtime-109");
for (const mode of ["basic", "advanced"]) {
  await run(process.execPath, ["apps/client/scripts/verify-native-media-image-generation.mjs", "http://127.0.0.1:9228", path.join(evidence, "native-generation-109-fixture.json"), path.join(evidence, "native-" + mode + "-109"), mode], "native-" + mode + "-109");
}
const records = await Promise.all(["basic", "advanced"].map(async mode => JSON.parse(await readFile(path.join(evidence, "native-" + mode + "-109/run-detail.json"), "utf8"))));
const digests = records.flatMap(record => record.assets.map(asset => asset.digest));
assert.equal(digests.length, 2);
assert.ok(digests.every(digest => digest === "701ee16d959b1cf14aae0e61ad14d9f6a22907dcf85d23d932ec8940f8b65977"));
const result = {passed: true, workerVersion: "media-diffusers-worker/1.109.0", basicAndAdvanced: true, imageDigests: digests, technicalChecksOnly: true};
await writeFile(path.join(evidence, "native-generation-109-comparison.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
