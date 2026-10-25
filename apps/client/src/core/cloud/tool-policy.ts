import type { AgentToolDefinition } from "../_helpers/agent-tools-shared.js";
import { createUtilityToolDefinitions } from "../_helpers/utility-tool-definitions.js";

const filesystem = new Set([
  "list_directory",
  "read_file",
  "search_workspace",
  "create_file",
  "replace_in_file",
  "read_chat_history",
  "search_chat_history",
]);
const git = new Set([
  "get_git_status",
  "get_git_diff_summary",
  "get_git_log",
  "create_git_commit",
]);
const shell = new Set(["run_shell_command", "start_detached_command"]);
const utilities = new Set(
  createUtilityToolDefinitions().map((definition) => definition.spec.name),
);

export function cloudTaskToolPolicy(definition: AgentToolDefinition): boolean {
  switch (definition.backingTool) {
    case "filesystem":
      return filesystem.has(definition.spec.name);
    case "git":
      return git.has(definition.spec.name);
    case "shell":
      return shell.has(definition.spec.name);
    case "packages":
      return definition.effect === "read";
    case "utilities":
      return utilities.has(definition.spec.name);
    default:
      return false;
  }
}
