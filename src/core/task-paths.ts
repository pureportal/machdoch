import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createTokenSet, tokenSetHasAny } from "./text.js";

const PATH_INSPECTION_ACTION_TOKENS = new Set([
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
]);

const CREATE_FILE_ACTION_TOKENS = new Set([
  "add",
  "create",
  "generate",
  "make",
  "touch",
  "write",
]);

const CREATE_FILE_OBJECT_TOKENS = new Set([
  "document",
  "file",
  "note",
  "notes",
]);

const CREATE_FILE_DISALLOWED_TOKENS = new Set([
  "append",
  "commit",
  "delete",
  "edit",
  "fix",
  "install",
  "modify",
  "move",
  "push",
  "remove",
  "rename",
  "replace",
  "run",
  "update",
]);

const FILE_TYPE_EXTENSION_HINTS: ReadonlyArray<
  readonly [keyword: string, extension: string]
> = [
  ["markdown", "md"],
  ["md", "md"],
  ["json", "json"],
  ["typescript", "ts"],
  ["ts", "ts"],
  ["javascript", "js"],
  ["js", "js"],
  ["html", "html"],
  ["css", "css"],
  ["yaml", "yaml"],
  ["yml", "yml"],
  ["toml", "toml"],
  ["text", "txt"],
  ["txt", "txt"],
];

const GENERIC_FILE_NAME_TOKENS = new Set([
  "blank",
  "document",
  "dummy",
  "empty",
  "file",
  "json",
  "markdown",
  "new",
  "note",
  "sample",
  "simple",
  "stub",
  "temp",
  "temporary",
  "text",
  "toml",
  "ts",
  "typescript",
  "yaml",
  "yml",
]);

export interface TaskPathReference {
  requestedPath: string;
  resolvedPath: string;
  insideWorkspace: boolean;
  workspacePath?: string;
}

export interface CreateFilePathReference extends TaskPathReference {
  inferredPath: boolean;
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
    Array.from(task.matchAll(/["'`]([^"'`]+)["'`]/g), (match) =>
      match[1] ?? "",
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

const resolvePathWithinExistingTree = (absolutePath: string): string => {
  if (existsSync(absolutePath)) {
    return realpathSync.native(absolutePath);
  }

  const missingSegments: string[] = [];
  let currentPath = absolutePath;

  while (!existsSync(currentPath)) {
    const parentPath = dirname(currentPath);

    if (parentPath === currentPath) {
      return absolutePath;
    }

    missingSegments.unshift(basename(currentPath));
    currentPath = parentPath;
  }

  const resolvedBasePath = realpathSync.native(currentPath);

  return missingSegments.reduce(
    (path, segment) => resolve(path, segment),
    resolvedBasePath,
  );
};

const resolveWorkspacePathReference = (
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

const getFirstTaskPathReference = (
  task: string,
  workspaceRoot: string,
): TaskPathReference | undefined => {
  return extractTaskPathReferences(task, workspaceRoot)[0];
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

  if (!tokenSetHasAny(tokens, PATH_INSPECTION_ACTION_TOKENS)) {
    return undefined;
  }

  return getFirstTaskPathReference(task, workspaceRoot);
};

const inferCreateFileExtension = (task: string): string => {
  const tokens = createTokenSet(task);

  for (const [keyword, extension] of FILE_TYPE_EXTENSION_HINTS) {
    if (tokens.has(keyword)) {
      return extension;
    }
  }

  return "txt";
};

const extractNamedCreateFileCandidate = (task: string): string | undefined => {
  const match = task.match(
    /\b(?:named|called)\s+["'`]?([A-Za-z0-9_./\\-]+)["'`]?/iu,
  );
  const candidate = cleanPathCandidate(match?.[1] ?? "");

  return candidate.length > 0 ? candidate : undefined;
};

const extractDerivedCreateFileBaseName = (task: string): string | undefined => {
  const match = task.match(
    /\b(?:add|create|generate|make|touch|write)\b(?:\s+(?:a|an))?\s+([A-Za-z0-9_-]+)\s+file\b/iu,
  );
  const candidate = cleanPathCandidate(match?.[1] ?? "").toLowerCase();

  if (candidate.length === 0 || GENERIC_FILE_NAME_TOKENS.has(candidate)) {
    return undefined;
  }

  return candidate;
};

const resolveDefaultCreateFileCandidate = (
  task: string,
): string | undefined => {
  const tokens = createTokenSet(task);

  if (!tokenSetHasAny(tokens, CREATE_FILE_OBJECT_TOKENS)) {
    return undefined;
  }

  const extension = inferCreateFileExtension(task);
  const derivedBaseName = extractDerivedCreateFileBaseName(task);

  if (derivedBaseName) {
    return `${derivedBaseName}.${extension}`;
  }

  if (tokens.has("test")) {
    return `test.${extension}`;
  }

  return `untitled.${extension}`;
};

const resolveCreateFileCandidate = (
  task: string,
  workspaceRoot: string,
): { candidate: string; inferredPath: boolean } | undefined => {
  const explicitPathReference = getFirstTaskPathReference(task, workspaceRoot);

  if (explicitPathReference) {
    return {
      candidate: explicitPathReference.requestedPath,
      inferredPath: false,
    };
  }

  const namedPathCandidate = extractNamedCreateFileCandidate(task);

  if (namedPathCandidate) {
    return {
      candidate: namedPathCandidate,
      inferredPath: false,
    };
  }

  const fallbackCandidate = resolveDefaultCreateFileCandidate(task);

  if (!fallbackCandidate) {
    return undefined;
  }

  return {
    candidate: fallbackCandidate,
    inferredPath: true,
  };
};

/**
 * Returns a deterministic create-file target for narrow workspace write tasks
 * like `create a test file` or `create notes.txt`.
 */
export const resolveDeterministicCreateFileTarget = (
  task: string,
  workspaceRoot: string,
): CreateFilePathReference | undefined => {
  const tokens = createTokenSet(task);

  if (!tokenSetHasAny(tokens, CREATE_FILE_ACTION_TOKENS)) {
    return undefined;
  }

  if (tokenSetHasAny(tokens, CREATE_FILE_DISALLOWED_TOKENS)) {
    return undefined;
  }

  const createFileCandidate = resolveCreateFileCandidate(task, workspaceRoot);

  if (!createFileCandidate) {
    return undefined;
  }

  return {
    ...resolveWorkspacePathReference(
      workspaceRoot,
      createFileCandidate.candidate,
    ),
    inferredPath: createFileCandidate.inferredPath,
  };
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
