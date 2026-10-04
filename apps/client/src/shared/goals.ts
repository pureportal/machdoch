export type GoalMode = "machdoch" | "native";

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
  tokenBudget?: number;
  turnBudget?: number;
  timeBudgetMs?: number;
  reason: string;
  createdAt: number;
  updatedAt: number;
}

export const getAvailableGoalModes = (provider: string): readonly GoalMode[] =>
  provider === "claude-cli" || provider === "codex-cli"
    ? ["machdoch", "native"]
    : ["machdoch"];

export const resolveGoalMode = (
  provider: string,
  mode: GoalMode | undefined,
): GoalMode =>
  mode && getAvailableGoalModes(provider).includes(mode) ? mode : "machdoch";

const isNonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

export const isSessionGoal = (value: unknown): value is SessionGoal => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const goal = value as Record<string, unknown>;
  return (
    typeof goal.id === "string" &&
    goal.id.length > 0 &&
    typeof goal.objective === "string" &&
    goal.objective.trim().length > 0 &&
    goal.objective.length <= 4_000 &&
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
    typeof goal.reason === "string"
  );
};
