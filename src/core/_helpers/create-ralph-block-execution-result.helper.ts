import {
  getRalphResultMarkdown,
  parseLastRalphDecisionMarker,
  parseRalphDecision,
} from "./parse-ralph-decision.helper.js";
import type {
  RalphBlockExecutionResult,
  RalphDecisionBlock,
  RalphFlowBlock,
  RalphPromptBlock,
  RalphValidatorBlock,
} from "../ralph.js";
import type { TaskExecutionResult } from "../types.js";

export const createRalphBlockExecutionErrorResult = (
  block: RalphFlowBlock,
  error: unknown,
  attempt = 1,
): RalphBlockExecutionResult => {
  const message = error instanceof Error ? error.message : String(error);

  return {
    blockId: block.id,
    output: "ERROR",
    status: "error",
    attempt,
    summary: message,
    error: message,
  };
};

export const createRalphPromptExecutionResult = (
  block: RalphPromptBlock,
  result: TaskExecutionResult | undefined,
  attempt: number,
): RalphBlockExecutionResult => {
  if (!result) {
    const message = `${block.title} did not produce a result.`;

    return {
      blockId: block.id,
      output: "ERROR",
      status: "error",
      attempt,
      summary: message,
      error: message,
    };
  }

  if (result.status !== "executed") {
    return {
      blockId: block.id,
      output: "ERROR",
      status: "error",
      attempt,
      result,
      summary: result.summary,
      markdown: getRalphResultMarkdown(result),
      error: result.reason ?? result.summary,
    };
  }

  return {
    blockId: block.id,
    output: "SUCCESS",
    status: "completed",
    attempt,
    result,
    summary: result.summary ?? `${block.title} completed.`,
    markdown: getRalphResultMarkdown(result),
  };
};

export const createRalphValidatorExecutionResult = (
  block: RalphValidatorBlock,
  result: TaskExecutionResult,
): RalphBlockExecutionResult => {
  const decision = parseRalphDecision(result) ?? "ERROR";
  const isError = decision === "ERROR" || result.status !== "executed";

  return {
    blockId: block.id,
    output: result.status === "executed" ? decision : "ERROR",
    status: result.status === "executed" && decision !== "ERROR" ? "completed" : "error",
    attempt: 1,
    result,
    summary: result.summary,
    markdown: getRalphResultMarkdown(result),
    ...(isError ? { error: result.reason ?? result.summary } : {}),
  };
};

const createDecisionOutputError = (
  block: RalphDecisionBlock,
  result: TaskExecutionResult,
  parsed: string | undefined,
): string => {
  const expectedLabels = block.labels.join(", ");
  const markdown = getRalphResultMarkdown(result);
  const outputExcerpt = markdown
    ? ` Output: ${markdown}`
    : result.reason
      ? ` Reason: ${result.reason}`
      : "";

  if (parsed) {
    return `${block.title} returned unsupported decision label \`${parsed}\`. Expected one of: ${expectedLabels}.${outputExcerpt}`;
  }

  return `${block.title} did not return a supported RALPH_DECISION marker. Expected one of: ${expectedLabels}.${outputExcerpt}`;
};

export const createRalphDecisionExecutionResult = (
  block: RalphDecisionBlock,
  result: TaskExecutionResult,
): RalphBlockExecutionResult => {
  const parsed = parseLastRalphDecisionMarker(result);
  const labelByNormalizedValue = new Map(
    block.labels.map((label) => [label.toUpperCase(), label] as const),
  );
  const parsedOutput = parsed
    ? labelByNormalizedValue.get(parsed)
    : undefined;
  const output =
    result.status === "executed" && parsedOutput ? parsedOutput : "ERROR";
  const error =
    output === "ERROR"
      ? result.status === "executed"
        ? createDecisionOutputError(block, result, parsed)
        : result.reason ?? result.summary
      : undefined;

  return {
    blockId: block.id,
    output,
    status: output === "ERROR" ? "error" : "completed",
    attempt: 1,
    result,
    summary: error ?? result.summary,
    markdown: getRalphResultMarkdown(result),
    ...(error ? { error } : {}),
  };
};
