import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { assertRalphWorkspaceBoundary } from "./assert-ralph-workspace-boundary.helper.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";
import {
  commitRalphSnapshot,
  RALPH_SOURCE_PATHS,
  runRalphWorktreeGit,
  snapshotRalphWorktree,
} from "./ralph-worktree-git.helper.js";

export interface RalphRunWorktree {
  sourceWorkspaceRoot: string;
  executionWorkspaceRoot: string;
  repositoryRoot: string;
  worktreeRoot: string;
  branch: string;
  sourceBranch: string;
  baseCommit: string;
}

const runGit = async (
  cwd: string,
  args: string[],
  trimOutput = true,
): Promise<string> => {
  const output = await runRalphWorktreeGit(cwd, args);
  return trimOutput ? output.trim() : output;
};

const snapshotWorkspaceChanges = async (
  repositoryRoot: string,
  worktreeRoot: string,
  head: string,
): Promise<void> => {
  const [changedPaths, untrackedPaths] = await Promise.all([
    runGit(
      repositoryRoot,
      [
        "diff",
        "--name-only",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "-z",
        head,
        "--",
        ...RALPH_SOURCE_PATHS,
      ],
      false,
    ),
    runGit(
      repositoryRoot,
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...RALPH_SOURCE_PATHS,
      ],
      false,
    ),
  ]);
  const untrackedFiles = new Set(untrackedPaths.split("\0").filter(Boolean));
  const snapshotPaths = new Set([
    ...changedPaths.split("\0").filter(Boolean),
    ...untrackedFiles,
  ]);
  for (const path of snapshotPaths) {
    const source = resolve(repositoryRoot, path);
    const target = resolve(worktreeRoot, path);
    const metadata = await lstat(source).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && !untrackedFiles.has(path)) return null;
        throw error;
      },
    );
    if (metadata?.isDirectory()) {
      throw new Error(
        `RALPH cannot snapshot directory changes at ${path}. Commit them before retrying.`,
      );
    }
    await assertRalphWorkspaceBoundary(worktreeRoot, dirname(target));
    await rm(target, { force: true });
    if (!metadata) continue;
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, {
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  }
};

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
      !Object.hasOwn(stored, "branch") ||
      typeof (stored as RalphRunWorktree).sourceBranch !== "string" ||
      !/^[a-f0-9]{40,64}$/u.test((stored as RalphRunWorktree).baseCommit)
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

  const head = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  if (
    await stat(worktreeRoot).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
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
    head,
  ]);
  const worktree: RalphRunWorktree = {
    sourceWorkspaceRoot,
    executionWorkspaceRoot,
    repositoryRoot,
    worktreeRoot,
    branch,
    sourceBranch: await runGit(repositoryRoot, ["branch", "--show-current"]),
    baseCommit: "",
  };
  try {
    await snapshotWorkspaceChanges(repositoryRoot, worktreeRoot, head);
    worktree.baseCommit = await commitRalphSnapshot(
      worktreeRoot,
      await snapshotRalphWorktree(worktreeRoot),
      [head],
    );
    await runGit(repositoryRoot, [
      "update-ref",
      `refs/machdoch/${branch}/integration`,
      worktree.baseCommit,
    ]);
    await writeJsonAtomically(metadataPath, worktree);
  } catch (error) {
    try {
      await runGit(repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        worktreeRoot,
      ]);
      await runGit(repositoryRoot, ["branch", "-D", branch]);
      await runGit(repositoryRoot, [
        "update-ref",
        "-d",
        `refs/machdoch/${branch}/integration`,
      ]);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "RALPH could not prepare or remove its run worktree.",
      );
    }
    throw error;
  }
  return worktree;
};
