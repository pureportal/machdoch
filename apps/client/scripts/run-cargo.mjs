import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { prepareWindowsNativeToolchain } from "./windows-native-toolchain.mjs";
import { prepareWindowsVulkanToolchain } from "./windows-vulkan-toolchain.mjs";
import { stageWindowsVulkanRuntime } from "./prepare-vulkan-runtime.mjs";

try {
  const environment = prepareWindowsNativeToolchain({ ...process.env });
  prepareWindowsVulkanToolchain(environment);
  await stageWindowsVulkanRuntime();
  const child = spawn("cargo", process.argv.slice(2), {
    env: environment,
    cwd: realpathSync.native(process.cwd()),
    stdio: "inherit",
    windowsHide: true,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
