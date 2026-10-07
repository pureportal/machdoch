import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { assertRalphWorkspaceBoundary } from "./assert-ralph-workspace-boundary.helper.js";
import { writeJsonAtomically } from "./write-file-atomically.helper.js";
import { ensureRalphWorktreeIdentity } from "./ralph-worktree-identity.helper.js";
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

class RalphWorktreePreparationTimeout extends Error {}

const removeOwnedPreparation = async (
  worktree: RalphRunWorktree,
): Promise<void> => {
  const branchHead = await runGit(worktree.repositoryRoot, [
    "for-each-ref",
    "--format=%(objectname)",
    `refs/heads/${worktree.branch}`,
  ]);
  if (branchHead && branchHead !== worktree.baseCommit) {
    throw new Error("RALPH preparation branch changed; refusing to remove it.");
  }
  const registeredWorktrees = await runGit(worktree.repositoryRoot, [
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const registered = registeredWorktrees
    .split("\0")
    .some(
      (field) =>
        field.startsWith("worktree ") &&
        resolve(field.slice("worktree ".length)) === worktree.worktreeRoot,
    );
  if (
    !registered &&
    (await stat(worktree.worktreeRoot).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    ))
  ) {
    throw new Error(
      "RALPH run worktree already exists without ownership metadata in Git.",
    );
  }
  if (registered) {
    if (
      (await runGit(worktree.worktreeRoot, ["branch", "--show-current"])) !==
        worktree.branch ||
      (await getCommonGitDirectory(worktree.worktreeRoot)) !==
        (await getCommonGitDirectory(worktree.repositoryRoot))
    )
      throw new Error("RALPH cannot remove a worktree it does not own.");
    await runGit(worktree.repositoryRoot, [
      "worktree",
      "remove",
      "--force",
      "--force",
      worktree.worktreeRoot,
    ]);
  }
  if (branchHead) {
    await runGit(worktree.repositoryRoot, ["branch", "-D", worktree.branch]);
  }
  await runGit(worktree.repositoryRoot, [
    "update-ref",
    "-d",
    `refs/machdoch/${worktree.branch}/integration`,
  ]);
};

const failPreparation = async (
  worktree: RalphRunWorktree,
  preparationPath: string,
  failure: unknown,
): Promise<never> => {
  try {
    await removeOwnedPreparation(worktree);
    await unlink(preparationPath);
  } catch (cleanupError) {
    const preparationReason =
      failure instanceof Error ? failure.message : String(failure);
    const cleanupReason =
      cleanupError instanceof Error
        ? cleanupError.message
        : String(cleanupError);
    throw new AggregateError(
      [failure, cleanupError],
      `RALPH could not prepare or remove its run worktree: ${preparationReason}\nWorktree cleanup failed: ${cleanupReason}`,
    );
  }
  if (failure instanceof Error && /timed out/iu.test(failure.message)) {
    throw new RalphWorktreePreparationTimeout(failure.message, {
      cause: failure,
    });
  }
  throw failure;
};

const prepareRalphRunWorktreeAttempt = async (
  workspaceRoot: string,
  runDirectory: string,
): Promise<RalphRunWorktree> => {
  const sourceWorkspaceRoot = await realpath(resolve(workspaceRoot));
  const metadataPath = join(runDirectory, "workspace-isolation.json");
  const preparationPath = join(runDirectory, "workspace-preparation.json");
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
  const key = await ensureRalphWorktreeIdentity(runDirectory);
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
    await unlink(preparationPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return existing;
  }

  const head = await runGit(repositoryRoot, ["rev-parse", "HEAD"]);
  const sourceBranch = await runGit(repositoryRoot, [
    "branch",
    "--show-current",
  ]);
  let interrupted: unknown;
  try {
    interrupted = JSON.parse(
      await readFile(preparationPath, "utf8"),
    ) as unknown;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  if (interrupted !== undefined) {
    const candidate = interrupted as RalphRunWorktree;
    if (
      typeof interrupted !== "object" ||
      interrupted === null ||
      candidate.sourceWorkspaceRoot !== sourceWorkspaceRoot ||
      candidate.executionWorkspaceRoot !== executionWorkspaceRoot ||
      candidate.repositoryRoot !== repositoryRoot ||
      candidate.worktreeRoot !== worktreeRoot ||
      candidate.branch !== branch ||
      candidate.sourceBranch !== sourceBranch ||
      typeof candidate.baseCommit !== "string" ||
      !/^[a-f0-9]{40,64}$/u.test(candidate.baseCommit)
    )
      throw new Error(
        "RALPH interrupted preparation metadata does not match this run.",
      );
    await removeOwnedPreparation(candidate);
    await unlink(preparationPath);
  }
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
  const worktree: RalphRunWorktree = {
    sourceWorkspaceRoot,
    executionWorkspaceRoot,
    repositoryRoot,
    worktreeRoot,
    branch,
    sourceBranch,
    baseCommit: "",
  };
  if (
    await runGit(repositoryRoot, [
      "for-each-ref",
      "--format=%(refname)",
      `refs/heads/${branch}`,
    ])
  ) {
    throw new Error(
      "RALPH preparation branch already exists without ownership metadata.",
    );
  }
  await writeJsonAtomically(preparationPath, { ...worktree, baseCommit: head });
  try {
    await runGit(repositoryRoot, ["branch", branch, head]);
  } catch (error) {
    if (!(error instanceof Error && /timed out/iu.test(error.message))) {
      try {
        await unlink(preparationPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `RALPH branch allocation failed: ${error instanceof Error ? error.message : String(error)}\nPreparation metadata cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
      throw error;
    }
    await failPreparation(
      { ...worktree, baseCommit: head },
      preparationPath,
      error,
    );
  }
  try {
    await runGit(repositoryRoot, ["worktree", "add", worktreeRoot, branch]);
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
    await failPreparation(
      { ...worktree, baseCommit: head },
      preparationPath,
      error,
    );
  }
  await unlink(preparationPath);
  return worktree;
};

export const prepareRalphRunWorktree = async (
  workspaceRoot: string,
  runDirectory: string,
): Promise<RalphRunWorktree> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await prepareRalphRunWorktreeAttempt(workspaceRoot, runDirectory);
    } catch (error) {
      if (!(error instanceof RalphWorktreePreparationTimeout) || attempt >= 3) {
        throw error;
      }
      await setTimeout(attempt * 1_000 + Math.floor(Math.random() * 250));
    }
  }
};
