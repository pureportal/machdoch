import type { TaskExecutionResult } from "../types.js";

export const MAX_RALPH_RESULT_CHARS = 16_000;

const DECISION_LINE_PATTERN = /^\s*RALPH_DECISION\s*:\s*([A-Z0-9_-]+)\s*$/iu;

type RalphValidatorDecision = "DONE" | "CONTINUE" | "RETRY" | "ERROR";

export const truncateRalphResultText = (value: string): string => {
  if (value.length <= MAX_RALPH_RESULT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_RALPH_RESULT_CHARS)}\n[Ralph result truncated at ${MAX_RALPH_RESULT_CHARS} characters.]`;
};

export const getRalphResultMarkdown = (
  result: TaskExecutionResult | undefined,
): string => {
  return truncateRalphResultText(
    result?.response?.markdown ?? result?.summary ?? result?.reason ?? "",
  );
};

const parseFinalDecisionMarker = (
  result: TaskExecutionResult | undefined,
): string | undefined => {
  const markdown = getRalphResultMarkdown(result);
  const lines = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const match = lines.at(-1)?.match(DECISION_LINE_PATTERN);

  return match?.[1]?.toUpperCase();
};

export const parseLastRalphDecisionMarker = (
  result: TaskExecutionResult | undefined,
): string | undefined => {
  const markdown = getRalphResultMarkdown(result);
  const decisions = markdown
    .split(/\r?\n/u)
    .map((line) => line.trim().match(DECISION_LINE_PATTERN)?.[1]?.toUpperCase())
    .filter((decision): decision is string => Boolean(decision));

  return decisions.at(-1);
};

export const parseRalphDecision = (
  result: TaskExecutionResult,
): RalphValidatorDecision | undefined => {
  const decision = parseFinalDecisionMarker(result);

  return decision === "DONE" ||
    decision === "CONTINUE" ||
    decision === "RETRY" ||
    decision === "ERROR"
    ? decision
    : undefined;
};
