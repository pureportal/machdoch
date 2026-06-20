import type { RunMode } from "../runtime-contract.generated.js";
import type { TaskExecutionResult } from "../types.js";
import type { RalphGenerationStructureValidation } from "./validate-generated-ralph-flow-structure.helper.js";

export const createLocalGenerationValidatorResult = (
  task: string,
  mode: RunMode,
  validation: RalphGenerationStructureValidation,
  durationMs: number,
): TaskExecutionResult => {
  const decisionLine = `RALPH_DECISION: ${validation.decision}`;
  const issueLines =
    validation.issues.length > 0
      ? validation.issues.map((issue) => `- ${issue}`)
      : ["No local structural issues found."];
  const warningLines =
    validation.warnings.length > 0
      ? ["Warnings:", ...validation.warnings.map((warning) => `- ${warning}`)]
      : [];

  return {
    task,
    mode,
    status: "executed",
    summary: `Local Ralph generation validator returned ${validation.decision}.`,
    executedTools: [],
    outputSections: [
      {
        title: "Local Ralph generation validator",
        lines: [
          `decision: ${validation.decision}`,
          `durationMs: ${durationMs}`,
          ...issueLines,
          ...warningLines,
        ],
      },
    ],
    response: {
      markdown: [...issueLines, ...warningLines, decisionLine].join("\n"),
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
    },
  };
};
