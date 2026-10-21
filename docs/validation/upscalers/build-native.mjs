import { readFile, writeFile, mkdir, cp, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { prepareWindowsNativeToolchain } from "../../../apps/client/scripts/windows-native-toolchain.mjs";
import { prepareWindowsVulkanToolchain } from "../../../apps/client/scripts/windows-vulkan-toolchain.mjs";

const output = path.resolve("docs/validation/upscalers");
const source = JSON.parse(
  await readFile("apps/client/src-tauri/tauri.conf.json", "utf8"),
);
const configuration = {
  identifier: "com.machdoch.upscale-verification",
  build: { beforeBuildCommand: null, devUrl: null },
  app: {
    windows: source.app.windows.map((window) => ({
      ...window,
      visible: false,
      skipTaskbar: true,
      dataDirectory: "upscale-verification",
      additionalBrowserArgs: "--remote-debugging-port=9237",
    })),
  },
};
await mkdir(output, { recursive: true });
const configPath = path.join(output, "native-config.json");
await writeFile(configPath, JSON.stringify(configuration, null, 2));
const environment = prepareWindowsVulkanToolchain(
  prepareWindowsNativeToolchain({
    ...process.env,
    VULKAN_SDK: path.resolve(
      "apps/client/src-tauri/target/refmod-vulkan-sdk/1.4.363.0",
    ),
    CARGO_TARGET_DIR: path.resolve(".cache/rust"),
  }),
);
for (const [command, args, cwd, log] of [
  ["pnpm", ["build:ui"], process.cwd(), "build-ui.log"],
  [
    "cargo",
    ["test", "--lib", "media::", "--", "--test-threads=4"],
    path.resolve("apps/client/src-tauri"),
    "rust-tests.log",
  ],
  [
    "pnpm",
    [
      "--filter",
      "@machdoch/client",
      "exec",
      "tauri",
      "build",
      "--debug",
      "--no-bundle",
      "--config",
      configPath,
    ],
    process.cwd(),
    "build-native.log",
  ],
]) {
  if (process.argv.includes("--refresh") && command === "cargo") continue;
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    shell: true,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  await writeFile(
    path.join(output, log),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  console.log(JSON.stringify({ log, status: result.status }));
  if (result.status !== 0) throw new Error(`Failed ${log}`);
}
const destination = path.resolve(".cache/upscale-native");
await mkdir(destination, { recursive: true });
for (const name of await readdir(".cache/rust/debug")) {
  if (name === "machdoch.exe" || name.endsWith(".dll"))
    await cp(
      path.resolve(".cache/rust/debug", name),
      path.join(destination, name),
    );
}
for (const [from, to] of Object.entries(source.bundle.resources)) {
  if (!from.startsWith("python/")) continue;
  const target = path.resolve(destination, to);
  if (!target.startsWith(destination + path.sep))
    throw new Error("Invalid resource target");
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.resolve("apps/client/src-tauri", from), target, {
    recursive: true,
  });
}
console.log(JSON.stringify({ destination }));
