import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

const evidence = path.resolve("docs/validation/image-engines/resume-2026-10-14");
const log = openSync(path.join(evidence, "concept-addon-native-import.log"), "w");
const started = Date.now();
const child = spawn(path.resolve(".cache/rust/debug/deps/machdoch_lib-12c220b8ebb461f1.exe"), [
  "media::model_addon::tests::imports_external_addons_and_provisions_model_dependencies",
  "--exact", "--ignored", "--nocapture",
], {
  windowsHide: true,
  stdio: ["ignore", log, log],
  env: {
    ...process.env,
    PATH: path.resolve(".cache/rust/debug") + path.delimiter + process.env.PATH,
    MACHDOCH_MEDIA_ADDON_FIXTURE: path.join(evidence, "concept-addon-import-fixture.json"),
  },
});
await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
await writeFile(path.join(evidence, "concept-addon-native-import-process.json"), JSON.stringify({pid: child.pid, startedAt: new Date().toISOString()}, null, 2));
const exitCode = await new Promise((resolve) => child.once("exit", resolve));
closeSync(log);
const result = {exitCode, seconds: (Date.now() - started) / 1000};
await writeFile(path.join(evidence, "concept-addon-native-import-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exitCode = exitCode ?? 1;
