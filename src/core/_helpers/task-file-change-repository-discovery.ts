import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { mapWithConcurrencyLimit } from "./task-file-change-concurrency.js";

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_REPOSITORIES = 16;
const DEFAULT_MAX_DIRECTORIES = 2_000;
const DEFAULT_TIME_BUDGET_MS = 1_000;
const DIRECTORY_READ_CONCURRENCY = 8;
const REPOSITORY_VALIDATION_CONCURRENCY = 4;
const GIT_INSPECTION_TIMEOUT_MS = 3_000;
const GIT_INSPECTION_MAX_BYTES = 64 * 1024;
const DEFAULT_IGNORED_DIRECTORY_NAMES = [
  ".cache",
  ".pnpm-store",
  ".venv",
  ".yarn",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
] as const;

export interface DiscoveredGitRepository {
  root: string;
  captureRoot: string;
  workspacePath: string;
  source: "workspace" | "nested";
}

export interface GitRepositoryDiscoveryResult {
  workspaceRoot: string;
  repositories: DiscoveredGitRepository[];
  warnings: string[];
  truncated: boolean;
}

export interface GitRepositoryDiscoveryOptions {
  maxDepth?: number;
  maxRepositories?: number;
  maxDirectories?: number;
  timeBudgetMs?: number;
  ignoredDirectoryNames?: readonly string[];
}

interface RepositoryCandidate {
  path: string;
  source: "workspace" | "nested";
}

interface DirectoryInspection {
  path: string;
  hasGitMarker: boolean;
  childDirectories: string[];
  readable: boolean;
}

interface RepositoryScanResult {
  candidates: RepositoryCandidate[];
  warnings: string[];
  truncated: boolean;
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

const getBoundedInteger = (
  value: number | undefined,
  fallback: number,
  minimum: number,
): number => {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.floor(value));
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
  ignoredDirectoryNames: ReadonlySet<string>,
): Promise<DirectoryInspection> => {
  try {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const childDirectories: string[] = [];
    let hasGitMarker = false;

    for (const entry of entries) {
      const normalizedName = entry.name.toLowerCase();

      if (normalizedName === ".git") {
        hasGitMarker = entry.isDirectory() || entry.isFile();
        continue;
      }

      if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !ignoredDirectoryNames.has(normalizedName)
      ) {
        childDirectories.push(join(directoryPath, entry.name));
      }
    }

    childDirectories.sort((left, right) => left.localeCompare(right));
    return {
      path: directoryPath,
      hasGitMarker,
      childDirectories,
      readable: true,
    };
  } catch {
    return {
      path: directoryPath,
      hasGitMarker: false,
      childDirectories: [],
      readable: false,
    };
  }
};

