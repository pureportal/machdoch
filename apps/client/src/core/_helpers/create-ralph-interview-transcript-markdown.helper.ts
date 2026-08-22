import { stringifyRalphInputValue } from "./normalize-ralph-input-response-values.helper.js";
import type { RalphInterviewState } from "../ralph.js";

export const createRalphInterviewTranscriptMarkdown = (
  state: Pick<RalphInterviewState, "transcript">,
): string => {
  if (state.transcript.length === 0) {
    return "No interview answers were collected.";
  }

  return state.transcript
    .map((entry, index) => {
      const answer =
        entry.answer === undefined || entry.answer === null
          ? "_Skipped_"
          : stringifyRalphInputValue(entry.answer);

      return `${index + 1}. ${entry.question}\n\n   ${answer}`;
    })
    .join("\n\n");
};
