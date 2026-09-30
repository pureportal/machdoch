import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { TaskExecutionResult } from "../types.js";
import type { SessionGoal } from "../../shared/goals.js";

export const describeGoal = (goal: SessionGoal | null): string =>
  goal
    ? `Goal ${goal.status === "budget-limited" ? "limit reached" : goal.status}: ${goal.objective}\n${goal.turns} turns · ${goal.tokensUsed} tokens · ${Math.round(goal.elapsedMs / 1_000)}s${goal.turnBudget ? ` · turn limit ${goal.turnBudget}` : ""}${goal.tokenBudget ? ` · token limit ${goal.tokenBudget}` : ""}${goal.timeBudgetMs ? ` · time limit ${Math.round(goal.timeBudgetMs / 60_000)}m` : ""}${goal.reason ? `\n${goal.reason}` : ""}`
    : "No goal set.";

export const commandResult = (
  task: string,
  config: RuntimeConfig,
  summary: string,
  goal: SessionGoal | null,
  mode: "machdoch" | "native",
): TaskExecutionResult => ({
  task,
  mode: config.mode,
  status: "executed",
  summary,
  executedTools: [],
  outputSections: [],
  metadata: { goal, goalMode: mode, goalControlCommand: true },
});