const scanWorkspaceForRepositoryCandidates = async (
  workspaceRoot: string,
  options: GitRepositoryDiscoveryOptions,
): Promise<RepositoryScanResult> => {
  const maxDepth = getBoundedInteger(
    options.maxDepth,
    DEFAULT_MAX_DEPTH,
    0,
  );
  const maxRepositories = getBoundedInteger(
    options.maxRepositories,
    DEFAULT_MAX_REPOSITORIES,
    1,
  );
  const maxDirectories = getBoundedInteger(
    options.maxDirectories,
    DEFAULT_MAX_DIRECTORIES,
    1,
  );
  const timeBudgetMs = getBoundedInteger(
    options.timeBudgetMs,
    DEFAULT_TIME_BUDGET_MS,
    1,
  );
  const ignoredDirectoryNames = new Set(
    (options.ignoredDirectoryNames ?? DEFAULT_IGNORED_DIRECTORY_NAMES).map(
      (name) => name.toLowerCase(),
    ),
  );
  const candidateByPath = new Map<string, RepositoryCandidate>();
  const warnings: string[] = [];
  const startedAt = Date.now();
  let frontier = [workspaceRoot];
  let visitedDirectories = 0;
  let truncated = false;
  let hadUnreadableDirectory = false;

  if (hasGitMarkerInAncestors(workspaceRoot)) {
    candidateByPath.set(getPathKey(workspaceRoot), {
      path: workspaceRoot,
      source: "workspace",
    });
  }

  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth += 1) {
    if (Date.now() - startedAt >= timeBudgetMs) {
      truncated = true;
      warnings.push("Repository discovery reached its time limit.");
      break;
    }

    const remainingDirectoryCapacity = maxDirectories - visitedDirectories;

    if (remainingDirectoryCapacity <= 0) {
      truncated = true;
      warnings.push("Repository discovery reached its directory limit.");
      break;
    }

    const directories = frontier.slice(0, remainingDirectoryCapacity);

    if (directories.length < frontier.length) {
      truncated = true;
      warnings.push("Repository discovery reached its directory limit.");
    }

    visitedDirectories += directories.length;
    const inspections = await mapWithConcurrencyLimit(
      directories,
      DIRECTORY_READ_CONCURRENCY,
      (directoryPath) =>
        inspectDirectory(directoryPath, ignoredDirectoryNames),
    );
    const nextFrontier: string[] = [];

    for (const inspection of inspections) {
      if (!inspection.readable) {
        hadUnreadableDirectory = true;
        continue;
      }

      if (inspection.hasGitMarker) {
        const source =
          getPathKey(inspection.path) === getPathKey(workspaceRoot)
            ? "workspace"
            : "nested";

        if (candidateByPath.size < maxRepositories) {
          candidateByPath.set(getPathKey(inspection.path), {
            path: inspection.path,
            source,
          });
        } else if (!candidateByPath.has(getPathKey(inspection.path))) {
          truncated = true;
        }
      }

      if (depth < maxDepth) {
        nextFrontier.push(...inspection.childDirectories);
      }
    }

    if (candidateByPath.size >= maxRepositories && nextFrontier.length > 0) {
      truncated = true;
      warnings.push("Repository discovery reached its repository limit.");
      break;
    }

    frontier = nextFrontier;
  }

  if (hadUnreadableDirectory) {
    warnings.push("Some workspace folders could not be scanned for repositories.");
  }

  return {
    candidates: Array.from(candidateByPath.values()),
    warnings: Array.from(new Set(warnings)),
    truncated,
  };
};

const inspectGitRepository = async (
  candidate: RepositoryCandidate,
  workspaceRoot: string,
): Promise<DiscoveredGitRepository | undefined> => {
  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.quotePath=false",
        "rev-parse",
        "--is-inside-work-tree",
        "--show-toplevel",
      ],
      {
        cwd: candidate.path,
        encoding: "utf8",
        maxBuffer: GIT_INSPECTION_MAX_BYTES,
        timeout: GIT_INSPECTION_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          rejectPromise(error);
          return;
        }

        resolvePromise(stdout);
      },
    );
  });
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
  options: GitRepositoryDiscoveryOptions = {},
): Promise<GitRepositoryDiscoveryResult> => {
  const normalizedWorkspaceRoot = await realpath(workspaceRoot).catch(() =>
    resolve(workspaceRoot),
  );
  const scan = await scanWorkspaceForRepositoryCandidates(
    normalizedWorkspaceRoot,
    options,
  );
  let hadValidationFailure = false;
  const inspectedRepositories = await mapWithConcurrencyLimit(
    scan.candidates,
    REPOSITORY_VALIDATION_CONCURRENCY,
    async (candidate) => {
      try {
        return await inspectGitRepository(candidate, normalizedWorkspaceRoot);
      } catch {
        hadValidationFailure = true;
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

  const warnings = [...scan.warnings];

  if (hadValidationFailure) {
    warnings.push("Some Git repository candidates could not be inspected.");
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
    warnings: Array.from(new Set(warnings)),
    truncated: scan.truncated,
  };
};
