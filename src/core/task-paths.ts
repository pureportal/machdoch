import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { createTokenSet } from "./text.js";

const PATH_INSPECTION_ACTIONS = [
  "cat",
  "display",
  "explain",
  "inspect",
  "list",
  "ls",
  "open",
  "read",
  "show",
  "summarize",
  "view",
];

export interface TaskPathReference {
  requestedPath: string;
  resolvedPath: string;
  insideWorkspace: boolean;
  workspacePath?: string;
}

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

const extractQuotedPathCandidates = (
  task: string,
  workspaceRoot: string,
): string[] => {
  return Array.from(task.matchAll(/["'`]([^"'`]+)["'`]/g), (match) =>
    cleanPathCandidate(match[1] ?? ""),
  ).filter((candidate) => looksLikePathCandidate(candidate, workspaceRoot));
};

const extractInlinePathCandidates = (
  task: string,
  workspaceRoot: string,
): string[] => {
  return task
    .split(/\s+/)
    .map(cleanPathCandidate)
    .filter((candidate) => looksLikePathCandidate(candidate, workspaceRoot));
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

const createSegmentMatcher = (patternSegment: string): RegExp => {
  let output = "^";

  for (const character of patternSegment) {
    if (character === "*") {
      output += "[^/]*";
      continue;
    }

    if (character === "?") {
      output += "[^/]";
      continue;
    }

    output += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }

  output += "$";

  return new RegExp(output);
};

const segmentMatchCache = new Map<string, RegExp>();

const matchesPatternSegment = (
  patternSegment: string,
  pathSegment: string,
): boolean => {
  const cacheKey = patternSegment;
  const matcher =
    segmentMatchCache.get(cacheKey) ?? createSegmentMatcher(patternSegment);

  if (!segmentMatchCache.has(cacheKey)) {
    segmentMatchCache.set(cacheKey, matcher);
  }

  return matcher.test(pathSegment);
};

const splitGlobSegments = (value: string): string[] => {
  const normalized = normalizeRelativePath(value);

  return normalized.length === 0 ? [] : normalized.split("/");
};

const matchGlobSegments = (
  patternSegments: string[],
  pathSegments: string[],
  patternIndex: number,
  pathIndex: number,
  memo: Map<string, boolean>,
): boolean => {
  const memoKey = `${patternIndex}:${pathIndex}`;
  const cached = memo.get(memoKey);

  if (cached !== undefined) {
    return cached;
  }

  if (patternIndex === patternSegments.length) {
    const result = pathIndex === pathSegments.length;
    memo.set(memoKey, result);
    return result;
  }

  const patternSegment = patternSegments[patternIndex];

  if (patternSegment === undefined) {
    memo.set(memoKey, false);
    return false;
  }

  if (patternSegment === "**") {
    if (patternIndex === patternSegments.length - 1) {
      memo.set(memoKey, true);
      return true;
    }

    for (
      let nextPathIndex = pathIndex;
      nextPathIndex <= pathSegments.length;
      nextPathIndex += 1
    ) {
      if (
        matchGlobSegments(
          patternSegments,
          pathSegments,
          patternIndex + 1,
          nextPathIndex,
          memo,
        )
      ) {
        memo.set(memoKey, true);
        return true;
      }
    }

    memo.set(memoKey, false);
    return false;
  }

  const pathSegment = pathSegments[pathIndex];

  if (
    pathSegment === undefined ||
    !matchesPatternSegment(patternSegment, pathSegment)
  ) {
    memo.set(memoKey, false);
    return false;
  }

  const result = matchGlobSegments(
    patternSegments,
    pathSegments,
    patternIndex + 1,
    pathIndex + 1,
    memo,
  );

  memo.set(memoKey, result);
  return result;
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

    const resolvedPath = isAbsolute(candidate)
      ? resolve(candidate)
      : resolve(workspaceRoot, candidate);
    const insideWorkspace = isPathInsideWorkspace(workspaceRoot, resolvedPath);
    const dedupeKey = `${resolvedPath.toLowerCase()}::${candidate.toLowerCase()}`;

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);

    references.push({
      requestedPath: candidate,
      resolvedPath,
      insideWorkspace,
      ...(insideWorkspace
        ? {
            workspacePath: normalizeRelativePath(
              relative(workspaceRoot, resolvedPath),
            ),
          }
        : {}),
    });
  }

  return references;
};

/**
 * Returns the first explicit path reference when a task clearly asks to inspect
 * a file or directory.
 */
export const extractExplicitInspectionPathReference = (
  task: string,
  workspaceRoot: string,
): TaskPathReference | undefined => {
  const tokens = createTokenSet(task);

  if (!PATH_INSPECTION_ACTIONS.some((token) => tokens.has(token))) {
    return undefined;
  }

  return extractTaskPathReferences(task, workspaceRoot)[0];
};

/**
 * Matches a workspace-relative path against a workspace-root-relative glob.
 * Supports the common `*`, `**`, and `?` glob syntax used by instruction files.
 */
export const matchesWorkspaceGlob = (
  workspacePath: string,
  pattern: string,
): boolean => {
  const patternSegments = splitGlobSegments(pattern);
  const pathSegments = splitGlobSegments(workspacePath);

  if (patternSegments.length === 0) {
    return pathSegments.length === 0;
  }

  return matchGlobSegments(
    patternSegments,
    pathSegments,
    0,
    0,
    new Map<string, boolean>(),
  );
};
