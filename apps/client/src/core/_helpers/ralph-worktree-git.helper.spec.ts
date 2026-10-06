import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  snapshotRalphWorktree,
  stageRalphSourceChanges,
  runRalphWorktreeGit,
} from "./ralph-worktree-git.helper.js";

it("snapshots literal source paths and deletions while excluding tracked and ignored runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-source-staging-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      windowsHide: true,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();
  try {
    git("init", "-q");
    await mkdir(join(root, ".machdoch"));
    await mkdir(join(root, "nested"));
    await writeFile(join(root, ".machdoch", "tracked.json"), "{}");
    await writeFile(join(root, "nested", ".machdoch"), "private");
    await writeFile(join(root, "deleted.txt"), "delete me\n");
    await writeFile(join(root, "source.txt"), "baseline\n");
    git("add", ".");
    git(
      "-c",
      "user.name=RALPH",
      "-c",
      "user.email=ralph@example.invalid",
      "commit",
      "-qm",
      "baseline",
    );
    const head = git("rev-parse", "HEAD");
    await writeFile(join(root, "source.txt"), "staged\n");
    git("add", "source.txt");
    const index = git("write-tree");
    await writeFile(join(root, "source.txt"), "working\n");
    await writeFile(join(root, ".gitignore"), ".machdoch\n");
    await writeFile(join(root, ".machdoch", "ignored.json"), "{}");
    await writeFile(join(root, "[literal] space.txt"), "literal\n");
    await writeFile(join(root, "nested", ".machdoch-source"), "source\n");
    await rm(join(root, "deleted.txt"));

    const tree = await snapshotRalphWorktree(root);

    expect(git("ls-tree", "-r", "--name-only", tree).split("\n")).toEqual([
      ".gitignore",
      "[literal] space.txt",
      "nested/.machdoch-source",
      "source.txt",
    ]);
    expect(git("show", `${tree}:source.txt`)).toBe("working");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("write-tree")).toBe(index);
    expect(
      await readFile(join(root, ".machdoch", "tracked.json"), "utf8"),
    ).toBe("{}");
    expect(await readFile(join(root, "nested", ".machdoch"), "utf8")).toBe(
      "private",
    );

    await stageRalphSourceChanges(root);

    expect(git("write-tree")).toBe(tree);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(
      await readFile(join(root, ".machdoch", "ignored.json"), "utf8"),
    ).toBe("{}");
  } finally {
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  }
}, 180_000);

it.runIf(process.platform === "win32")(
  "checks out and removes long-path worktrees without changing repository configuration",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "ralph-long-path-"));
    const root = join(directory, "source");
    const worktree = join(directory, "candidate");
    await mkdir(root);
    const git = (args: string[]) => runRalphWorktreeGit(root, args);
    try {
      await git(["init", "-q"]);
      await git(["config", "core.autocrlf", "false"]);
      await git(["config", "core.longpaths", "false"]);
      const segments = Array.from(
        { length: 8 },
        (_, index) => `directory-${index}-${"nested".repeat(4)}`,
      );
      const sourcePath = join(root, ...segments, "source.txt");
      expect(sourcePath.length).toBeGreaterThan(260);
      await mkdir(join(root, ...segments), { recursive: true });
      await writeFile(sourcePath, "baseline\n");
      await git(["add", "."]);
      await git([
        "-c",
        "user.name=RALPH",
        "-c",
        "user.email=ralph@example.invalid",
        "commit",
        "-qm",
        "baseline",
      ]);
      await git(["worktree", "add", "--detach", worktree, "HEAD"]);
      expect(
        await readFile(join(worktree, ...segments, "source.txt"), "utf8"),
      ).toBe("baseline\n");
      await git(["worktree", "remove", "--force", worktree]);
      expect(await git(["config", "--local", "core.longpaths"])).toBe(
        "false\n",
      );
      expect(await git(["worktree", "list", "--porcelain"])).not.toContain(
        worktree.replace(/\\/gu, "/"),
      );
    } finally {
      await rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
    }
  },
  300_000,
);
