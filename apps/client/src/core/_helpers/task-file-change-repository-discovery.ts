import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mapWithConcurrencyLimit } from "./task-file-change-concurrency.js";

const DIRECTORY_READ_CONCURRENCY = 16;
const REPOSITORY_VALIDATION_CONCURRENCY = 8;
const DIRECTORY_BATCH_SIZE = 256;
const GIT_INSPECTION_TIMEOUT_MS = 30_000;

export interface DiscoveredGitRepository {
  root: string;
  captureRoot: string;
  workspacePath: string;
  source: "workspace" | "nested";
}

export interface GitRepositoryDiscoveryResult {
  workspaceRoot: string;
  repositories: DiscoveredGitRepository[];
  issues: string[];
}

interface RepositoryCandidate {
  path: string;
  source: "workspace" | "nested";
}

interface DirectoryInspection {
  path: string;
  hasGitMarker: boolean;
  childDirectories: string[];
  error?: string;
}

const isPathWithin = (parentPath: string, candidatePath: string): boolean => {
  const pathFromParent = relative(parentPath, candidatePath);

  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`))
  );
};

const getPathKey = (value: string): string => {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const hasGitMarkerInAncestors = (workspaceRoot: string): boolean => {
  let current = resolve(workspaceRoot);

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return true;
    }

    const parent = dirname(current);

    if (parent === current) {
      return false;
    }

    current = parent;
  }
};

const inspectDirectory = async (
  directoryPath: string,
): Promise<DirectoryInspection> => {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const childDirectories: string[] = [];
    let hasGitMarker = false;

    for (const entry of entries) {
      if (entry.name.toLowerCase() === ".git") {
        hasGitMarker = entry.isDirectory() || entry.isFile();
        continue;
      }

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        childDirectories.push(join(directoryPath, entry.name));
      }
    }

    childDirectories.sort((left, right) => left.localeCompare(right));
    return { path: directoryPath, hasGitMarker, childDirectories };
  } catch (error) {
    return {
      path: directoryPath,
      hasGitMarker: false,
      childDirectories: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const scanWorkspaceForRepositoryCandidates = async (
  workspaceRoot: string,
): Promise<{
  candidates: RepositoryCandidate[];
  issues: string[];
}> => {
  const candidatesByPath = new Map<string, RepositoryCandidate>();
  const issues: string[] = [];
  const pendingDirectories = [workspaceRoot];
  let offset = 0;

  if (hasGitMarkerInAncestors(workspaceRoot)) {
    candidatesByPath.set(getPathKey(workspaceRoot), {
      path: workspaceRoot,
      source: "workspace",
    });
  }

  while (offset < pendingDirectories.length) {
    const batch = pendingDirectories.slice(offset, offset + DIRECTORY_BATCH_SIZE);
    offset += batch.length;
    const inspections = await mapWithConcurrencyLimit(
      batch,
      DIRECTORY_READ_CONCURRENCY,
      inspectDirectory,
    );

    for (const inspection of inspections) {
      if (inspection.error) {
        issues.push(
          `Could not scan ${relative(workspaceRoot, inspection.path) || "."}: ${inspection.error}`,
        );
        continue;
      }

      if (inspection.hasGitMarker) {
        const source =
          getPathKey(inspection.path) === getPathKey(workspaceRoot)
            ? "workspace"
            : "nested";
        candidatesByPath.set(getPathKey(inspection.path), {
          path: inspection.path,
          source,
        });
      }

      pendingDirectories.push(...inspection.childDirectories);
    }
  }

  return { candidates: Array.from(candidatesByPath.values()), issues };
};

const runGitInspection = async (
  cwd: string,
  args: readonly string[],
): Promise<string> => {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(
      "git",
      ["--no-optional-locks", "-c", "core.quotePath=false", ...args],
      { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      rejectPromise(new Error("Git repository inspection timed out."));
    }, GIT_INSPECTION_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        rejectPromise(
          new Error(Buffer.concat(stderr).toString("utf8").trim() || `Git exited with ${code}.`),
        );
        return;
      }

      resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
};

const inspectGitRepository = async (
  candidate: RepositoryCandidate,
  workspaceRoot: string,
): Promise<DiscoveredGitRepository | undefined> => {
  const output = await runGitInspection(candidate.path, [
    "rev-parse",
    "--is-inside-work-tree",
    "--show-toplevel",
  ]);
  const outputLines = output.trimEnd().split(/\r?\n/u);
  const isInsideWorkTree = outputLines.shift()?.trim() === "true";
  const rawGitRoot = outputLines.join("\n").trim();

  if (!isInsideWorkTree || !rawGitRoot) {
    return undefined;
  }

  const [gitRoot, normalizedCandidate] = await Promise.all([
    realpath(rawGitRoot).catch(() => resolve(rawGitRoot)),
    realpath(candidate.path).catch(() => resolve(candidate.path)),
  ]);

  if (candidate.source === "workspace") {
    if (!isPathWithin(gitRoot, workspaceRoot)) {
      return undefined;
    }

    return {
      root: gitRoot,
      captureRoot: workspaceRoot,
      workspacePath: ".",
      source: "workspace",
    };
  }

  if (
    getPathKey(gitRoot) !== getPathKey(normalizedCandidate) ||
    !isPathWithin(workspaceRoot, gitRoot)
  ) {
    return undefined;
  }

  return {
    root: gitRoot,
    captureRoot: gitRoot,
    workspacePath: relative(workspaceRoot, gitRoot).replace(/\\/gu, "/") || ".",
    source: "nested",
  };
};

export const discoverWorkspaceGitRepositories = async (
  workspaceRoot: string,
): Promise<GitRepositoryDiscoveryResult> => {
  const normalizedWorkspaceRoot = await realpath(workspaceRoot).catch(() =>
    resolve(workspaceRoot),
  );
  const scan = await scanWorkspaceForRepositoryCandidates(normalizedWorkspaceRoot);
  const issues = [...scan.issues];
  const inspectedRepositories = await mapWithConcurrencyLimit(
    scan.candidates,
    REPOSITORY_VALIDATION_CONCURRENCY,
    async (candidate): Promise<DiscoveredGitRepository | undefined> => {
      try {
        return await inspectGitRepository(candidate, normalizedWorkspaceRoot);
      } catch (error) {
        issues.push(
          `Could not inspect ${relative(normalizedWorkspaceRoot, candidate.path) || "."}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return undefined;
      }
    },
  );
  const repositoriesByRoot = new Map<string, DiscoveredGitRepository>();

  for (const repository of inspectedRepositories) {
    if (!repository) {
      continue;
    }

    const key = getPathKey(repository.root);
    const existing = repositoriesByRoot.get(key);

    if (!existing || repository.source === "workspace") {
      repositoriesByRoot.set(key, repository);
    }
  }

  const repositories = Array.from(repositoriesByRoot.values()).sort(
    (left, right) => {
      if (left.workspacePath === ".") {
        return -1;
      }

      if (right.workspacePath === ".") {
        return 1;
      }

      return left.workspacePath.localeCompare(right.workspacePath);
    },
  );

  return {
    workspaceRoot: normalizedWorkspaceRoot,
    repositories,
    issues: Array.from(new Set(issues)),
  };
};
