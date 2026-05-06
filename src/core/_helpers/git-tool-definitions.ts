import { realpath } from "node:fs/promises";
import { relative } from "node:path";
import {
  coerceInteger,
  coerceString,
  createToolErrorResult,
  isPathInsideWorkspace,
  normalizeWorkspacePath,
  resolveWorkspaceTarget,
  type AgentToolDefinition,
} from "./agent-tools-shared.js";
import {
  compactTraceText,
  createTextSection,
  limitText,
} from "./runtime-text.js";
import {
  executeLocalCommand,
  formatLocalCommandError,
  type LocalCommandResult,
} from "./process-execution.js";

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 1_000_000;
const DEFAULT_STATUS_ENTRIES = 40;
const DEFAULT_DIFF_FILES = 40;
const DEFAULT_LOG_COMMITS = 10;
const MAX_STATUS_ENTRIES = 200;
const MAX_DIFF_FILES = 200;
const MAX_LOG_COMMITS = 50;
const GIT_DIFF_NAME_STATUS_PATTERN = /^[A-Z?][0-9]*\s/u;

interface GitRepositoryContext {
  workspaceRoot: string;
  repoRoot: string;
}

export interface GitStatusSummary {
  branchLine?: string;
  entries: string[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  conflictedCount: number;
}

const coerceBoundedInteger = (
  args: Record<string, unknown>,
  field: string,
  defaultValue: number,
  maxValue: number,
): number | undefined => {
  const value = coerceInteger(args, field) ?? defaultValue;

  return value >= 1 && value <= maxValue ? value : undefined;
};

const coerceOptionalStringArray = (
  args: Record<string, unknown>,
  field: string,
): string[] | undefined => {
  const value = args[field];

  if (!Array.isArray(value)) {
    return undefined;
  }

  const strings = value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0
      ? [entry.trim()]
      : [],
  );

  return strings.length > 0 ? strings : undefined;
};

const runGitCommand = async (
  workspaceRoot: string,
  args: string[],
): Promise<LocalCommandResult> => {
  return executeLocalCommand("git", args, {
    cwd: workspaceRoot,
    timeoutMs: GIT_TIMEOUT_MS,
    maxBufferBytes: GIT_MAX_BUFFER_BYTES,
  });
};

const getGitRepositoryContext = async (
  workspaceRoot: string,
): Promise<GitRepositoryContext> => {
  let repoRoot: string;

  try {
    const result = await runGitCommand(workspaceRoot, [
      "rev-parse",
      "--show-toplevel",
    ]);

    repoRoot = await realpath(result.stdout);
  } catch (error) {
    throw new Error(
      `The workspace is not inside a readable Git repository, or Git is unavailable.\n${formatLocalCommandError("git rev-parse --show-toplevel failed", error)}`,
      { cause: error },
    );
  }

  const resolvedWorkspaceRoot = await realpath(workspaceRoot);

  if (!isPathInsideWorkspace(resolvedWorkspaceRoot, repoRoot)) {
    throw new Error(
      "The detected Git repository root is outside the active workspace boundary, so Git tooling is disabled for this run.",
    );
  }

  return {
    workspaceRoot: resolvedWorkspaceRoot,
    repoRoot,
  };
};

const resolveGitPathspecs = async (
  repository: GitRepositoryContext,
  requestedPaths: string[] | undefined,
): Promise<string[]> => {
  if (!requestedPaths) {
    return [];
  }

  const pathspecs: string[] = [];

  for (const requestedPath of requestedPaths) {
    const target = await resolveWorkspaceTarget(
      repository.workspaceRoot,
      requestedPath,
    );

    if (!target.insideWorkspace) {
      throw new Error(
        `Refusing Git path \`${requestedPath}\` because it resolves outside the workspace.`,
      );
    }

    if (!isPathInsideWorkspace(repository.repoRoot, target.resolvedPath)) {
      throw new Error(
        `Refusing Git path \`${requestedPath}\` because it is outside the detected repository root.`,
      );
    }

    pathspecs.push(
      normalizeWorkspacePath(relative(repository.repoRoot, target.resolvedPath))
        || ".",
    );
  }

  return pathspecs;
};

