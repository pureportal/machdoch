import { resolveReadOnlyInspectionTarget } from "./task-inspection.js";
import { createTokenSet, tokenSetIncludesKeyword } from "./text.js";
import type { ToolDefinition, ToolName } from "./types.js";

const TOOL_REGISTRY: ToolDefinition[] = [
  {
    name: "filesystem",
    title: "Filesystem",
    description:
      "Read and modify files or folders inside allowed workspace boundaries.",
    riskLevel: "low",
    keywords: [
      "bug",
      "code",
      "edit",
      "file",
      "fix",
      "folder",
      "directory",
      "implement",
      "logic",
      "modify",
      "patch",
      "read",
      "refactor",
      "rename",
      "rewrite",
      "source",
      "write",
    ],
  },
  {
    name: "shell",
    title: "Shell",
    description:
      "Run shell commands, scripts, and terminal workflows on the local machine.",
    riskLevel: "high",
    keywords: [
      "build",
      "check",
      "command",
      "compile",
      "lint",
      "run",
      "script",
      "shell",
      "terminal",
      "test",
      "typecheck",
      "validate",
      "verify",
    ],
  },
  {
    name: "network",
    title: "Network",
    description:
      "Fetch APIs, web pages, and remote resources or submit outbound requests.",
    riskLevel: "medium",
    keywords: [
      "api",
      "http",
      "fetch",
      "download",
      "request",
      "research",
      "recent",
      "current",
      "latest",
      "documentation",
      "docs",
      "release notes",
      "url",
      "online",
      "internet",
      "web search",
      "weather",
      "forecast",
      "temperature",
      "current conditions",
    ],
  },
  {
    name: "browser",
    title: "Browser",
    description:
      "Control an interactive browser for screenshots, forms, clicks, and UI workflows.",
    riskLevel: "high",
    keywords: ["browser", "website", "web", "login", "click", "form"],
  },
  {
    name: "git",
    title: "Git",
    description:
      "Inspect and modify repository state, branches, commits, and diffs.",
    riskLevel: "medium",
    keywords: [
      "git",
      "commit",
      "branch",
      "changes",
      "diff",
      "pull request",
      "repo",
      "repository",
      "status",
      "worktree",
    ],
  },
  {
    name: "packages",
    title: "Packages",
    description:
      "Inspect package manifests, run package scripts, and install or update dependencies.",
    riskLevel: "high",
    keywords: [
      "install",
      "package",
      "packages",
      "dependency",
      "dependencies",
      "package.json",
      "npm",
      "pnpm",
      "yarn",
      "bun",
      "pip",
      "cargo",
    ],
  },
];

/**
 * Deduplicates tool names while preserving the first-seen order.
 */
const uniqueTools = (tools: ToolName[]): ToolName[] => {
  return Array.from(new Set(tools));
};

const CODE_CHANGE_TASK_PATTERN =
  /\b(add|build|change|code|debug|edit|fix|implement|improve|modify|patch|refactor|repair|rewrite)\b/i;

const needsWorkspaceEditAndVerification = (task: string): boolean => {
  return CODE_CHANGE_TASK_PATTERN.test(task);
};

/**
 * Returns a defensive copy of the built-in tool registry.
 */
export const getToolRegistry = (): ToolDefinition[] => {
  return TOOL_REGISTRY.map((tool) => ({
    ...tool,
    keywords: [...tool.keywords],
  }));
};

/**
 * Infers the most relevant tools for a task using keyword matches, with a
 * filesystem-and-shell fallback when nothing matches.
 */
export const inferSuggestedTools = (task: string): ToolName[] => {
  if (resolveReadOnlyInspectionTarget(task)) {
    return ["filesystem"];
  }

  const normalizedTask = task.toLowerCase();
  const taskTokens = createTokenSet(task);
  const matchedTools = TOOL_REGISTRY.flatMap((tool) =>
    tool.keywords.some((keyword) =>
      tokenSetIncludesKeyword(taskTokens, normalizedTask, keyword),
    )
      ? [tool.name]
      : [],
  );
  const inferredTools = needsWorkspaceEditAndVerification(task)
    ? uniqueTools(["filesystem", "shell", ...matchedTools])
    : matchedTools;

  if (inferredTools.length === 0) {
    return ["filesystem", "shell"];
  }

  return uniqueTools(inferredTools);
};

/**
 * Looks up a tool definition by its canonical tool name.
 */
export const getToolDefinition = (
  toolName: ToolName,
): ToolDefinition | undefined => {
  return TOOL_REGISTRY.find((tool) => tool.name === toolName);
};
