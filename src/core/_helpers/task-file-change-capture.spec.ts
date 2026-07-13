import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startTaskFileChangeCapture } from "./task-file-change-capture.ts";

const workspacesToClean: string[] = [];

const runGit = async (cwd: string, args: readonly string[]): Promise<void> => {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", windowsHide: true },
      (error) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise();
      },
    );
  });
};

const createGitWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "machdoch-file-changes-"),
  );
  workspacesToClean.push(workspaceRoot);
  await runGit(workspaceRoot, ["init", "-q"]);
  await runGit(workspaceRoot, ["config", "user.name", "Machdoch Test"]);
  await runGit(workspaceRoot, [
    "config",
    "user.email",
    "machdoch-test@example.com",
  ]);
  await runGit(workspaceRoot, ["config", "commit.gpgSign", "false"]);
  await runGit(workspaceRoot, ["config", "core.autocrlf", "false"]);
  return workspaceRoot;
};

const commitWorkspace = async (workspaceRoot: string): Promise<void> => {
  await runGit(workspaceRoot, ["add", "--all"]);
  await runGit(workspaceRoot, ["commit", "-q", "-m", "Initial state"]);
};

afterEach(async () => {
  await Promise.all(
    workspacesToClean.splice(0).map((workspace) =>
      rm(workspace, { force: true, recursive: true }),
    ),
  );
});

describe("task file change capture", () => {
  it("captures new files in a repository without an initial commit", async () => {
    const workspaceRoot = await createGitWorkspace();
    await writeFile(
      join(workspaceRoot, "already-staged.ts"),
      "existing\n",
      "utf8",
    );
    await runGit(workspaceRoot, ["add", "already-staged.ts"]);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(join(workspaceRoot, "created.ts"), "new\n", "utf8");

    const result = await capture?.finish();

    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "created.ts",
        kind: "added",
        additions: 1,
      }),
    ]);
  });

  it("reports tracked edits, new untracked files, line counts, and hunk ranges", async () => {
    const workspaceRoot = await createGitWorkspace();
    await writeFile(
      join(workspaceRoot, "source.ts"),
      "one\ntwo\nthree\n",
      "utf8",
    );
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(
      join(workspaceRoot, "source.ts"),
      "one\nTWO\nthree\nfour\n",
      "utf8",
    );
    await writeFile(join(workspaceRoot, "new-file.ts"), "alpha\nbeta\n", "utf8");

    const result = await capture?.finish();
    const sourceChange = result?.files.find((file) => file.path === "source.ts");
    const newFileChange = result?.files.find(
      (file) => file.path === "new-file.ts",
    );

    expect(result).toMatchObject({
      totalFiles: 2,
      additions: 4,
      deletions: 1,
      lineCountsComplete: true,
      coverage: "complete",
      truncated: false,
      attribution: "workspace-observed",
    });
    expect(sourceChange).toMatchObject({
      kind: "modified",
      additions: 2,
      deletions: 1,
    });
    expect(sourceChange?.ranges?.length).toBeGreaterThan(0);
    expect(newFileChange).toMatchObject({
      kind: "added",
      additions: 2,
      deletions: 0,
      ranges: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 2,
        },
      ],
    });
  });

  it("uses the dirty task-start state as its baseline", async () => {
    const workspaceRoot = await createGitWorkspace();
    const sourcePath = join(workspaceRoot, "source.ts");
    await writeFile(sourcePath, "one\n", "utf8");
    await commitWorkspace(workspaceRoot);
    await writeFile(sourcePath, "one\nbefore-task\n", "utf8");
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(sourcePath, "one\nbefore-task\nafter-task\n", "utf8");

    const result = await capture?.finish();

    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "source.ts",
        kind: "modified",
        additions: 1,
        deletions: 0,
      }),
    ]);
  });

  it("detects edits to pre-existing untracked files without counting index-only changes", async () => {
    const workspaceRoot = await createGitWorkspace();
    await writeFile(join(workspaceRoot, "tracked.ts"), "tracked\n", "utf8");
    await commitWorkspace(workspaceRoot);
    await writeFile(
      join(workspaceRoot, "existing-untracked.ts"),
      "before\n",
      "utf8",
    );
    await writeFile(
      join(workspaceRoot, "staged-without-edit.ts"),
      "unchanged\n",
      "utf8",
    );
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(
      join(workspaceRoot, "existing-untracked.ts"),
      "after\n",
      "utf8",
    );
    await runGit(workspaceRoot, ["add", "staged-without-edit.ts"]);

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 1,
      lineCountsComplete: false,
      coverage: "complete",
    });
    expect(result?.files).toEqual([
      {
        path: "existing-untracked.ts",
        kind: "modified",
      },
    ]);
  });

  it("finalizes only once when multiple consumers request the result", async () => {
    const workspaceRoot = await createGitWorkspace();
    const sourcePath = join(workspaceRoot, "source.ts");
    await writeFile(sourcePath, "one\n", "utf8");
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(sourcePath, "two\n", "utf8");

    const firstResult = capture?.finish();
    const secondResult = capture?.finish();

    expect(firstResult).toBe(secondResult);
    await expect(firstResult).resolves.toMatchObject({ totalFiles: 1 });
  });

  it("omits file-change metadata when the workspace did not change", async () => {
    const workspaceRoot = await createGitWorkspace();
    await writeFile(join(workspaceRoot, "source.ts"), "one\n", "utf8");
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await expect(capture?.finish()).resolves.toBeUndefined();
  });
});
