import type {
  RalphFlowVariable,
  RalphValidationIssue,
  RalphValidationResult,
} from "../ralph.js";

export const RALPH_FLOW_SCHEMA_VERSION = 1;

export const addRalphValidationIssue = (
  issues: RalphValidationIssue[],
  code: string,
  message: string,
  context: Pick<RalphValidationIssue, "blockId" | "edgeId"> = {},
): void => {
  issues.push({ code, message, ...context });
};

export const createValidationResult = (
  errorIssues: RalphValidationIssue[],
  warningIssues: RalphValidationIssue[] = [],
  variables: RalphFlowVariable[] = [],
): RalphValidationResult => {
  return {
    valid: errorIssues.length === 0,
    errors: errorIssues.map((issue) => issue.message),
    warnings: warningIssues.map((issue) => issue.message),
    errorIssues,
    warningIssues,
    variables,
  };
};
