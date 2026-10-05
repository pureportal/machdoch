import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRalphWorktreeGit as git } from "./ralph-worktree-git.helper.js";

export const applyRalphTreeDifference = async (
  root: string,
  before: string,
  after: string,
): Promise<void> => {
  if (before === after) return;
  const patchPath = join(tmpdir(), `ralph-patch-${randomUUID()}`);
  try {
    const patch = await open(patchPath, "wx");
    let bytes = 0;
    try {
      await git(
        root,
        [
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--no-renames",
          "--no-relative",
          "--unified=3",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          before,
          after,
        ],
        {
          onStdoutBytes: (chunk) => {
            writeFileSync(patch.fd, chunk);
            bytes += chunk.length;
          },
        },
      );
    } finally {
      await patch.close();
    }
    if (bytes === 0) return;
    await git(root, [
      "apply",
      "--check",
      "--binary",
      "--whitespace=nowarn",
      "--",
      patchPath,
    ]);
    await git(root, [
      "apply",
      "--binary",
      "--whitespace=nowarn",
      "--",
      patchPath,
    ]);
  } finally {
    await rm(patchPath, { force: true });
  }
};
