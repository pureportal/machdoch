import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { prepareWindowsNativeToolchain } from "../../../apps/client/scripts/windows-native-toolchain.mjs";
import { prepareWindowsVulkanToolchain } from "../../../apps/client/scripts/windows-vulkan-toolchain.mjs";

const directory = "docs/validation/image-engines/research-2026-10-13";
const configPath = path.resolve("docs/validation/image-engines/native-verification-config.json");
const source = JSON.parse(await readFile("apps/client/src-tauri/tauri.conf.json", "utf8"));
const config = JSON.parse(await readFile(configPath, "utf8"));
config.app = { windows: source.app.windows.map(window => ({ ...window, dataDirectory: "image-engine-cdp-final", additionalBrowserArgs: "--remote-debugging-port=9228 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection" })) };
await writeFile(configPath, JSON.stringify(config, null, 2));
const environment = prepareWindowsVulkanToolchain(prepareWindowsNativeToolchain({
  ...process.env,
  VULKAN_SDK: "C:/Development/machdoch/apps/client/src-tauri/target/refmod-vulkan-sdk/1.4.363.0",
  CARGO_TARGET_DIR: "C:/Development/machdoch/.cache/rust",
}));
const checks = [
  ["pnpm", ["--filter", "@machdoch/client", "run", "build:ui"], process.cwd(), "build-ui-final.log"],
  ["pnpm", ["--filter", "@machdoch/client", "exec", "tauri", "build", "--debug", "--no-bundle", "--config", configPath], process.cwd(), "native-app-build-final.log"],
];
for (const [command, args, cwd, log] of checks) {
  const result = spawnSync(command, args, { cwd, env: environment, shell: true, windowsHide: true, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  await writeFile(`${directory}/${log}`, `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  console.log(JSON.stringify({ log, exitCode: result.status }));
  if (result.status !== 0) throw new Error(`Failed: ${log}`);
}
