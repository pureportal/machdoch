import { getRalphResultMarkdown } from "./ralph-result-text.helper.js";
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
  const decision =
    result.control?.kind === "ralph-validator"
      ? result.control.decision
      : "ERROR";
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
): string => {
  const expectedLabels = block.labels.join(", ");
  const markdown = getRalphResultMarkdown(result);
  const outputExcerpt = markdown
    ? ` Output: ${markdown}`
    : result.reason
      ? ` Reason: ${result.reason}`
      : "";

  return `${block.title} did not return a valid structured route. Expected one of: ${expectedLabels}.${outputExcerpt}`;
};

export const createRalphDecisionExecutionResult = (
  block: RalphDecisionBlock,
  result: TaskExecutionResult,
): RalphBlockExecutionResult => {
  const parsedOutput =
    result.control?.kind === "ralph-route" &&
    block.labels.includes(result.control.label)
      ? result.control.label
      : undefined;
  const output =
    result.status === "executed" && parsedOutput ? parsedOutput : "ERROR";
  const error =
    output === "ERROR"
      ? result.status === "executed"
        ? createDecisionOutputError(block, result)
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
