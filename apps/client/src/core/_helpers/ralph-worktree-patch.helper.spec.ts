import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotRalphWorktree } from "./ralph-worktree-git.helper.js";
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
  git(root, "config", "user.name", "Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  await writeFile(join(root, "first.txt"), "original\n");
  await writeFile(join(root, "second.txt"), "original\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  return { root, before: git(root, "rev-parse", "HEAD^{tree}") };
};

describe("RALPH worktree patches", () => {
  it("streams patches larger than the command output buffer and removes temporary files", async () => {
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
    expect(
      (await readdir(join(root, ".git"))).filter((path) =>
        path.startsWith("ralph-patch-"),
      ),
    ).toEqual([]);
  }, 90_000);

  it("checks the complete patch before applying any paths and cleans up after failure", async () => {
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
    expect(
      (await readdir(join(root, ".git"))).filter((path) =>
        path.startsWith("ralph-patch-"),
      ),
    ).toEqual([]);
  }, 90_000);
});
