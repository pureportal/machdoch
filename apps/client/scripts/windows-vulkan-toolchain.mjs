import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

export const prepareWindowsVulkanToolchain = (environment) => {
  if (process.platform !== "win32") {
    return environment;
  }
  const sdkDirectory =
    environment.VULKAN_SDK ??
    join(
      environment.LOCALAPPDATA ?? "",
      "machdoch",
      "toolchains",
      "vulkan-sdk",
    );
  for (const relativePath of [
    "Bin/glslc.exe",
    "Lib/vulkan-1.lib",
    "Include/vulkan/vulkan.hpp",
  ]) {
    if (!existsSync(join(sdkDirectory, relativePath))) {
      throw new Error(
        `Vulkan SDK is missing ${relativePath}. Install the Windows x64 Vulkan SDK and set VULKAN_SDK to its directory.`,
      );
    }
  }
  const pathKey =
    Object.keys(environment).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  environment[pathKey] = [
    join(sdkDirectory, "Bin"),
    environment[pathKey] ?? "",
  ].join(delimiter);
  environment.VULKAN_SDK = sdkDirectory;
  environment.CARGO_TARGET_DIR ??= resolve(
    import.meta.dirname,
    "../../../.cache/rust",
  );
  return environment;
};
