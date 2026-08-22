import type { TaskExecutionResult } from "../types.js";
import { createGenerationFeedbackExcerpt } from "./create-generation-feedback-excerpt.helper.js";

export type RalphGenerationActor = "generator" | "validator";

export const createGenerationActorResultMessage = (
  actor: RalphGenerationActor,
  result: TaskExecutionResult,
): string => {
  const summary = createGenerationFeedbackExcerpt(result.reason ?? result.summary);

  return result.status === "executed"
    ? `Ralph ${actor} completed.`
    : `Ralph ${actor} returned ${result.status}${summary ? `: ${summary}` : "."}`;
};
