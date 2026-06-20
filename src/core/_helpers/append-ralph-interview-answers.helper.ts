import type { RalphInputRequest, RalphInputValue, RalphInterviewState } from "../ralph.js";

export const appendRalphInterviewAnswers = (
  state: RalphInterviewState,
  request: Pick<RalphInputRequest, "fields">,
  values: Record<string, RalphInputValue>,
): RalphInterviewState => {
  return {
    turn: state.turn,
    transcript: [
      ...state.transcript,
      ...request.fields.map((field) => ({
        question: field.label,
        answer: values[field.id] ?? null,
        fieldId: field.id,
      })),
    ],
  };
};
