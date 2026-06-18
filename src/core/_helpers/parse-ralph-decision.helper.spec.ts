import type { TaskExecutionResult } from "../types.js";
import {
  getRalphResultMarkdown,
  MAX_RALPH_RESULT_CHARS,
  parseLastRalphDecisionMarker,
  parseRalphDecision,
  truncateRalphResultText,
} from "./parse-ralph-decision.helper.ts";

const createResult = (
  overrides: Partial<TaskExecutionResult> = {},
): TaskExecutionResult => ({
  task: "task",
  mode: "machdoch",
  status: "executed",
  summary: "Summary text.",
  executedTools: [],
  outputSections: [],
  ...overrides,
});

describe("parseRalphDecision", () => {
  it.each([
    ["RALPH_DECISION: DONE", "DONE"],
    ["ralph_decision: continue", "CONTINUE"],
    [" RALPH_DECISION : retry ", "RETRY"],
    ["RALPH_DECISION: ERROR", "ERROR"],
  ] as const)("parses supported final marker %j", (markdown, expected) => {
    expect(
      parseRalphDecision(
        createResult({
          response: {
            markdown,
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBe(expected);
  });

  it("uses only the last non-empty line for validator decisions", () => {
    const result = createResult({
      response: {
        markdown: "RALPH_DECISION: RETRY\n\nRALPH_DECISION: DONE",
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    expect(parseRalphDecision(result)).toBe("DONE");
  });

  it("rejects markers that are unsupported or not on the final line", () => {
    expect(
      parseRalphDecision(
        createResult({
          response: {
            markdown: "RALPH_DECISION: DONE\nAdditional explanation.",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      parseRalphDecision(
        createResult({
          response: {
            markdown: "RALPH_DECISION: APPROVE",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBeUndefined();
  });

  it("falls back through summary and nullish reason text when markdown is absent", () => {
    expect(
      parseRalphDecision(createResult({ summary: "RALPH_DECISION: ERROR" })),
    ).toBe("ERROR");
    expect(
      parseRalphDecision(
        {
          task: "task",
          mode: "machdoch",
          status: "blocked",
          executedTools: [],
          outputSections: [],
          reason: "RALPH_DECISION: RETRY",
        } as TaskExecutionResult,
      ),
    ).toBe("RETRY");
  });

  it("does not use reason text when summary is an empty string", () => {
    expect(
      parseRalphDecision(
        createResult({
          summary: "",
          reason: "RALPH_DECISION: RETRY",
        }),
      ),
    ).toBeUndefined();
  });
});

describe("parseLastRalphDecisionMarker", () => {
  it("returns the last marker anywhere in the result text", () => {
    const result = createResult({
      response: {
        markdown: "RALPH_DECISION: alpha\n\nNotes\nRALPH_DECISION: beta",
        highlights: [],
        relatedFiles: [],
        verification: [],
        followUps: [],
      },
    });

    expect(parseLastRalphDecisionMarker(result)).toBe("BETA");
  });

  it("returns undefined for empty, nullish, or marker-free inputs", () => {
    expect(parseLastRalphDecisionMarker(undefined)).toBeUndefined();
    expect(
      parseLastRalphDecisionMarker(createResult({ summary: "" })),
    ).toBeUndefined();
    expect(
      parseLastRalphDecisionMarker(createResult({ reason: "No decision." })),
    ).toBeUndefined();
  });
});

describe("getRalphResultMarkdown", () => {
  it("prefers markdown over summary and reason", () => {
    expect(
      getRalphResultMarkdown(
        createResult({
          summary: "Summary",
          reason: "Reason",
          response: {
            markdown: "Markdown",
            highlights: [],
            relatedFiles: [],
            verification: [],
            followUps: [],
          },
        }),
      ),
    ).toBe("Markdown");
  });

  it("returns an empty string for undefined results", () => {
    expect(getRalphResultMarkdown(undefined)).toBe("");
  });
});

describe("truncateRalphResultText", () => {
  it("keeps text at the maximum boundary unchanged", () => {
    const text = "a".repeat(MAX_RALPH_RESULT_CHARS);

    expect(truncateRalphResultText(text)).toBe(text);
  });

  it("truncates text above the maximum boundary with a marker", () => {
    const result = truncateRalphResultText(
      "a".repeat(MAX_RALPH_RESULT_CHARS + 1),
    );

    expect(result).toHaveLength(
      MAX_RALPH_RESULT_CHARS +
        `\n[Ralph result truncated at ${MAX_RALPH_RESULT_CHARS} characters.]`
          .length,
    );
    expect(
      result.endsWith(
        `[Ralph result truncated at ${MAX_RALPH_RESULT_CHARS} characters.]`,
      ),
    ).toBe(true);
  });
});
