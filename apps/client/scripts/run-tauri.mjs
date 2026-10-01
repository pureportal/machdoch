import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { prepareWindowsNativeToolchain } from "./windows-native-toolchain.mjs";
import { prepareWindowsVulkanToolchain } from "./windows-vulkan-toolchain.mjs";
import { stageWindowsVulkanRuntime } from "./prepare-vulkan-runtime.mjs";

const require = createRequire(import.meta.url);
const environment = { ...process.env };

if (["build", "dev"].includes(process.argv[2])) {
  prepareWindowsNativeToolchain(environment);
  prepareWindowsVulkanToolchain(environment);
  await stageWindowsVulkanRuntime();
}

const cli = require.resolve("@tauri-apps/cli/tauri.js");
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], {
  env: environment,
  cwd: realpathSync.native(process.cwd()),
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
