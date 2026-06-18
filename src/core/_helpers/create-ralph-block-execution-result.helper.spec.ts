import type {
  RalphDecisionBlock,
  RalphPromptBlock,
  RalphValidatorBlock,
} from "../ralph.ts";
import { createExecutionResult } from "../__test__/ralph-test-helpers.ts";
import {
  createRalphBlockExecutionErrorResult,
  createRalphDecisionExecutionResult,
  createRalphPromptExecutionResult,
  createRalphValidatorExecutionResult,
} from "./create-ralph-block-execution-result.helper.ts";

const promptBlock: RalphPromptBlock = {
  id: "prompt",
  type: "PROMPT",
  title: "Fix issue",
  prompt: "Fix it.",
};

const validatorBlock: RalphValidatorBlock = {
  id: "validator",
  type: "VALIDATOR",
  title: "Validate",
  prompt: "Validate it.",
};

const decisionBlock: RalphDecisionBlock = {
  id: "decision",
  type: "DECISION",
  title: "Route",
  prompt: "Route it.",
  labels: ["approved", "needs-work"],
};

describe("createRalphBlockExecutionErrorResult", () => {
  it("creates an error result from an Error and preserves the attempt", () => {
    expect(
      createRalphBlockExecutionErrorResult(promptBlock, new Error("No access"), 3),
    ).toEqual({
      blockId: "prompt",
      output: "ERROR",
      status: "error",
      attempt: 3,
      summary: "No access",
      error: "No access",
    });
  });

  it.each([
    [null, "null"],
    [undefined, "undefined"],
    ["plain failure", "plain failure"],
  ] as const)("normalizes unknown thrown value %#", (input, message) => {
    expect(createRalphBlockExecutionErrorResult(promptBlock, input)).toMatchObject({
      blockId: "prompt",
      output: "ERROR",
      status: "error",
      attempt: 1,
      summary: message,
      error: message,
    });
  });
});

describe("createRalphPromptExecutionResult", () => {
  it("creates a completed prompt result from an executed task result", () => {
    const result = createExecutionResult({
      summary: "Fixed.",
      response: {
        markdown: "Detailed fix.",
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    expect(createRalphPromptExecutionResult(promptBlock, result, 2)).toEqual({
      blockId: "prompt",
      output: "SUCCESS",
      status: "completed",
      attempt: 2,
      result,
      summary: "Fixed.",
      markdown: "Detailed fix.",
    });
  });

  it("creates an error prompt result when the task did not execute", () => {
    const result = createExecutionResult({
      status: "blocked",
      summary: "Blocked.",
      reason: "Approval required.",
    });

    expect(createRalphPromptExecutionResult(promptBlock, result, 1)).toMatchObject({
      blockId: "prompt",
      output: "ERROR",
      status: "error",
      attempt: 1,
      result,
      summary: "Blocked.",
      markdown: "Done.",
      error: "Approval required.",
    });
  });

  it("creates a no-result error when execution returns undefined", () => {
    expect(createRalphPromptExecutionResult(promptBlock, undefined, 0)).toEqual({
      blockId: "prompt",
      output: "ERROR",
      status: "error",
      attempt: 0,
      summary: "Fix issue did not produce a result.",
      error: "Fix issue did not produce a result.",
    });
  });
});

describe("createRalphValidatorExecutionResult", () => {
  it("uses the final valid decision marker for executed validator output", () => {
    const result = createExecutionResult({
      summary: "Ready.",
      response: {
        markdown: "Looks good.\nRALPH_DECISION: DONE",
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    expect(createRalphValidatorExecutionResult(validatorBlock, result)).toEqual({
      blockId: "validator",
      output: "DONE",
      status: "completed",
      attempt: 1,
      result,
      summary: "Ready.",
      markdown: "Looks good.\nRALPH_DECISION: DONE",
    });
  });

  it("treats missing or invalid validator markers as errors", () => {
    const result = createExecutionResult({
      summary: "No marker.",
      response: {
        markdown: "Looks good.",
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    expect(createRalphValidatorExecutionResult(validatorBlock, result)).toMatchObject({
      output: "ERROR",
      status: "error",
      summary: "No marker.",
      error: "No marker.",
    });
  });

  it("keeps a non-executed validator task as an error even with a marker", () => {
    const result = createExecutionResult({
      status: "blocked",
      summary: "Blocked.",
      reason: "Stopped.",
      response: {
        markdown: "RALPH_DECISION: DONE",
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    expect(createRalphValidatorExecutionResult(validatorBlock, result)).toMatchObject({
      output: "ERROR",
      status: "error",
      error: "Stopped.",
    });
  });
});

describe("createRalphDecisionExecutionResult", () => {
  it("maps normalized decision markers back to the configured label value", () => {
    const result = createExecutionResult({
      summary: "Route selected.",
      response: {
        markdown: "Use the review path.\nRALPH_DECISION: NEEDS-WORK",
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    expect(createRalphDecisionExecutionResult(decisionBlock, result)).toEqual({
      blockId: "decision",
      output: "needs-work",
      status: "completed",
      attempt: 1,
      result,
      summary: "Route selected.",
      markdown: "Use the review path.\nRALPH_DECISION: NEEDS-WORK",
    });
  });

  it("reports unsupported decision labels with the expected labels and output excerpt", () => {
    const result = createExecutionResult({
      summary: "Unsupported.",
      response: {
        markdown: "Try something else.\nRALPH_DECISION: REJECTED",
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    expect(createRalphDecisionExecutionResult(decisionBlock, result)).toMatchObject({
      output: "ERROR",
      status: "error",
      summary:
        "Route returned unsupported decision label `REJECTED`. Expected one of: approved, needs-work. Output: Try something else.\nRALPH_DECISION: REJECTED",
      error:
        "Route returned unsupported decision label `REJECTED`. Expected one of: approved, needs-work. Output: Try something else.\nRALPH_DECISION: REJECTED",
    });
  });

  it("uses the reason when a non-executed decision result has no markdown", () => {
    const result = createExecutionResult({
      status: "blocked",
      summary: "Blocked.",
      reason: "Tool denied.",
      response: undefined,
    });

    expect(createRalphDecisionExecutionResult(decisionBlock, result)).toMatchObject({
      output: "ERROR",
      status: "error",
      summary: "Tool denied.",
      markdown: "Blocked.",
      error: "Tool denied.",
    });
  });
});
