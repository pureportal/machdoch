import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
export { matchesWorkspaceGlob } from "./_helpers/workspace-glob-matching.helper.js";

export interface TaskPathReference {
  requestedPath: string;
  resolvedPath: string;
  insideWorkspace: boolean;
  workspacePath?: string;
}

export type CreateFilePathReference = TaskPathReference;

const cleanPathCandidate = (value: string): string => {
  return value
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/^[([{]+|[)\].,:;!?]+$/g, "");
};

const looksLikePathCandidate = (
  value: string,
  workspaceRoot: string,
): boolean => {
  if (value.length === 0) {
    return false;
  }

  const resolvedPath = isAbsolute(value)
    ? resolve(value)
    : resolve(workspaceRoot, value);

  return (
    value.includes("/") ||
    value.includes("\\") ||
    /^\.[A-Za-z0-9._-]+$/.test(value) ||
    /^[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+$/.test(value) ||
    existsSync(resolvedPath)
  );
};

const collectPathCandidates = (
  candidates: Iterable<string>,
  workspaceRoot: string,
): string[] => {
  return Array.from(candidates, (candidate) => cleanPathCandidate(candidate))
    .filter((candidate) => candidate.length > 0)
    .filter((candidate) => looksLikePathCandidate(candidate, workspaceRoot));
};

const extractQuotedPathCandidates = (
  task: string,
  workspaceRoot: string,
): string[] => {
  return collectPathCandidates(
    Array.from(
      task.matchAll(/["'`]([^"'`]+)["'`]/g),
      (match) => match[1] ?? "",
    ),
    workspaceRoot,
  );
};

const extractInlinePathCandidates = (
  task: string,
  workspaceRoot: string,
): string[] => {
  return collectPathCandidates(task.split(/\s+/), workspaceRoot);
};

const normalizeRelativePath = (value: string): string => {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/g, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");

  return normalized === "." ? "" : normalized;
};

const isPathInsideWorkspace = (
  workspaceRoot: string,
  candidatePath: string,
): boolean => {
  const relativePath = relative(workspaceRoot, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const pathExistsOrIsLink = (path: string): boolean => {
  if (existsSync(path)) {
    return true;
  }

  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const resolveExistingPath = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const stats = lstatSync(path);

    if (!stats.isSymbolicLink()) {
      throw error;
    }

    const linkTarget = resolve(dirname(path), readlinkSync(path));

    return pathExistsOrIsLink(linkTarget)
      ? realpathSync.native(linkTarget)
      : linkTarget;
  }
};

const resolvePathWithinExistingTree = (absolutePath: string): string => {
  if (pathExistsOrIsLink(absolutePath)) {
    return resolveExistingPath(absolutePath);
  }

  const missingSegments: string[] = [];
  let currentPath = absolutePath;

  while (!pathExistsOrIsLink(currentPath)) {
    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return absolutePath;
    }

    missingSegments.unshift(basename(currentPath));
    currentPath = parentPath;
  }

  const resolvedBasePath = resolveExistingPath(currentPath);

  return missingSegments.reduce(
    (path, segment) => resolve(path, segment),
    resolvedBasePath,
  );
};

export const resolveWorkspacePathReference = (
  workspaceRoot: string,
  candidate: string,
): TaskPathReference => {
  const unresolvedPath = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(workspaceRoot, candidate);
  const resolvedWorkspaceRoot = existsSync(workspaceRoot)
    ? realpathSync.native(workspaceRoot)
    : resolve(workspaceRoot);

  try {
    const resolvedPath = resolvePathWithinExistingTree(unresolvedPath);
    const insideWorkspace = isPathInsideWorkspace(
      resolvedWorkspaceRoot,
      resolvedPath,
    );

    return {
      requestedPath: candidate,
      resolvedPath,
      insideWorkspace,
      ...(insideWorkspace
        ? {
            workspacePath: normalizeRelativePath(
              relative(resolvedWorkspaceRoot, resolvedPath),
            ),
          }
        : {}),
    };
  } catch {
    const insideWorkspace = isPathInsideWorkspace(
      resolvedWorkspaceRoot,
      unresolvedPath,
    );

    return {
      requestedPath: candidate,
      resolvedPath: unresolvedPath,
      insideWorkspace,
      ...(insideWorkspace
        ? {
            workspacePath: normalizeRelativePath(
              relative(resolvedWorkspaceRoot, unresolvedPath),
            ),
          }
        : {}),
    };
  }
};

/**
 * Extracts path-like references from a task string and resolves them relative to
 * the workspace when possible.
 */
export const extractTaskPathReferences = (
  task: string,
  workspaceRoot: string,
): TaskPathReference[] => {
  const seen = new Set<string>();
  const references: TaskPathReference[] = [];

  for (const candidate of [
    ...extractQuotedPathCandidates(task, workspaceRoot),
    ...extractInlinePathCandidates(task, workspaceRoot),
  ]) {
    if (candidate.length === 0) {
      continue;
    }

    const reference = resolveWorkspacePathReference(workspaceRoot, candidate);
    const dedupeKey = `${reference.resolvedPath.toLowerCase()}::${candidate.toLowerCase()}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);

    references.push(reference);
  }

  return references;
};
