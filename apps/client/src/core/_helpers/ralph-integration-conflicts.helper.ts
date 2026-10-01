import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { runRalphWorktreeGit as git } from "./ralph-worktree-git.helper.js";

const getConflictPaths = async (root: string): Promise<string[]> => {
  const entries = await git(root, ["ls-files", "--unmerged", "-z"]);
  return [
    ...new Set(
      entries
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(entry.indexOf("\t") + 1)),
    ),
  ];
};

const fingerprintConflictFile = async (
  root: string,
  path: string,
): Promise<string> => {
  const file = resolve(root, path);
  const metadata = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!metadata) return "missing";
  if (metadata.isSymbolicLink()) return `symlink:${await readlink(file)}`;
  if (!metadata.isFile()) return `mode:${metadata.mode}`;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `${metadata.mode}:${hash.digest("hex")}`;
};

export const snapshotRalphIntegrationConflicts = async (
  root: string,
): Promise<Map<string, string>> => {
  const paths = await getConflictPaths(root);
  return new Map(
    await Promise.all(
      paths.map(
        async (path) =>
          [path, await fingerprintConflictFile(root, path)] as const,
      ),
    ),
  );
};

export const stageRalphIntegrationConflictRepairs = async (
  root: string,
  before: ReadonlyMap<string, string>,
): Promise<boolean> => {
  for (const path of await getConflictPaths(root)) {
    if (
      before.has(path) &&
      before.get(path) !== (await fingerprintConflictFile(root, path))
    ) {
      await git(root, ["add", "--all", "--", `:(literal)${path}`]);
    }
  }
  return (await getConflictPaths(root)).length === 0;
};
