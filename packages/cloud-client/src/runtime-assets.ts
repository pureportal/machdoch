import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const runtimeAssetSchema = z.strictObject({
  path: z.string().refine(isAbsolute, "Use an absolute runtime asset path"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type RuntimeAsset = z.infer<typeof runtimeAssetSchema>;

export async function verifyRuntimeAsset(input: RuntimeAsset): Promise<string> {
  const asset = runtimeAssetSchema.parse(input);
  const metadata = await lstat(asset.path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(
      "A runtime asset is not a regular file. Reinstall the verified runtime.",
    );
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(asset.path)) hash.update(bytes);
  if (hash.digest("hex") !== asset.sha256)
    throw new Error("A runtime asset changed. Reinstall the verified runtime.");
  return realpath(asset.path);
}
