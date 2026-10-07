import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRalphRunWorktree } from "./_helpers/ralph-run-worktree.helper.js";
import { ensureWorkspaceStorage } from "./workspace-storage.js";

const roots: string[] = [];
const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })),
  );
});

describe("workspace storage migration with isolated RALPH runs", () => {
  it("resumes the same worktree and preserves uncommitted changes after moving its run", async () => {
    const root = await mkdtemp(join(tmpdir(), "machdoch-worktree-migration-"));
    roots.push(root);
    const workspace = join(root, "repository");
    await mkdir(workspace);
    git(workspace, "init");
    git(workspace, "config", "user.name", "Test");
    git(workspace, "config", "user.email", "test@example.invalid");
    await writeFile(join(workspace, "source.txt"), "original\n");
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "initial");
    const previousRunDirectory = join(workspace, ".machdoch/ralph/runs/run");
    await mkdir(previousRunDirectory, { recursive: true });
    const original = await prepareRalphRunWorktree(
      workspace,
      previousRunDirectory,
    );
    await unlink(join(previousRunDirectory, "workspace-identity.json"));
    await writeFile(join(original.worktreeRoot, "source.txt"), "unfinished\n");
    await writeFile(
      join(previousRunDirectory, "workspace-integration.json"),
      JSON.stringify({
        verificationRunDirectory: join(previousRunDirectory, "verification"),
      }),
    );

    await ensureWorkspaceStorage(workspace);

    const runDirectory = join(
      workspace,
      ".machdoch/local/state/ralph/runs/run",
    );
    const resumed = await prepareRalphRunWorktree(workspace, runDirectory);
    expect(resumed).toEqual(original);
    expect(
      await readFile(join(resumed.worktreeRoot, "source.txt"), "utf8"),
    ).toBe("unfinished\n");
    expect(git(resumed.worktreeRoot, "status", "--porcelain")).toContain(
      "source.txt",
    );
    expect(
      JSON.parse(
        await readFile(
          join(runDirectory, "workspace-integration.json"),
          "utf8",
        ),
      ),
    ).toEqual({ verificationRunDirectory: join(runDirectory, "verification") });
  });
});
