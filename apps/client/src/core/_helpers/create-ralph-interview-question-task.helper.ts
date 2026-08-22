import { stringifyRalphInputValue } from "./normalize-ralph-input-response-values.helper.js";
import type { RalphFlow, RalphInterviewBlock, RalphInterviewState } from "../ralph.js";

export interface RalphInterviewQuestionTaskInput {
  flow: Pick<RalphFlow, "name">;
  block: Pick<
    RalphInterviewBlock,
    "id" | "title" | "maxTurns" | "questionsPerTurn"
  >;
  goal: string;
  completionCriteria?: string;
  state: Pick<RalphInterviewState, "turn" | "transcript">;
}

export const createRalphInterviewQuestionTask = ({
  flow,
  block,
  goal,
  completionCriteria,
  state,
}: RalphInterviewQuestionTaskInput): string => {
  const maxTurns = block.maxTurns ?? 5;
  const questionsPerTurn = block.questionsPerTurn ?? 3;
  const transcript =
    state.transcript.length > 0
      ? state.transcript
          .map((entry, index) => {
            const answer =
              entry.answer === undefined || entry.answer === null
                ? "[skipped]"
                : stringifyRalphInputValue(entry.answer);

            return `${index + 1}. Q: ${entry.question}\n   A: ${answer}`;
          })
          .join("\n")
      : "No answers have been collected yet.";

  return [
    `Ralph flow: ${flow.name}`,
    `Interview block: ${block.title} (${block.id})`,
    "",
    "You are conducting an interactive clarification interview for this flow.",
    "Decide whether enough information has been collected. If not, ask concise, actionable questions.",
    "Every generated question must be skippable by the user.",
    "",
    `Interview goal:\n${goal}`,
    ...(completionCriteria
      ? ["", `Completion criteria:\n${completionCriteria}`]
      : []),
    "",
    `Current turn: ${state.turn} of ${maxTurns}`,
    `Ask at most ${questionsPerTurn} question${questionsPerTurn === 1 ? "" : "s"} this turn.`,
    "",
    "Prior answers:",
    transcript,
    "",
    "Return only JSON in this exact shape:",
    "{",
    '  "complete": false,',
    '  "summary": "Short summary when complete or why more information is needed.",',
    '  "questions": [',
    "    {",
    '      "id": "short_snake_case_id",',
    '      "label": "Question text shown to the user",',
    '      "type": "text | textarea | number | boolean | select | multiselect | url | path | file | files | image | images",',
    '      "placeholder": "Optional placeholder",',
    '      "help": "Optional help text",',
    '      "options": [{"value": "option_value", "label": "Option label"}]',
    "    }",
    "  ]",
    "}",
    "",
    "Use select or multiselect only when you provide options. Use textarea for open-ended answers.",
    "When complete is true, return an empty questions array and a useful implementation-ready summary.",
  ].join("\n");
};
