import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function downloadVerifiedAsset(asset, path) {
  const existing = await stat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (
    existing?.isFile() &&
    (asset.size === undefined || existing.size === asset.size) &&
    (await sha256File(path)) === asset.sha256
  )
    return;
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.download-${randomUUID()}`;
  try {
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || !response.body)
      throw new Error(
        `Asset download failed: HTTP ${response.status}: ${asset.url}`,
      );
    await pipeline(
      Readable.fromWeb(response.body),
      createWriteStream(temporary, { flags: "wx" }),
    );
    const downloaded = await stat(temporary);
    if (
      (asset.size !== undefined && downloaded.size !== asset.size) ||
      (await sha256File(temporary)) !== asset.sha256
    )
      throw new Error(`Asset integrity check failed: ${asset.url}`);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
