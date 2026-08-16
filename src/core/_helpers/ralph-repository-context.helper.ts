import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

export interface RalphRepositoryContext {
  workspaceRoot: string;
  projectRoot: string;
  worktreeRoot: string;
  projectPath: string;
  workspacePath: string;
  source: "workspace" | "nested";
  head: string;
  digest: string;
}

const runGit = (
  cwd: string,
  args: string[],
  timeoutMs: number,
): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", ...args],
      {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(stdout.trim());
      },
    );
  });

const normalizeComparablePath = (value: string): string => {
  const normalized = resolve(value).replace(/\\/gu, "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const isInside = (child: string, parent: string): boolean => {
  const childPath = normalizeComparablePath(child);
  const parentPath = normalizeComparablePath(parent);
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`);
};

const canonicalDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const resolveRalphRepositoryContext = async (input: {
  workspaceRoot: string;
  projectPath: string;
  timeoutMs?: number;
}): Promise<RalphRepositoryContext> => {
  const workspaceRoot = await realpath(resolve(input.workspaceRoot));
  let projectPath = await realpath(resolve(input.projectPath));
  if (!(await stat(projectPath)).isDirectory()) {
    projectPath = dirname(projectPath);
  }
  if (!isInside(projectPath, workspaceRoot)) {
    throw new Error("RALPH project root must stay inside the workspace.");
  }

  const [gitRootResult, headResult] = await Promise.allSettled([
    runGit(
      projectPath,
      ["rev-parse", "--show-toplevel"],
      input.timeoutMs ?? 10_000,
    ),
    runGit(projectPath, ["rev-parse", "HEAD"], input.timeoutMs ?? 10_000),
  ]);
  if (gitRootResult.status === "rejected") {
    throw gitRootResult.reason;
  }
  const gitRoot = gitRootResult.value;
  const head = headResult.status === "fulfilled" ? headResult.value : "UNBORN";
  const worktreeRoot = await realpath(resolve(gitRoot));
  if (!isInside(worktreeRoot, workspaceRoot)) {
    throw new Error("RALPH resolved a Git worktree outside the workspace.");
  }
  const workspacePath =
    relative(workspaceRoot, projectPath).replace(/\\/gu, "/") || ".";
  const source =
    normalizeComparablePath(worktreeRoot) ===
    normalizeComparablePath(workspaceRoot)
      ? "workspace"
      : "nested";
  const identity = {
    workspaceRoot: normalizeComparablePath(workspaceRoot),
    worktreeRoot: normalizeComparablePath(worktreeRoot),
  };

  return {
    workspaceRoot,
    projectRoot: projectPath,
    worktreeRoot,
    projectPath,
    workspacePath,
    source,
    head,
    digest: canonicalDigest(identity),
  };
};

export const assertRalphRepositoryContextUnchanged = (
  expected: RalphRepositoryContext,
  actual: RalphRepositoryContext,
): void => {
  if (expected.digest !== actual.digest) {
    throw new Error(
      `RALPH repository identity changed from ${expected.digest} to ${actual.digest}; refusing to resume in a different workspace or worktree.`,
    );
  }
};
