import { execFileSync } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { snapshotRalphWorktree } from "./ralph-worktree-git.helper.js";
import * as worktreeGit from "./ralph-worktree-git.helper.js";
import { applyRalphTreeDifference } from "./ralph-worktree-patch.helper.js";

const roots: string[] = [];
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      }),
    ),
  );
}, 60_000);

const createRepository = async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-tree-patch-"));
  roots.push(root);
  git(root, "init", "-q");
  await appendFile(
    join(root, ".git", "config"),
    "\n[user]\nname = Test\nemail = test@example.invalid\n[core]\nautocrlf = false\n",
  );
  await writeFile(join(root, "first.txt"), "original\n");
  await writeFile(join(root, "second.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return { root, before: git(root, "rev-parse", "HEAD^{tree}") };
};

describe("RALPH worktree patches", () => {
  it("streams patches larger than the command output buffer and removes temporary files", async () => {
    const commands = vi.spyOn(worktreeGit, "runRalphWorktreeGit");
    const { root, before } = await createRepository();
    const contents = Buffer.alloc(33 * 1024 * 1024, "x");
    contents[contents.length - 1] = 10;
    await writeFile(join(root, "large.txt"), contents);
    const after = await snapshotRalphWorktree(root);
    await rm(join(root, "large.txt"));
    await applyRalphTreeDifference(root, before, after);
    expect((await readFile(join(root, "large.txt"))).equals(contents)).toBe(
      true,
    );
    const patch = commands.mock.calls
      .find(([, args]) => args[0] === "apply")![1]
      .at(-1)!;
    await expect(readFile(patch)).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);

  it("checks the complete patch before applying any paths and cleans up after failure", async () => {
    const commands = vi.spyOn(worktreeGit, "runRalphWorktreeGit");
    const { root, before } = await createRepository();
    await writeFile(join(root, "first.txt"), "candidate\n");
    await writeFile(join(root, "second.txt"), "candidate\n");
    const after = await snapshotRalphWorktree(root);
    await writeFile(join(root, "first.txt"), "original\n");
    await writeFile(join(root, "second.txt"), "external edit\n");
    await expect(applyRalphTreeDifference(root, before, after)).rejects.toThrow(
      "patch does not apply",
    );
    expect(await readFile(join(root, "first.txt"), "utf8")).toBe("original\n");
    expect(await readFile(join(root, "second.txt"), "utf8")).toBe(
      "external edit\n",
    );
    const patch = commands.mock.calls
      .find(([, args]) => args[0] === "apply")![1]
      .at(-1)!;
    await expect(readFile(patch)).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);
});
