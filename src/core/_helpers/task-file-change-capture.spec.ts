import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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

const initializeGitWorkspace = async (workspaceRoot: string): Promise<void> => {
  await mkdir(workspaceRoot, { recursive: true });
  await runGit(workspaceRoot, ["init", "-q"]);
  await runGit(workspaceRoot, ["config", "user.name", "Machdoch Test"]);
  await runGit(workspaceRoot, [
    "config",
    "user.email",
    "machdoch-test@example.com",
  ]);
  await runGit(workspaceRoot, ["config", "commit.gpgSign", "false"]);
  await runGit(workspaceRoot, ["config", "core.autocrlf", "false"]);
};

const createGitWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "machdoch-file-changes-"),
  );
  workspacesToClean.push(workspaceRoot);
  await initializeGitWorkspace(workspaceRoot);
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
  it("aggregates file changes from sibling repositories", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "machdoch-file-changes-multi-"),
    );
    workspacesToClean.push(workspaceRoot);
    const apiRoot = join(workspaceRoot, "api");
    const uiRoot = join(workspaceRoot, "ui");
    await Promise.all([
      initializeGitWorkspace(apiRoot),
      initializeGitWorkspace(uiRoot),
    ]);
    await Promise.all([
      writeFile(join(apiRoot, "source.ts"), "one\n", "utf8"),
      writeFile(join(uiRoot, "source.ts"), "one\n", "utf8"),
    ]);
    await Promise.all([commitWorkspace(apiRoot), commitWorkspace(uiRoot)]);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(join(apiRoot, "source.ts"), "one\ntwo\n", "utf8");
    await writeFile(join(uiRoot, "created.ts"), "new\n", "utf8");

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 2,
      additions: 2,
      deletions: 0,
      repositoryCount: 2,
      status: "complete",
    });
    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "api/source.ts",
        repositoryPath: "api",
        operation: "modified",
      }),
      expect.objectContaining({
        path: "ui/created.ts",
        repositoryPath: "ui",
        operation: "added",
      }),
    ]);
  });

  it("preserves scoped capture when the workspace is inside a parent repository", async () => {
    const repositoryRoot = await createGitWorkspace();
    const workspaceRoot = join(repositoryRoot, "packages", "app");
    const sourcePath = join(workspaceRoot, "source.ts");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(sourcePath, "one\n", "utf8");
    await commitWorkspace(repositoryRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(sourcePath, "one\ntwo\n", "utf8");

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 1,
      additions: 1,
      repositoryCount: 1,
    });
    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "source.ts",
        operation: "modified",
      }),
    ]);
  });

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
        operation: "added",
        lineAnalysis: {
          state: "complete",
          additions: 1,
          deletions: 0,
        },
      }),
    ]);
  });

  it("captures a repository created after the task starts", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "machdoch-file-changes-created-repository-"),
    );
    workspacesToClean.push(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await initializeGitWorkspace(workspaceRoot);
    await writeFile(join(workspaceRoot, "created.ts"), "new\n", "utf8");

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 1,
      additions: 1,
      deletions: 0,
      repositoryCount: 1,
      status: "complete",
    });
    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "created.ts",
        operation: "added",
        entryType: "text",
        lineAnalysis: {
          state: "complete",
          additions: 1,
          deletions: 0,
        },
      }),
    ]);
  });

  it("omits file-change metadata when a non-Git workspace stays unchanged", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "machdoch-file-changes-non-git-"),
    );
    workspacesToClean.push(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    expect(capture).toBeDefined();
    await expect(capture?.finish()).resolves.toBeUndefined();
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
      status: "complete",
      attribution: "workspace-observed",
    });
    expect(sourceChange).toMatchObject({
      operation: "modified",
      lineAnalysis: {
        state: "complete",
        additions: 2,
        deletions: 1,
      },
    });
    expect(sourceChange?.ranges?.length).toBeGreaterThan(0);
    expect(newFileChange).toMatchObject({
      operation: "added",
      lineAnalysis: {
        state: "complete",
        additions: 2,
        deletions: 0,
      },
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

  it("streams patches without retaining very large changed lines", async () => {
    const workspaceRoot = await createGitWorkspace();
    const sourcePath = join(workspaceRoot, "generated.txt");
    await writeFile(sourcePath, `${"a".repeat(512 * 1_024)}\n`, "utf8");
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(sourcePath, `${"b".repeat(512 * 1_024)}\n`, "utf8");

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 1,
      additions: 1,
      deletions: 1,
      status: "complete",
    });
    expect(result?.files[0]).toMatchObject({
      path: "generated.txt",
      entryType: "text",
      lineAnalysis: {
        state: "complete",
        additions: 1,
        deletions: 1,
      },
      ranges: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
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
        operation: "modified",
        lineAnalysis: {
          state: "complete",
          additions: 1,
          deletions: 0,
        },
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
      additions: 1,
      deletions: 1,
      status: "complete",
    });
    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "existing-untracked.ts",
        operation: "modified",
        lineAnalysis: {
          state: "complete",
          additions: 1,
          deletions: 1,
        },
      }),
    ]);
  });

  it("reports submodule references without adding fake text lines", async () => {
    const workspaceRoot = await createGitWorkspace();
    const submoduleSource = await createGitWorkspace();
    await writeFile(join(submoduleSource, "source.ts"), "one\n", "utf8");
    await commitWorkspace(submoduleSource);
    await runGit(workspaceRoot, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      submoduleSource,
      "modules/dependency",
    ]);
    await commitWorkspace(workspaceRoot);
    const submoduleRoot = join(workspaceRoot, "modules", "dependency");
    await runGit(submoduleRoot, ["config", "user.name", "Machdoch Test"]);
    await runGit(submoduleRoot, [
      "config",
      "user.email",
      "machdoch-test@example.com",
    ]);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(join(submoduleRoot, "source.ts"), "one\ntwo\n", "utf8");
    await runGit(submoduleRoot, ["add", "--all"]);
    await runGit(submoduleRoot, ["commit", "-q", "-m", "Advance submodule"]);

    const result = await capture?.finish();
    const gitlink = result?.files.find(
      (file) => file.entryType === "gitlink",
    );

    expect(result).toMatchObject({
      additions: 1,
      deletions: 0,
      gitlinkFiles: 1,
      status: "complete",
    });
    expect(gitlink).toMatchObject({
      path: "modules/dependency",
      entryType: "gitlink",
      lineAnalysis: { state: "not-applicable", reason: "gitlink" },
    });
    expect(gitlink?.oldCommit).not.toBe(gitlink?.newCommit);
  });

  it("reports pure renames without inventing line changes", async () => {
    const workspaceRoot = await createGitWorkspace();
    const oldPath = join(workspaceRoot, "before.ts");
    const newPath = join(workspaceRoot, "after.ts");
    await writeFile(oldPath, "one\ntwo\n", "utf8");
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await rename(oldPath, newPath);

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 1,
      additions: 0,
      deletions: 0,
      status: "complete",
    });
    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "after.ts",
        oldPath: "before.ts",
        operation: "renamed",
        entryType: "text",
        lineAnalysis: {
          state: "complete",
          additions: 0,
          deletions: 0,
        },
      }),
    ]);
  });

  it("classifies binary changes without treating them as unavailable lines", async () => {
    const workspaceRoot = await createGitWorkspace();
    const binaryPath = join(workspaceRoot, "asset.bin");
    await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(binaryPath, Buffer.from([0, 1, 2, 4]));

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 1,
      additions: 0,
      deletions: 0,
      binaryFiles: 1,
      failedFiles: 0,
      status: "complete",
    });
    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "asset.bin",
        operation: "modified",
        entryType: "binary",
        lineAnalysis: {
          state: "not-applicable",
          reason: "binary",
        },
      }),
    ]);
  });

  it("honors path-based binary attributes during line analysis", async () => {
    const workspaceRoot = await createGitWorkspace();
    const attributedPath = join(workspaceRoot, "payload.dat");
    await writeFile(join(workspaceRoot, ".gitattributes"), "*.dat -diff\n", "utf8");
    await writeFile(attributedPath, "plain text before\n", "utf8");
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await writeFile(attributedPath, "plain text after\n", "utf8");

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 1,
      additions: 0,
      deletions: 0,
      binaryFiles: 1,
      failedFiles: 0,
      status: "complete",
    });
    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "payload.dat",
        operation: "modified",
        entryType: "binary",
        lineAnalysis: {
          state: "not-applicable",
          reason: "binary",
        },
      }),
    ]);
  });

  it("reports mode-only changes without inventing content lines", async () => {
    const workspaceRoot = await createGitWorkspace();
    const scriptPath = join(workspaceRoot, "script.sh");
    await writeFile(scriptPath, "echo ready\n", "utf8");
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await runGit(workspaceRoot, ["update-index", "--chmod=+x", "script.sh"]);

    const result = await capture?.finish();

    expect(result).toMatchObject({
      totalFiles: 1,
      additions: 0,
      deletions: 0,
      modeOnlyFiles: 1,
      failedFiles: 0,
      status: "complete",
    });
    expect(result?.files).toEqual([
      expect.objectContaining({
        path: "script.sh",
        operation: "modified",
        entryType: "mode",
        oldMode: "100644",
        newMode: "100755",
        lineAnalysis: {
          state: "not-applicable",
          reason: "mode-only",
        },
      }),
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

  it("can dispose an abandoned capture without attempting a final diff", async () => {
    const workspaceRoot = await createGitWorkspace();
    await writeFile(join(workspaceRoot, "source.ts"), "one\n", "utf8");
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await capture?.dispose();

    await expect(capture?.finish()).resolves.toBeUndefined();
  });

  it("omits file-change metadata when the workspace did not change", async () => {
    const workspaceRoot = await createGitWorkspace();
    await writeFile(join(workspaceRoot, "source.ts"), "one\n", "utf8");
    await commitWorkspace(workspaceRoot);
    const capture = await startTaskFileChangeCapture(workspaceRoot);

    await expect(capture?.finish()).resolves.toBeUndefined();
  });
});
