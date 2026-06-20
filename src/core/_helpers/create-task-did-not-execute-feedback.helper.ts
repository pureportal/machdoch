import type { TaskExecutionResult } from "../types.js";

export const createTaskDidNotExecuteFeedback = (
  actor: "generator" | "validator",
  result: TaskExecutionResult,
): string => {
  return `The Ralph ${actor} did not execute successfully (${result.status}): ${
    result.reason ?? result.summary
  }`;
};
