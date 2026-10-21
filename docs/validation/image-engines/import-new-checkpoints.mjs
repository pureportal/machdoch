import { readdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { prepareWindowsNativeToolchain } from "../../../apps/client/scripts/windows-native-toolchain.mjs";
import { prepareWindowsVulkanToolchain } from "../../../apps/client/scripts/windows-vulkan-toolchain.mjs";

const directory = "docs/validation/image-engines/research-2026-10-13";
const environment = prepareWindowsVulkanToolchain(prepareWindowsNativeToolchain({
  ...process.env,
  VULKAN_SDK: "C:/Development/machdoch/apps/client/src-tauri/target/refmod-vulkan-sdk/1.4.363.0",
  CARGO_TARGET_DIR: "C:/Development/machdoch/.cache/rust",
  MACHDOCH_IMAGE_MODEL_STORE: "D:/Models/machdoch",
}));
const results = [];
for (const file of (await readdir(directory)).filter(file => /^import-.*\.json$/u.test(file)).sort()) {
  const fixture = `${process.cwd()}/${directory}/${file}`;
  const started = Date.now();
  const result = spawnSync("cargo", ["test", "--lib", "media::model_import::tests::external_image_checkpoint_import", "--", "--ignored", "--exact", "--nocapture", "--test-threads=1"], {
    cwd: "apps/client/src-tauri",
    env: { ...environment, MACHDOCH_IMAGE_MODEL_IMPORT_FIXTURE: fixture },
    encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  await writeFile(`${directory}/${file.replace(".json", ".log")}`, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const record = { fixture: JSON.parse(await readFile(fixture, "utf8")), exitCode: result.status, seconds: (Date.now() - started) / 1000 };
  results.push(record);
  await writeFile(`${directory}/checkpoint-import-results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ file, exitCode: result.status, seconds: record.seconds }));
  if (result.status !== 0) throw new Error(`Import failed: ${file}`);
}
