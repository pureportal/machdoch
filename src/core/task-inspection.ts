import { createTokenSet } from "./text.js";

export type ReadOnlyInspectionTarget =
  | "workspace"
  | "runtime-config"
  | "tools"
  | "profiles"
  | "instructions"
  | "prompts"
  | "skills"
  | "customizations";

const READ_ONLY_ACTION_TOKENS = new Set([
  "describe",
  "explain",
  "inspect",
  "list",
  "scan",
  "show",
  "summarize",
  "summary",
  "view",
]);

const MUTATION_HINT_TOKENS = new Set([
  "apply",
  "change",
  "commit",
  "create",
  "delete",
  "edit",
  "fix",
  "install",
  "modify",
  "push",
  "remove",
  "rename",
  "replace",
  "run",
  "update",
  "write",
]);

const WORKSPACE_TARGET_TOKENS = new Set([
  "project",
  "repo",
  "repository",
  "setup",
  "structure",
  "workspace",
]);

const CONFIG_TARGET_TOKENS = new Set([
  "compatibility",
  "config",
  "configuration",
  "offline",
  "provider",
  "providers",
  "settings",
]);

const TOOL_TARGET_TOKENS = new Set([
  "permission",
  "permissions",
  "policies",
  "policy",
  "tool",
  "tools",
]);

const PROFILE_TARGET_TOKENS = new Set(["profile", "profiles"]);
const INSTRUCTION_TARGET_TOKENS = new Set(["instruction", "instructions"]);
const PROMPT_TARGET_TOKENS = new Set(["prompt", "prompts"]);
const SKILL_TARGET_TOKENS = new Set(["skill", "skills"]);
const CUSTOMIZATION_TARGET_TOKENS = new Set([
  "customisation",
  "customisations",
  "customization",
  "customizations",
]);

const hasAnyToken = (
  tokens: ReadonlySet<string>,
  candidates: ReadonlySet<string>,
): boolean => {
  for (const candidate of candidates) {
    if (tokens.has(candidate)) {
      return true;
    }
  }

  return false;
};

const collectCustomizationTargets = (
  tokens: ReadonlySet<string>,
): Array<
  Extract<ReadOnlyInspectionTarget, "instructions" | "prompts" | "skills">
> => {
  const matchedTargets: Array<
    Extract<ReadOnlyInspectionTarget, "instructions" | "prompts" | "skills">
  > = [];

  if (hasAnyToken(tokens, INSTRUCTION_TARGET_TOKENS)) {
    matchedTargets.push("instructions");
  }

  if (hasAnyToken(tokens, PROMPT_TARGET_TOKENS)) {
    matchedTargets.push("prompts");
  }

  if (hasAnyToken(tokens, SKILL_TARGET_TOKENS)) {
    matchedTargets.push("skills");
  }

  return matchedTargets;
};

/**
 * Detects whether a task is a safe, read-only inspection request that can be
 * satisfied deterministically without model-driven execution.
 */
export const resolveReadOnlyInspectionTarget = (
  task: string,
): ReadOnlyInspectionTarget | undefined => {
  const tokens = createTokenSet(task);

  if (!hasAnyToken(tokens, READ_ONLY_ACTION_TOKENS)) {
    return undefined;
  }

  if (hasAnyToken(tokens, MUTATION_HINT_TOKENS)) {
    return undefined;
  }

  const customizationTargets = collectCustomizationTargets(tokens);

  if (
    customizationTargets.length > 1 ||
    hasAnyToken(tokens, CUSTOMIZATION_TARGET_TOKENS)
  ) {
    return "customizations";
  }

  if (customizationTargets.length === 1) {
    return customizationTargets[0];
  }

  if (hasAnyToken(tokens, PROFILE_TARGET_TOKENS)) {
    return "profiles";
  }

  if (hasAnyToken(tokens, TOOL_TARGET_TOKENS)) {
    return "tools";
  }

  if (hasAnyToken(tokens, CONFIG_TARGET_TOKENS)) {
    return "runtime-config";
  }

  if (hasAnyToken(tokens, WORKSPACE_TARGET_TOKENS)) {
    return "workspace";
  }

  return undefined;
};
