import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { normalizeLocalCommandCwd } from "./process-execution.js";

export interface RalphGitChangedFileSnapshot {
  path: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  deleted: boolean;
  worktreeHash?: string;
  indexOid?: string;
  signature: string;
}

export interface RalphGitChangeSnapshot {
  cwd: string;
  root: string;
  head: string;
  capturedAt: string;
  status: string;
  changedFiles: string[];
  diffStat: string;
  stagedDiffStat: string;
  diffFiles: string[];
  stagedDiffFiles: string[];
  files: RalphGitChangedFileSnapshot[];
}

export interface RalphGitChangeSnapshotOptions {
  cwd: string;
  workspaceRoot: string;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

const splitNulOutput = (value: string): string[] => {
  return value.split("\0").filter((entry) => entry.length > 0);
};

const normalizeWorkspaceRelativePath = (
  path: string,
  workspaceRoot: string,
): string => {
  const relativePath = isAbsolute(path)
    ? relative(resolve(workspaceRoot), resolve(path))
    : path;

  return relativePath.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
};

interface PorcelainV1StatusEntry {
  path: string;
  gitPath: string;
  status: string;
  indexStatus: string;
  worktreeStatus: string;
}

const runGitCommand = async (
  args: string[],
  options: RalphGitChangeSnapshotOptions,
  cwd = options.cwd,
): Promise<string> => {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-optional-locks", ...args], {
      cwd: normalizeLocalCommandCwd(cwd),
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      ...(options.signal ? { signal: options.signal } : {}),
      windowsHide: true,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }

      resolve(stdout);
    });
  });
};

const parsePorcelainV1ZStatus = (
  statusText: string,
  gitRoot: string,
  workspaceRoot: string,
): PorcelainV1StatusEntry[] => {
  const entries = splitNulOutput(statusText);
  const parsed: PorcelainV1StatusEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    if (entry === undefined || entry.length < 4) {
      continue;
    }

    const status = entry.slice(0, 2);
    const gitPath = entry.slice(3);
    const path = normalizeWorkspaceRelativePath(resolve(gitRoot, gitPath), workspaceRoot);

    parsed.push({
      path,
      gitPath,
      status,
      indexStatus: status[0] ?? " ",
      worktreeStatus: status[1] ?? " ",
    });

    if (status[0] === "R" || status[0] === "C") {
      index += 1;
    }
  }

  return parsed;
};

const readWorktreeHash = async (path: string): Promise<string | undefined> => {
  if (!existsSync(path)) {
    return undefined;
  }

  const pathStat = await stat(path);

  if (!pathStat.isFile()) {
    return undefined;
  }

  return createHash("sha256").update(await readFile(path)).digest("hex");
};

const readIndexOid = async (
  path: string,
  options: RalphGitChangeSnapshotOptions,
): Promise<string | undefined> => {
  const output = await runGitCommand(["ls-files", "--stage", "-z", "--", path], options);
  const firstEntry = splitNulOutput(output)[0];
  const match = firstEntry?.match(/^\d+\s+([0-9a-f]{40,64})\s+\d+\t/u);

  return match?.[1];
};

const createFileSignature = (
  file: Omit<RalphGitChangedFileSnapshot, "signature">,
): string => {
  return [
    `status=${file.status}`,
    `index=${file.indexOid ?? "missing"}`,
    `worktree=${file.worktreeHash ?? "missing"}`,
  ].join(";");
};

const createChangedFileSnapshot = async (
  entry: ReturnType<typeof parsePorcelainV1ZStatus>[number],
  options: RalphGitChangeSnapshotOptions,
  gitRoot: string,
): Promise<RalphGitChangedFileSnapshot> => {
  const absolutePath = resolve(gitRoot, entry.gitPath);
  const worktreeHash = await readWorktreeHash(absolutePath);
  const indexOid = await readIndexOid(entry.gitPath, options);
  const indexChanged = entry.indexStatus !== " " && entry.indexStatus !== "?";
  const worktreeChanged = entry.worktreeStatus !== " " && entry.worktreeStatus !== "?";
  const untracked = entry.indexStatus === "?" && entry.worktreeStatus === "?";
  const deleted = entry.indexStatus === "D" || entry.worktreeStatus === "D";
  const file: Omit<RalphGitChangedFileSnapshot, "signature"> = {
    path: entry.path,
    status: entry.status,
    indexStatus: entry.indexStatus,
    worktreeStatus: entry.worktreeStatus,
    staged: indexChanged,
    unstaged: worktreeChanged,
    untracked,
    deleted,
    ...(worktreeHash ? { worktreeHash } : {}),
    ...(indexOid ? { indexOid } : {}),
  };

  return {
    ...file,
    signature: createFileSignature(file),
  };
};

export const collectRalphGitChangeSnapshot = async (
  options: RalphGitChangeSnapshotOptions,
): Promise<RalphGitChangeSnapshot> => {
  const rawRoot = (await runGitCommand(["rev-parse", "--show-toplevel"], options))
    .trim();
  const [root, workspaceRoot] = await Promise.all([
    realpath(rawRoot).catch(() => resolve(rawRoot)),
    realpath(options.workspaceRoot).catch(() => resolve(options.workspaceRoot)),
  ]);
  const rootOptions: RalphGitChangeSnapshotOptions = { ...options, cwd: root };
  const [head, statusText, diffStat, diffNames, stagedDiffStat, stagedDiffNames] =
    await Promise.all([
      runGitCommand(["rev-parse", "--short", "HEAD"], rootOptions),
      runGitCommand(["status", "--porcelain=v1", "-z", "-uall"], rootOptions),
      runGitCommand(["diff", "--stat"], rootOptions),
      runGitCommand(["diff", "--name-only", "-z"], rootOptions),
      runGitCommand(["diff", "--cached", "--stat"], rootOptions),
      runGitCommand(["diff", "--cached", "--name-only", "-z"], rootOptions),
    ]);
  const files = await Promise.all(
    parsePorcelainV1ZStatus(statusText, root, workspaceRoot).map((entry) =>
      createChangedFileSnapshot(entry, rootOptions, root),
    ),
  );
  const changedFiles = files.map((file) => file.path);

  return {
    cwd: options.cwd,
    root,
    head: head.trim(),
    capturedAt: new Date().toISOString(),
    status: files.map((file) => `${file.status} ${file.path}`).join("\n"),
    changedFiles,
    diffStat: diffStat.trim(),
    stagedDiffStat: stagedDiffStat.trim(),
    diffFiles: splitNulOutput(diffNames).map((path) =>
      normalizeWorkspaceRelativePath(resolve(root, path), workspaceRoot),
    ),
    stagedDiffFiles: splitNulOutput(stagedDiffNames).map((path) =>
      normalizeWorkspaceRelativePath(resolve(root, path), workspaceRoot),
    ),
    files,
  };
};
