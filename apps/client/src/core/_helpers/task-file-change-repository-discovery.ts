import { existsSync } from "node:fs";
import { opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { mapWithConcurrencyLimit } from "./task-file-change-concurrency.js";
import { runTaskGitCommand } from "./task-git-command.js";

const DIRECTORY_READ_CONCURRENCY = 16;
const REPOSITORY_VALIDATION_CONCURRENCY = 8;
const DIRECTORY_BATCH_SIZE = 256;
const GIT_INSPECTION_TIMEOUT_MS = 30_000;
const MAX_SCAN_DIRECTORIES = 50_000;
const MAX_DIRECTORY_ENTRIES = 50_000;
const MAX_REPOSITORIES = 256;
const MAX_SCAN_ISSUES = 100;

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
  truncated?: boolean;
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
    const entries = await opendir(directoryPath);
    const childDirectories: string[] = [];
    let hasGitMarker = false;
    let count = 0;
    let truncated = false;

    for await (const entry of entries) {
      if (++count > MAX_DIRECTORY_ENTRIES) {
        truncated = true;
        break;
      }
      if (entry.name.toLowerCase() === ".git") {
        hasGitMarker = entry.isDirectory() || entry.isFile();
        continue;
      }

      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        childDirectories.push(join(directoryPath, entry.name));
      }
    }

    childDirectories.sort((left, right) => left.localeCompare(right));
    return { path: directoryPath, hasGitMarker, childDirectories, truncated };
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
  let scheduledDirectories = 1;
  let truncated = false;

  if (hasGitMarkerInAncestors(workspaceRoot)) {
    candidatesByPath.set(getPathKey(workspaceRoot), {
      path: workspaceRoot,
      source: "workspace",
    });
  }

  while (pendingDirectories.length > 0) {
    const batch = pendingDirectories.splice(0, DIRECTORY_BATCH_SIZE);
    const inspections = await mapWithConcurrencyLimit(
      batch,
      DIRECTORY_READ_CONCURRENCY,
      inspectDirectory,
    );

    for (const inspection of inspections) {
      if (inspection.error) {
        if (issues.length < MAX_SCAN_ISSUES)
          issues.push(
            `Could not scan ${relative(workspaceRoot, inspection.path) || "."}: ${inspection.error}`,
          );
        continue;
      }

      truncated ||= inspection.truncated ?? false;
      if (inspection.hasGitMarker) {
        const source =
          getPathKey(inspection.path) === getPathKey(workspaceRoot)
            ? "workspace"
            : "nested";
        if (
          candidatesByPath.size >= MAX_REPOSITORIES &&
          !candidatesByPath.has(getPathKey(inspection.path))
        ) {
          truncated = true;
        } else
          candidatesByPath.set(getPathKey(inspection.path), {
            path: inspection.path,
            source,
          });
      }

      for (const child of inspection.childDirectories) {
        if (scheduledDirectories >= MAX_SCAN_DIRECTORIES) {
          truncated = true;
          break;
        }
        pendingDirectories.push(child);
        scheduledDirectories += 1;
      }
    }
  }

  if (truncated)
    issues.push(
      "Repository discovery reached its directory, entry, or repository limit; some nested repositories may be missing.",
    );
  return { candidates: Array.from(candidatesByPath.values()), issues };
};

const runGitInspection = async (
  cwd: string,
  args: readonly string[],
): Promise<string> => {
  const result = await runTaskGitCommand(args, {
    cwd,
    timeoutMs: GIT_INSPECTION_TIMEOUT_MS,
    maxBufferBytes: 128 * 1024,
    normalizeOutput: false,
  });
  return result.stdout;
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
  const scan = await scanWorkspaceForRepositoryCandidates(
    normalizedWorkspaceRoot,
  );
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
