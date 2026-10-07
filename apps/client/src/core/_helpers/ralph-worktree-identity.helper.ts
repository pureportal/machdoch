import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

export const ensureRalphWorktreeIdentity = async (
  runDirectory: string,
  migratedKey?: string,
): Promise<string> => {
  const path = join(runDirectory, "workspace-identity.json");
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(
        `RALPH worktree identity must be a regular file: ${path}`,
      );
    }
    const identity: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof identity !== "object" ||
      identity === null ||
      !("schemaVersion" in identity) ||
      identity.schemaVersion !== 1 ||
      !("key" in identity) ||
      typeof identity.key !== "string" ||
      !/^[a-f0-9]{20}$/u.test(identity.key)
    ) {
      throw new Error(`Invalid RALPH worktree identity: ${path}`);
    }
    if (migratedKey !== undefined && migratedKey !== identity.key) {
      throw new Error(`Conflicting RALPH worktree identity: ${path}`);
    }
    return identity.key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key =
    migratedKey ??
    createHash("sha256")
      .update(resolve(runDirectory))
      .digest("hex")
      .slice(0, 20);
  await writeJsonAtomically(path, { schemaVersion: 1, key });
  return key;
};
