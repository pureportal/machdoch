import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  AgentModelToolResult,
  AgentModelToolSpec,
  ConversationMemoryEntry,
  TaskExecutionMemoryUpdate,
  TaskExecutionSection,
  ToolName,
  ToolRiskLevel,
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

export const resolveWorkspaceTarget = (
  workspaceRoot: string,
  requestedPath: string,
): WorkspaceTarget => {
  const resolvedPath = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(workspaceRoot, requestedPath);
  const insideWorkspace = isPathInsideWorkspace(workspaceRoot, resolvedPath);

  return {
    requestedPath,
    resolvedPath,
    insideWorkspace,
    ...(insideWorkspace
      ? {
          workspacePath: normalizeWorkspacePath(
            relative(workspaceRoot, resolvedPath),
          ),
        }
      : {}),
  };
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
  directoryPath: string,
  files: string[],
): Promise<string[]> => {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = resolve(directoryPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_SEARCH_DIRECTORIES.has(entry.name)) {
        continue;
      }

      await createSearchScope(fullPath, files);
      continue;
    }

    files.push(fullPath);
  }

  return files;
};
