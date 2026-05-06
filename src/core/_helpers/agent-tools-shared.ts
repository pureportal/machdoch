import { existsSync } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  AgentModelToolResult,
  AgentModelToolSpec,
  ConversationMemoryEntry,
  TaskExecutionMemoryUpdate,
  TaskExecutionSection,
  ToolCallEffect,
  ToolName,
  ToolRiskLevel,
  UiControlRuntimeInfo,
} from "../types.js";

export const MAX_DIRECTORY_ENTRIES = 60;
export const MAX_SEARCH_RESULTS = 25;
export const MAX_TEXT_FILE_BYTES = 1_000_000;
export const SHELL_TIMEOUT_MS = 30_000;
const IGNORED_SEARCH_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "target",
]);

export interface WorkspaceTarget {
  requestedPath: string;
  resolvedPath: string;
  insideWorkspace: boolean;
  workspacePath?: string;
}

export interface ConversationMemoryRuntime {
  sessionEnabled: boolean;
  sessionEntries: ConversationMemoryEntry[];
  globalEnabled: boolean;
  globalEntries: ConversationMemoryEntry[];
}

export interface AgentToolExecutionContext {
  workspaceRoot: string;
  memory: ConversationMemoryRuntime;
  uiControl?: UiControlRuntimeInfo;
}

export interface AgentToolExecutionResult {
  toolResult: AgentModelToolResult;
  sections: TaskExecutionSection[];
  traceLines: string[];
  memoryUpdate?: TaskExecutionMemoryUpdate;
}

export interface AgentToolDefinition {
  spec: AgentModelToolSpec;
  backingTool: ToolName;
  riskLevel: ToolRiskLevel;
  effect: ToolCallEffect;
  isReadOnlyInPlanMode?: (args: Record<string, unknown>) => boolean;
  execute: (
    args: Record<string, unknown>,
    context: AgentToolExecutionContext,
  ) => Promise<AgentToolExecutionResult>;
}

export const normalizeWorkspacePath = (value: string): string => {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\//u, "")
    .replace(/^\/+/u, "")
    .replace(/\/+/gu, "/")
    .replace(/\/$/u, "");

  return normalized === "." ? "" : normalized;
};

export const isPathInsideWorkspace = (
  workspaceRoot: string,
  candidatePath: string,
): boolean => {
  const relativePath = relative(workspaceRoot, candidatePath);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath))
  );
};

const resolvePathWithinExistingTree = async (
  absolutePath: string,
): Promise<string> => {
  if (existsSync(absolutePath)) {
    return realpath(absolutePath);
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

  const resolvedBasePath = await realpath(currentPath);

  return missingSegments.reduce(
    (path, segment) => resolve(path, segment),
    resolvedBasePath,
  );
};

export const resolveWorkspaceTarget = async (
  workspaceRoot: string,
  requestedPath: string,
): Promise<WorkspaceTarget> => {
  const unresolvedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, requestedPath);

  try {
    const resolvedWorkspaceRoot = await realpath(workspaceRoot);
    const resolvedPath = await resolvePathWithinExistingTree(unresolvedPath);
    const insideWorkspace = isPathInsideWorkspace(
      resolvedWorkspaceRoot,
      resolvedPath,
    );

    return {
      requestedPath,
      resolvedPath,
      insideWorkspace,
      ...(insideWorkspace
        ? {
            workspacePath: normalizeWorkspacePath(
              relative(resolvedWorkspaceRoot, resolvedPath),
            ),
          }
        : {}),
    };
  } catch {
    return {
      requestedPath,
      resolvedPath: unresolvedPath,
      insideWorkspace: false,
    };
  }
};

export const isBinaryBuffer = (buffer: Buffer): boolean => {
  return buffer.includes(0);
};

export const coerceString = (
  record: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = record[field];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
};

export const coerceBoolean = (
  record: Record<string, unknown>,
  field: string,
): boolean | undefined => {
  const value = record[field];

  return typeof value === "boolean" ? value : undefined;
};

export const coerceInteger = (
  record: Record<string, unknown>,
  field: string,
): number | undefined => {
  const value = record[field];

  return typeof value === "number" && Number.isInteger(value)
    ? value
    : undefined;
};

export const createToolErrorResult = (
  callId: string,
  name: string,
  message: string,
  sections: TaskExecutionSection[] = [],
): AgentToolExecutionResult => {
  return {
    toolResult: {
      callId,
      name,
      output: message,
      isError: true,
    },
    sections,
    traceLines: [`${name}: ${message}`],
  };
};

export const stripHtmlToText = (html: string): string => {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/giu, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/giu, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
};

export const createSearchScope = async (
  workspaceRoot: string,
  directoryPath: string,
  files: string[],
  visitedDirectories: Set<string> = new Set(),
  seenFiles: Set<string> = new Set(),
): Promise<string[]> => {
  const directoryTarget = await resolveWorkspaceTarget(
    workspaceRoot,
    directoryPath,
  );

  if (!directoryTarget.insideWorkspace) {
    return files;
  }

  if (visitedDirectories.has(directoryTarget.resolvedPath)) {
    return files;
  }

  visitedDirectories.add(directoryTarget.resolvedPath);

  const entries = await readdir(directoryTarget.resolvedPath, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_SEARCH_DIRECTORIES.has(entry.name)) {
      continue;
    }

    const fullPath = resolve(directoryTarget.resolvedPath, entry.name);
    const target = await resolveWorkspaceTarget(workspaceRoot, fullPath);

    if (!target.insideWorkspace) {
      continue;
    }

    if (entry.isDirectory()) {
      await createSearchScope(
        workspaceRoot,
        target.resolvedPath,
        files,
        visitedDirectories,
        seenFiles,
      );
      continue;
    }

    if (entry.isSymbolicLink()) {
      try {
        const targetStats = await stat(target.resolvedPath);

        if (targetStats.isDirectory()) {
          await createSearchScope(
            workspaceRoot,
            target.resolvedPath,
            files,
            visitedDirectories,
            seenFiles,
          );
          continue;
        }

        if (!targetStats.isFile()) {
          continue;
        }
      } catch {
        continue;
      }
    } else {
      try {
        const targetStats = await lstat(target.resolvedPath);

        if (!targetStats.isFile()) {
          continue;
        }
      } catch {
        continue;
      }
    }

    if (seenFiles.has(target.resolvedPath)) {
      continue;
    }

    seenFiles.add(target.resolvedPath);
    files.push(target.resolvedPath);
  }

  return files;
};
