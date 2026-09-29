import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";

export interface RalphRunWorktree {
  sourceWorkspaceRoot: string;
  executionWorkspaceRoot: string;
  repositoryRoot: string;
  worktreeRoot: string;
  branch: string;
}

const runGit = (cwd: string, args: string[]): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });

const isInside = (root: string, candidate: string): boolean => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};

const getCommonGitDirectory = async (root: string): Promise<string> => {
  const directory = await runGit(root, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return realpath(directory);
};

const assertWorktreeMatchesSource = async (
  worktree: RalphRunWorktree,
  sourceRoot: string,
): Promise<void> => {
  if ((await realpath(worktree.sourceWorkspaceRoot)) !== sourceRoot) {
    throw new Error("RALPH run worktree belongs to a different workspace.");
  }
  const repositoryRoot = await realpath(
    await runGit(sourceRoot, ["rev-parse", "--show-toplevel"]),
  );
  const linkedRoot = await realpath(
    await runGit(worktree.executionWorkspaceRoot, [
      "rev-parse",
      "--show-toplevel",
    ]),
  );
  if (
    repositoryRoot !== (await realpath(worktree.repositoryRoot)) ||
    linkedRoot !== (await realpath(worktree.worktreeRoot)) ||
    (await runGit(linkedRoot, ["branch", "--show-current"])) !==
      worktree.branch ||
    (await getCommonGitDirectory(repositoryRoot)) !==
      (await getCommonGitDirectory(linkedRoot)) ||
    !isInside(linkedRoot, worktree.executionWorkspaceRoot)
  ) {
    throw new Error(
      "RALPH run worktree no longer matches its source repository.",
    );
  }
};

export const prepareRalphRunWorktree = async (
  workspaceRoot: string,
  runDirectory: string,
): Promise<RalphRunWorktree> => {
  const sourceWorkspaceRoot = await realpath(resolve(workspaceRoot));
  const metadataPath = join(runDirectory, "workspace-isolation.json");
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(metadataPath, "utf8")) as unknown;
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const repositoryRoot = await realpath(
    await runGit(sourceWorkspaceRoot, ["rev-parse", "--show-toplevel"]),
  );
  if (!isInside(repositoryRoot, sourceWorkspaceRoot)) {
    throw new Error(
      "RALPH workspace must be inside a Git repository for isolated runs.",
    );
  }
  const key = createHash("sha256")
    .update(resolve(runDirectory))
    .digest("hex")
    .slice(0, 20);
  const worktreeRoot = join(
    dirname(repositoryRoot),
    ".machdoch-ralph-worktrees",
    key,
  );
  if (isInside(repositoryRoot, worktreeRoot)) {
    throw new Error(
      "RALPH cannot place an isolated worktree outside this repository.",
    );
  }
  const branch = `ralph/${key}`;
  const executionWorkspaceRoot = join(
    worktreeRoot,
    relative(repositoryRoot, sourceWorkspaceRoot),
  );
  if (stored !== undefined) {
    if (
      typeof stored !== "object" ||
      stored === null ||
      !Object.hasOwn(stored, "sourceWorkspaceRoot") ||
      !Object.hasOwn(stored, "executionWorkspaceRoot") ||
      !Object.hasOwn(stored, "repositoryRoot") ||
      !Object.hasOwn(stored, "worktreeRoot") ||
      !Object.hasOwn(stored, "branch")
    ) {
      throw new Error("RALPH run worktree metadata is invalid.");
    }
    const existing = stored as RalphRunWorktree;
    if (
      existing.sourceWorkspaceRoot !== sourceWorkspaceRoot ||
      existing.executionWorkspaceRoot !== executionWorkspaceRoot ||
      existing.repositoryRoot !== repositoryRoot ||
      existing.worktreeRoot !== worktreeRoot ||
      existing.branch !== branch
    ) {
      throw new Error("RALPH run worktree metadata does not match this run.");
    }
    await assertWorktreeMatchesSource(existing, sourceWorkspaceRoot);
    return existing;
  }

  await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  const changes = await runGit(repositoryRoot, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (
    changes
      .split(/\r?\n/u)
      .some((line) => line && !/^.. \.machdoch\//u.test(line))
  ) {
    throw new Error(
      "Commit or stash workspace changes before starting an isolated RALPH run.",
    );
  }
  if (
    await stat(worktreeRoot).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error(
      `RALPH run worktree already exists without ownership metadata: ${worktreeRoot}`,
    );
  }
  await runGit(repositoryRoot, [
    "worktree",
    "add",
    "-b",
    branch,
    worktreeRoot,
    "HEAD",
  ]);
  const worktree: RalphRunWorktree = {
    sourceWorkspaceRoot,
    executionWorkspaceRoot,
    repositoryRoot,
    worktreeRoot,
    branch,
  };
  await writeJsonAtomically(metadataPath, worktree);
  return worktree;
};