export const parseGitStatusPorcelain = (
  output: string,
): GitStatusSummary => {
  const lines = output
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
  let branchLine: string | undefined;
  const entries: string[] = [];
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  let conflictedCount = 0;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      branchLine = line.slice(3);
      continue;
    }

    const staged = line[0] ?? " ";
    const unstaged = line[1] ?? " ";
    entries.push(line);

    if (staged === "?" && unstaged === "?") {
      untrackedCount += 1;
      continue;
    }

    if (
      staged === "U" ||
      unstaged === "U" ||
      (staged === "A" && unstaged === "A") ||
      (staged === "D" && unstaged === "D")
    ) {
      conflictedCount += 1;
    }

    if (staged !== " " && staged !== "." && staged !== "?" && staged !== "!") {
      stagedCount += 1;
    }

    if (
      unstaged !== " " &&
      unstaged !== "." &&
      unstaged !== "?" &&
      unstaged !== "!"
    ) {
      unstagedCount += 1;
    }
  }

  return {
    ...(branchLine ? { branchLine } : {}),
    entries,
    stagedCount,
    unstagedCount,
    untrackedCount,
    conflictedCount,
  };
};

const createRepositorySection = (
  repository: GitRepositoryContext,
): { title: string; lines: string[] } => {
  return {
    title: "Git repository",
    lines: [
      `workspace root: ${repository.workspaceRoot}`,
      `repository root: ${repository.repoRoot}`,
    ],
  };
};

const createPathspecLines = (pathspecs: string[]): string[] => {
  return pathspecs.length > 0
    ? [`pathspecs: ${pathspecs.join(", ")}`]
    : ["pathspecs: whole repository"];
};

const limitLines = (lines: string[], maxEntries: number): string[] => {
  if (lines.length <= maxEntries) {
    return lines;
  }

  return [
    ...lines.slice(0, maxEntries),
    `... truncated after ${maxEntries} of ${lines.length} entries`,
  ];
};

