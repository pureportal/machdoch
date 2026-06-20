import { isRalphVariableName } from "./normalize-ralph-input-response-values.helper.js";
import type { RalphInterviewBlock } from "../ralph.js";

export const getDefaultRalphInterviewOutputVariableName = (
  block: Pick<RalphInterviewBlock, "id">,
): string => {
  return `${block.id.replace(/[^A-Za-z0-9_]+/gu, "_")}_interview`;
};

export const getRalphInterviewOutputVariableName = (
  block: Pick<RalphInterviewBlock, "id" | "outputVariableName">,
): string => {
  const configured = block.outputVariableName?.trim();

  return configured && isRalphVariableName(configured)
    ? configured
    : getDefaultRalphInterviewOutputVariableName(block);
};
