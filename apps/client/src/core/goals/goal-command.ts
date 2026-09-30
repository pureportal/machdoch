import type { GoalMode } from "../../shared/goals.js";

export type GoalCommand =
  | { kind: "status" | "pause" | "resume" | "clear" }
  | { kind: "mode"; mode: GoalMode }
  | {
      kind: "set";
      objective: string;
      tokenBudget?: number;
      turnBudget?: number;
      timeBudgetMs?: number;
    };

export const parseGoalCommand = (task: string): GoalCommand | undefined => {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(task.trim());
  if (!match) return undefined;
  let remaining = (match[1] ?? "").trim();
  if (!remaining) return { kind: "status" };
  if (["pause", "resume", "clear"].includes(remaining)) {
    return { kind: remaining as "pause" | "resume" | "clear" };
  }
  if (/^mode(?:\s|$)/u.test(remaining)) {
    const mode = remaining.slice(4).trim();
    if (mode !== "machdoch" && mode !== "native") {
      throw new Error("Use /goal mode machdoch or /goal mode native.");
    }
    return { kind: "mode", mode };
  }
  const budgets: Pick<
    Extract<GoalCommand, { kind: "set" }>,
    "tokenBudget" | "turnBudget" | "timeBudgetMs"
  > = {};
  while (remaining.startsWith("--")) {
    if (/^--(?:\s|$)/u.test(remaining)) {
      remaining = remaining.slice(2).trim();
      break;
    }
    const option = /^--(tokens|turns|minutes)\s+(\d+)(?:\s+|$)/u.exec(
      remaining,
    );
    if (!option)
      throw new Error(
        "Use /goal [--tokens N] [--turns N] [--minutes N] <objective>.",
      );
    const value = Number(option[2]);
    const key =
      option[1] === "tokens"
        ? "tokenBudget"
        : option[1] === "turns"
          ? "turnBudget"
          : "timeBudgetMs";
    const budget = key === "timeBudgetMs" ? value * 60_000 : value;
    if (
      !Number.isSafeInteger(budget) ||
      budget <= 0 ||
      budgets[key] !== undefined
    ) {
      throw new Error("Goal limits must be positive integers and appear once.");
    }
    budgets[key] = budget;
    remaining = remaining.slice(option[0].length).trim();
  }
  if (!remaining || remaining.length > 4_000) {
    throw new Error("Enter a goal between 1 and 4,000 characters.");
  }
  return { kind: "set", objective: remaining, ...budgets };
};