export const createGitToolDefinitions = (): AgentToolDefinition[] => {
  return [
    {
      spec: {
        name: "get_git_status",
        description:
          "Inspect the current Git branch and working tree status using stable porcelain output. Use this before discussing repository cleanliness, staged changes, or commit readiness.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxEntries: {
              type: "integer",
              minimum: 1,
              maximum: MAX_STATUS_ENTRIES,
              description:
                "Maximum number of changed-path entries to include in the result.",
            },
          },
        },
      },
      backingTool: "git",
      riskLevel: "low",
      effect: "read",
      execute: async (args, context) => {
        const maxEntries = coerceBoundedInteger(
          args,
          "maxEntries",
          DEFAULT_STATUS_ENTRIES,
          MAX_STATUS_ENTRIES,
        );

        if (maxEntries === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "get_git_status",
            `Expected \`maxEntries\` to be an integer between 1 and ${MAX_STATUS_ENTRIES}.`,
          );
        }

        try {
          const repository = await getGitRepositoryContext(
            context.workspaceRoot,
          );
          const result = await runGitCommand(repository.workspaceRoot, [
            "status",
            "--porcelain=v1",
            "--branch",
            "--untracked-files=all",
          ]);
          const status = parseGitStatusPorcelain(result.stdout);
          const changedLines = limitLines(status.entries, maxEntries);
          const output = [
            `Branch: ${status.branchLine ?? "unknown"}`,
            `Changed paths: ${status.entries.length}`,
            `Staged: ${status.stagedCount}`,
            `Unstaged: ${status.unstagedCount}`,
            `Untracked: ${status.untrackedCount}`,
            `Conflicts: ${status.conflictedCount}`,
            changedLines.length > 0
              ? ["Entries:", ...changedLines].join("\n")
              : "Working tree is clean.",
          ].join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "get_git_status",
              output: limitText(output),
            },
            sections: [
              createRepositorySection(repository),
              {
                title: "Git status",
                lines: [
                  `branch: ${status.branchLine ?? "unknown"}`,
                  `changed paths: ${status.entries.length}`,
                  `staged: ${status.stagedCount}`,
                  `unstaged: ${status.unstagedCount}`,
                  `untracked: ${status.untrackedCount}`,
                  `conflicts: ${status.conflictedCount}`,
                ],
              },
              {
                title: "Changed paths",
                lines:
                  changedLines.length > 0
                    ? changedLines
                    : ["Working tree is clean."],
              },
            ],
            traceLines: [
              `get_git_status() -> ${status.entries.length} changed path${status.entries.length === 1 ? "" : "s"}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "get_git_status",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "get_git_diff_summary",
        description:
          "Inspect a concise Git diff summary for unstaged changes, staged changes, or changes against HEAD. Returns changed file names/statuses plus a diffstat without dumping full patches.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            scope: {
              type: "string",
              enum: ["unstaged", "staged", "head"],
              description:
                "Diff scope: unstaged working-tree changes, staged index changes, or all working-tree changes against HEAD.",
            },
            paths: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional workspace paths to limit the diff. Each path must stay inside the active Git repository.",
            },
            maxFiles: {
              type: "integer",
              minimum: 1,
              maximum: MAX_DIFF_FILES,
              description:
                "Maximum number of changed file status lines to include.",
            },
          },
        },
      },
      backingTool: "git",
      riskLevel: "low",
      effect: "read",
      execute: async (args, context) => {
        const scope = coerceString(args, "scope") ?? "unstaged";
        const maxFiles = coerceBoundedInteger(
          args,
          "maxFiles",
          DEFAULT_DIFF_FILES,
          MAX_DIFF_FILES,
        );

        if (!["unstaged", "staged", "head"].includes(scope)) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "get_git_diff_summary",
            "Expected `scope` to be one of `unstaged`, `staged`, or `head`.",
          );
        }

        if (maxFiles === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "get_git_diff_summary",
            `Expected \`maxFiles\` to be an integer between 1 and ${MAX_DIFF_FILES}.`,
          );
        }

        try {
          const repository = await getGitRepositoryContext(
            context.workspaceRoot,
          );
          const pathspecs = await resolveGitPathspecs(
            repository,
            coerceOptionalStringArray(args, "paths"),
          );
          const diffArgs = [
            "diff",
            "--no-color",
            "--name-status",
            "--stat",
            ...(scope === "staged" ? ["--cached"] : []),
            ...(scope === "head" ? ["HEAD"] : []),
            ...(pathspecs.length > 0 ? ["--", ...pathspecs] : []),
          ];
          const result = await runGitCommand(repository.workspaceRoot, diffArgs);
          const lines = result.stdout
            .split("\n")
            .filter((line) => line.trim().length > 0);
          const statusLines = lines.filter((line) =>
            GIT_DIFF_NAME_STATUS_PATTERN.test(line),
          );
          const displayedStatusLines = limitLines(statusLines, maxFiles);
          const statLines = lines.filter(
            (line) => !GIT_DIFF_NAME_STATUS_PATTERN.test(line),
          );
          const output = [
            `Scope: ${scope}`,
            ...createPathspecLines(pathspecs),
            displayedStatusLines.length > 0
              ? ["Changed files:", ...displayedStatusLines].join("\n")
              : "No changed files in this diff scope.",
            statLines.length > 0
              ? ["Diffstat:", ...statLines].join("\n")
              : undefined,
          ]
            .filter((part): part is string => typeof part === "string")
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "get_git_diff_summary",
              output: limitText(output),
            },
            sections: [
              createRepositorySection(repository),
              {
                title: "Git diff request",
                lines: [`scope: ${scope}`, ...createPathspecLines(pathspecs)],
              },
              {
                title: "Changed files",
                lines:
                  displayedStatusLines.length > 0
                    ? displayedStatusLines
                    : ["No changed files in this diff scope."],
              },
              ...(statLines.length > 0
                ? [
                    {
                      title: "Diffstat",
                      lines: statLines,
                    },
                  ]
                : []),
            ],
            traceLines: [
              `get_git_diff_summary(${scope}) -> ${statusLines.length} changed file${statusLines.length === 1 ? "" : "s"}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "get_git_diff_summary",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "get_git_log",
        description:
          "Inspect recent Git commit history with one-line hashes, decorations, relative dates, and subjects.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxCommits: {
              type: "integer",
              minimum: 1,
              maximum: MAX_LOG_COMMITS,
              description: "Maximum number of commits to return.",
            },
            paths: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional workspace paths to limit history. Each path must stay inside the active Git repository.",
            },
          },
        },
      },
      backingTool: "git",
      riskLevel: "low",
      effect: "read",
      execute: async (args, context) => {
        const maxCommits = coerceBoundedInteger(
          args,
          "maxCommits",
          DEFAULT_LOG_COMMITS,
          MAX_LOG_COMMITS,
        );

        if (maxCommits === undefined) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "get_git_log",
            `Expected \`maxCommits\` to be an integer between 1 and ${MAX_LOG_COMMITS}.`,
          );
        }

        try {
          const repository = await getGitRepositoryContext(
            context.workspaceRoot,
          );
          const pathspecs = await resolveGitPathspecs(
            repository,
            coerceOptionalStringArray(args, "paths"),
          );
          const logArgs = [
            "log",
            `--max-count=${maxCommits}`,
            "--decorate=short",
            "--date=relative",
            "--pretty=format:%h %d %cr %s",
            ...(pathspecs.length > 0 ? ["--", ...pathspecs] : []),
          ];
          const result = await runGitCommand(repository.workspaceRoot, logArgs);
          const lines = result.stdout
            .split("\n")
            .filter((line) => line.trim().length > 0);
          const output = [
            `Max commits: ${maxCommits}`,
            ...createPathspecLines(pathspecs),
            lines.length > 0
              ? ["Recent commits:", ...lines].join("\n")
              : "No commits matched the request.",
          ].join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "get_git_log",
              output: limitText(output),
            },
            sections: [
              createRepositorySection(repository),
              {
                title: "Git log request",
                lines: [
                  `max commits: ${maxCommits}`,
                  ...createPathspecLines(pathspecs),
                ],
              },
              {
                title: "Recent commits",
                lines: lines.length > 0 ? lines : ["No commits matched."],
              },
            ],
            traceLines: [
              `get_git_log(${maxCommits}) -> ${lines.length} commit${lines.length === 1 ? "" : "s"}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "get_git_log",
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      spec: {
        name: "create_git_commit",
        description:
          "Create a local Git commit. If paths are provided, stage only those workspace paths first; otherwise commit the current index exactly as staged. This never pushes to remotes.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            message: {
              type: "string",
              description: "Commit message to pass as `git commit -m`.",
            },
            paths: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional workspace paths to stage before committing. Omit to commit already staged changes only.",
            },
          },
          required: ["message"],
        },
      },
      backingTool: "git",
      riskLevel: "medium",
      effect: "write",
      execute: async (args, context) => {
        const message = coerceString(args, "message");

        if (!message) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_git_commit",
            "Expected a non-empty `message`.",
          );
        }

        if (message.length > 2_000) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_git_commit",
            "The commit message is too long for this tool.",
          );
        }

        try {
          const repository = await getGitRepositoryContext(
            context.workspaceRoot,
          );
          const pathspecs = await resolveGitPathspecs(
            repository,
            coerceOptionalStringArray(args, "paths"),
          );

          if (pathspecs.length > 0) {
            await runGitCommand(repository.workspaceRoot, [
              "add",
              "--",
              ...pathspecs,
            ]);
          }

          const commitResult = await runGitCommand(repository.workspaceRoot, [
            "commit",
            "-m",
            message,
          ]);
          const hashResult = await runGitCommand(repository.workspaceRoot, [
            "rev-parse",
            "--short",
            "HEAD",
          ]);
          const output = [
            `Created commit: ${hashResult.stdout}`,
            `Message: ${message}`,
            ...createPathspecLines(pathspecs),
            commitResult.stdout || commitResult.stderr,
          ]
            .filter((part) => part.trim().length > 0)
            .join("\n");

          return {
            toolResult: {
              callId: crypto.randomUUID(),
              name: "create_git_commit",
              output: limitText(output),
            },
            sections: [
              createRepositorySection(repository),
              {
                title: "Git commit",
                lines: [
                  `commit: ${hashResult.stdout}`,
                  `message: ${message}`,
                  ...createPathspecLines(pathspecs),
                ],
              },
              createTextSection(
                "Commit output",
                commitResult.stdout || commitResult.stderr || "(no output)",
              ),
            ],
            traceLines: [
              `create_git_commit(${compactTraceText(message)}) -> ${hashResult.stdout}`,
            ],
          };
        } catch (error) {
          return createToolErrorResult(
            crypto.randomUUID(),
            "create_git_commit",
            formatLocalCommandError("git commit failed", error),
          );
        }
      },
    },
  ];
};
