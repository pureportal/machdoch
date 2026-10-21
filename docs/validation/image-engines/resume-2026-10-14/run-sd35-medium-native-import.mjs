import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readFile, statfs, writeFile } from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve("docs/validation/image-engines/resume-2026-10-14");
const acquisition = JSON.parse(await readFile(path.join(evidence, "sd35-medium-acquisition-result.json"), "utf8"));
assert.equal(acquisition.exitCode, 0);
const free = await statfs("D:/Models/machdoch");
assert.ok(free.bavail * free.bsize > 18 * 1024 ** 3, "Insufficient free space for the verified package import");
const log = openSync(path.join(evidence, "sd35-medium-native-import.log"), "w");
const started = Date.now();
const request = path.join(evidence, "sd35-medium-import.json");
const child = spawn(path.resolve(".cache/rust/debug/deps/machdoch_lib-12c220b8ebb461f1.exe"), ["media::model_package_import::tests::external_image_model_package_import", "--exact", "--ignored", "--nocapture"], {
  windowsHide: true,
  stdio: ["ignore", log, log],
  env: { ...process.env, PATH: path.resolve(".cache/rust/debug") + path.delimiter + process.env.PATH, MACHDOCH_IMAGE_MODEL_STORE: "D:/Models/machdoch", MACHDOCH_IMAGE_MODEL_IMPORT_REQUEST: request },
});
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
await writeFile(path.join(evidence, "sd35-medium-native-import-process.json"), JSON.stringify({pid: child.pid, request, startedAt: new Date().toISOString()}, null, 2));
const exitCode = await new Promise((resolve) => child.once("exit", resolve));
closeSync(log);
const result = {exitCode, seconds: (Date.now() - started) / 1000};
await writeFile(path.join(evidence, "sd35-medium-native-import-result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
process.exitCode = exitCode ?? 1;
