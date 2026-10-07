import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import type { UpdateArtifact } from "./release.js";
import { validateArtifactUrl } from "./release.js";
import { verifyUpdateSignature } from "./signature.js";

export async function downloadUpdate(
  artifact: UpdateArtifact,
  version: string,
  publicKey: string,
  destination: string,
): Promise<void> {
  validateArtifactUrl(artifact.url, version);
  const response = await fetch(artifact.url, {
    signal: AbortSignal.timeout(30 * 60_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Downloading the update failed (HTTP ${response.status}).`);
  const file = await open(destination, "wx", 0o600);
  let completed = false;
  try {
    const sha256 = createHash("sha256");
    const blake2 = createHash("blake2b512");
    let downloaded = 0;
    for await (const chunk of response.body) {
      downloaded += chunk.length;
      if (downloaded > artifact.size)
        throw new Error("The update exceeds its announced size.");
      sha256.update(chunk);
      blake2.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(
          chunk,
          offset,
          chunk.length - offset,
        );
        if (!bytesWritten) throw new Error("Writing the update failed.");
        offset += bytesWritten;
      }
    }
    if (
      downloaded !== artifact.size ||
      sha256.digest("hex") !== artifact.sha256
    ) {
      throw new Error(
        "The update is incomplete or damaged. Try downloading it again.",
      );
    }
    verifyUpdateSignature(
      blake2.digest(),
      artifact.signature,
      publicKey,
      version,
      new URL(artifact.url).pathname.split("/").at(-1)!,
    );
    await file.sync();
    completed = true;
  } finally {
    await file.close();
    if (!completed) await rm(destination, { force: true });
  }
}
