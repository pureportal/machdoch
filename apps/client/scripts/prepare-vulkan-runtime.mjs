import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const runtimeDirectory = resolve(
  import.meta.dirname,
  "../src-tauri/target/vulkan-runtime",
);
const loaderPath = join(runtimeDirectory, "vulkan-1.dll");
const runtimeUrl =
  "https://sdk.lunarg.com/sdk/download/1.4.341.0/windows/VulkanRT-X64-1.4.341.0-Components.zip";
const archiveSha256 =
  "20571dcc8292b80a47d68bbbfa4094d87044041f50f4e2e1f326a01e3732b226";
const loaderSha256 =
  "98bc6e33b384f83e8cc36174ce1ba81357611d0cbe03462e1ca58d0663034039";

const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

export const stageWindowsVulkanRuntime = async () => {
  if (process.platform !== "win32") {
    return;
  }
  if (
    existsSync(loaderPath) &&
    (await sha256File(loaderPath)) === loaderSha256
  ) {
    return;
  }
  await mkdir(runtimeDirectory, { recursive: true });
  const archivePath = join(
    runtimeDirectory,
    `runtime.download-${process.pid}.zip`,
  );
  try {
    const response = await fetch(runtimeUrl, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(
        `Vulkan runtime download failed: HTTP ${response.status}`,
      );
    }
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(archivePath),
    );
    if ((await sha256File(archivePath)) !== archiveSha256) {
      throw new Error("Vulkan runtime download failed its integrity check.");
    }
    const extraction = spawnSync(
      join(process.env.SystemRoot ?? "C:/Windows", "System32", "tar.exe"),
      [
        "-xf",
        archivePath,
        "-C",
        runtimeDirectory,
        "--strip-components",
        "2",
        "VulkanRT-X64-1.4.341.0-Components/x64/vulkan-1.dll",
      ],
      { encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    if (extraction.error || extraction.status !== 0) {
      throw new Error(
        `Could not extract the Vulkan runtime: ${extraction.error?.message ?? extraction.stderr}`,
        {
          cause: extraction.error,
        },
      );
    }
    if ((await sha256File(loaderPath)) !== loaderSha256) {
      throw new Error("Vulkan runtime loader failed its integrity check.");
    }
  } finally {
    await rm(archivePath, { force: true });
  }
};
