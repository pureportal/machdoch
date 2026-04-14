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
    keywords: ["file", "folder", "directory", "read", "write", "rename"],
  },
  {
    name: "shell",
    title: "Shell",
    description:
      "Run shell commands, scripts, and terminal workflows on the local machine.",
    riskLevel: "high",
    keywords: ["command", "terminal", "shell", "script", "run"],
  },
  {
    name: "network",
    title: "Network",
    description:
      "Fetch APIs, web pages, and remote resources or submit outbound requests.",
    riskLevel: "medium",
    keywords: ["api", "http", "fetch", "download", "request", "url"],
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
    keywords: ["git", "commit", "branch", "pull request", "repo"],
  },
  {
    name: "packages",
    title: "Packages",
    description:
      "Install or update npm, pnpm, pip, cargo, or other package manager dependencies.",
    riskLevel: "high",
    keywords: ["install", "package", "npm", "pnpm", "pip", "cargo"],
  },
];

/**
 * Deduplicates tool names while preserving the first-seen order.
 */
const uniqueTools = (tools: ToolName[]): ToolName[] => {
  return Array.from(new Set(tools));
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

  if (matchedTools.length === 0) {
    return ["filesystem", "shell"];
  }

  return uniqueTools(matchedTools);
};

/**
 * Looks up a tool definition by its canonical tool name.
 */
export const getToolDefinition = (
  toolName: ToolName,
): ToolDefinition | undefined => {
  return TOOL_REGISTRY.find((tool) => tool.name === toolName);
};
