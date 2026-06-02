import { createTokenSet, tokenSetHasAny } from "./text.js";

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

const CUSTOMIZATION_TARGET_MATCHERS = [
  ["instructions", INSTRUCTION_TARGET_TOKENS],
  ["prompts", PROMPT_TARGET_TOKENS],
  ["skills", SKILL_TARGET_TOKENS],
] as const satisfies ReadonlyArray<
  readonly [
    Extract<ReadOnlyInspectionTarget, "instructions" | "prompts" | "skills">,
    ReadonlySet<string>,
  ]
>;

const PRIORITIZED_TARGET_MATCHERS = [
  ["profiles", PROFILE_TARGET_TOKENS],
  ["tools", TOOL_TARGET_TOKENS],
  ["runtime-config", CONFIG_TARGET_TOKENS],
  ["workspace", WORKSPACE_TARGET_TOKENS],
] as const satisfies ReadonlyArray<
  readonly [
    Exclude<
      ReadOnlyInspectionTarget,
      "customizations" | "instructions" | "prompts" | "skills"
    >,
    ReadonlySet<string>,
  ]
>;

const collectMatchingTargets = <Target extends string>(
  tokens: ReadonlySet<string>,
  matchers: ReadonlyArray<readonly [Target, ReadonlySet<string>]>,
): Target[] => {
  const matchedTargets: Target[] = [];

  for (const [target, targetTokens] of matchers) {
    if (tokenSetHasAny(tokens, targetTokens)) {
      matchedTargets.push(target);
    }
  }

  return matchedTargets;
};

const resolveFirstMatchingTarget = <Target extends string>(
  tokens: ReadonlySet<string>,
  matchers: ReadonlyArray<readonly [Target, ReadonlySet<string>]>,
): Target | undefined => {
  for (const [target, targetTokens] of matchers) {
    if (tokenSetHasAny(tokens, targetTokens)) {
      return target;
    }
  }

  return undefined;
};

/**
 * Detects whether a task is a safe, read-only inspection request that can be
 * satisfied deterministically without model-driven execution.
 */
export const resolveReadOnlyInspectionTarget = (
  task: string,
): ReadOnlyInspectionTarget | undefined => {
  const tokens = createTokenSet(task);

  if (!tokenSetHasAny(tokens, READ_ONLY_ACTION_TOKENS)) {
    return undefined;
  }

  if (tokenSetHasAny(tokens, MUTATION_HINT_TOKENS)) {
    return undefined;
  }

  const customizationTargets = collectMatchingTargets(
    tokens,
    CUSTOMIZATION_TARGET_MATCHERS,
  );

  if (
    customizationTargets.length > 1 ||
    tokenSetHasAny(tokens, CUSTOMIZATION_TARGET_TOKENS)
  ) {
    return "customizations";
  }

  if (customizationTargets.length === 1) {
    return customizationTargets[0];
  }

  return resolveFirstMatchingTarget(tokens, PRIORITIZED_TARGET_MATCHERS);
};
