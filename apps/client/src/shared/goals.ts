import { getDiscoveredProviderFeature } from "@machdoch/model-runtime/model-capabilities";

export type GoalMode = "machdoch" | "native";

export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;

export const isGoalCommand = (task: string): boolean =>
  /^\/goal(?:\s|$)/u.test(task.trim());

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "budget-limited"
  | "complete";

export interface SessionGoal {
  id: string;
  objective: string;
  mode: GoalMode;
  status: GoalStatus;
  turns: number;
  tokensUsed: number;
  elapsedMs: number;
  costUsd?: number;
  tokenBudget?: number;
  turnBudget?: number;
  timeBudgetMs?: number;
  costBudgetUsd?: number;
  /** Requirements the last check verified, out of those it listed. */
  verifiedRequirements?: number;
  totalRequirements?: number;
  reason: string;
  createdAt: number;
  updatedAt: number;
}

// A provider CLI probe can rule native goals out (e.g. a Claude CLI without `/goal`).
export const getAvailableGoalModes = (provider: string): readonly GoalMode[] =>
  (provider === "claude-cli" || provider === "codex-cli") &&
  getDiscoveredProviderFeature(provider, "nativeGoal") !== false
    ? ["machdoch", "native"]
    : ["machdoch"];

export const resolveGoalMode = (
  provider: string,
  mode: GoalMode | undefined,
): GoalMode =>
  mode && getAvailableGoalModes(provider).includes(mode) ? mode : "machdoch";

const isNonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const isNonnegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export const isSessionGoal = (value: unknown): value is SessionGoal => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const goal = value as Record<string, unknown>;
  return (
    typeof goal.id === "string" &&
    goal.id.length > 0 &&
    typeof goal.objective === "string" &&
    goal.objective.trim().length > 0 &&
    goal.objective.length <= MAX_GOAL_OBJECTIVE_CHARS &&
    (goal.mode === "machdoch" || goal.mode === "native") &&
    typeof goal.status === "string" &&
    ["active", "paused", "blocked", "budget-limited", "complete"].includes(
      goal.status,
    ) &&
    ["turns", "tokensUsed", "elapsedMs", "createdAt", "updatedAt"].every(
      (key) => isNonnegativeInteger(goal[key]),
    ) &&
    ["tokenBudget", "turnBudget", "timeBudgetMs"].every(
      (key) =>
        goal[key] === undefined ||
        (isNonnegativeInteger(goal[key]) && (goal[key] as number) > 0),
    ) &&
    ["verifiedRequirements", "totalRequirements"].every(
      (key) => goal[key] === undefined || isNonnegativeInteger(goal[key]),
    ) &&
    (goal.costUsd === undefined || isNonnegativeNumber(goal.costUsd)) &&
    (goal.costBudgetUsd === undefined ||
      (isNonnegativeNumber(goal.costBudgetUsd) && goal.costBudgetUsd > 0)) &&
    typeof goal.reason === "string"
  );
};
