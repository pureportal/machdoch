import type { RalphValidationResult } from "../ralph.js";
import { createGenerationFeedbackExcerpt } from "./create-generation-feedback-excerpt.helper.js";

export const createGenerationDidNotConvergeSummary = (
  maxRounds: number,
  validation: RalphValidationResult,
  validatorFeedback: string | undefined,
): string => {
  const details: string[] = [];

  if (!validation.valid && validation.errors.length > 0) {
    details.push(`Last schema error: ${validation.errors[0]}`);
  }

  const feedback = createGenerationFeedbackExcerpt(validatorFeedback);

  if (feedback) {
    details.push(`Last feedback: ${feedback}`);
  }

  return [
    `Ralph flow generation did not converge after ${maxRounds} round(s).`,
    ...details,
  ].join(" ");
};
