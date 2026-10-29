import type { RuntimeConfig } from "../runtime-contract.generated.js";
import type { TaskExecutionResult } from "../types.js";
import type { SessionGoal } from "../../shared/goals.js";

const BRIEF_OBJECTIVE_CHARS = 120;

// The first line names the goal well enough where the full text is shown elsewhere.
const briefObjective = (objective: string): string => {
  const trimmed = objective.trim();
  const firstLine = trimmed.split(/\r?\n/u)[0]?.trim() ?? "";
  const brief = firstLine.slice(0, BRIEF_OBJECTIVE_CHARS).trimEnd();
  return brief.length < trimmed.length ? `${brief}…` : brief;
};

export const describeGoal = (
  goal: SessionGoal | null,
  { brief = false }: { brief?: boolean } = {},
): string =>
  goal
    ? `Goal ${goal.status === "budget-limited" ? "limit reached" : goal.status}: ${brief ? briefObjective(goal.objective) : goal.objective}\n${goal.turns} turns · ${goal.tokensUsed} tokens · ${Math.round(goal.elapsedMs / 1_000)}s${goal.turnBudget ? ` · turn limit ${goal.turnBudget}` : ""}${goal.tokenBudget ? ` · token limit ${goal.tokenBudget}` : ""}${goal.timeBudgetMs ? ` · time limit ${Math.round(goal.timeBudgetMs / 60_000)}m` : ""}${goal.reason ? `\n${goal.reason}` : ""}`
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
