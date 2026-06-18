import type {
  RalphFlow,
  RalphValidationIssue,
} from "../ralph.ts";
import { createFlow } from "../__test__/ralph-test-helpers.ts";
import { createValidationResult } from "./create-ralph-validation-result.helper.ts";
import {
  getRalphUtilityOutputs,
  isExecutableRalphBlock,
  isVisualRalphBlock,
} from "./get-ralph-block-outputs.helper.ts";
import { hasGraphCycle } from "./validate-ralph-flow-graph.helper.ts";
import { validateRalphFlow } from "./validate-ralph-flow.helper.ts";

const getCodes = (issues: readonly RalphValidationIssue[]): string[] => {
  return issues.map((issue) => issue.code);
};

describe("Ralph flow validation helpers", () => {
  it("creates stable validation result projections for empty and populated issue sets", () => {
    expect(createValidationResult([])).toEqual({
      valid: true,
      errors: [],
      warnings: [],
      errorIssues: [],
      warningIssues: [],
      variables: [],
    });

    const error: RalphValidationIssue = {
      code: "bad-flow",
      message: "Flow is invalid.",
      blockId: "review",
    };
    const warning: RalphValidationIssue = {
      code: "risky-flow",
      message: "Flow may loop.",
    };
    const result = createValidationResult([error], [warning], [
      { name: "scope", type: "path", required: true },
    ]);

    expect(result).toEqual({
      valid: false,
      errors: ["Flow is invalid."],
      warnings: ["Flow may loop."],
      errorIssues: [error],
      warningIssues: [warning],
      variables: [{ name: "scope", type: "path", required: true }],
    });
  });

  it("classifies utility outputs and visual/executable block types", () => {
    expect(getRalphUtilityOutputs({ type: "POLL", maxAttempts: 3 })).toEqual([
      "SUCCESS",
      "TIMEOUT",
      "ERROR",
    ]);
    expect(getRalphUtilityOutputs({ type: "POLL", maxAttempts: null })).toEqual([
      "SUCCESS",
      "ERROR",
    ]);
    expect(getRalphUtilityOutputs({ type: "WAIT" })).toEqual(["SUCCESS"]);

    expect(isVisualRalphBlock({ id: "note", type: "NOTE", title: "Note", text: "" })).toBe(true);
    expect(isVisualRalphBlock({ id: "group", type: "GROUP", title: "Group", childBlockIds: [] })).toBe(true);
    expect(isExecutableRalphBlock({ id: "start", type: "START", title: "Start" })).toBe(false);
    expect(isExecutableRalphBlock({ id: "end", type: "END", title: "End", status: "success" })).toBe(false);
    expect(
      isExecutableRalphBlock({
        id: "review",
        type: "PROMPT",
        title: "Review",
        prompt: "Review.",
      }),
    ).toBe(true);
  });

  it("detects graph cycles and acyclic terminal paths", () => {
    expect(hasGraphCycle(createFlow())).toBe(true);
    expect(
      hasGraphCycle(
        createFlow({
          edges: [
            { id: "start-to-fix", from: "start", fromOutput: "SUCCESS", to: "fix-tsc" },
            { id: "fix-to-validate", from: "fix-tsc", fromOutput: "SUCCESS", to: "validate" },
            { id: "validate-done", from: "validate", fromOutput: "DONE", to: "success" },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("accepts a valid flow and reports discovered variables", () => {
    const validation = validateRalphFlow(createFlow({ settings: { maxTransitions: 10 } }));

    expect(validation.valid).toBe(true);
    expect(validation.errorIssues).toEqual([]);
    expect(validation.variables).toEqual([
      {
        name: "scope",
        type: "path",
        default: "ALL",
        required: false,
      },
    ]);
  });

  it("rejects empty and invalid flow structure", () => {
    const validation = validateRalphFlow({
      ...createFlow(),
      schemaVersion: 2 as RalphFlow["schemaVersion"],
      id: " ",
      alias: "",
      name: "",
      blocks: [],
      edges: [],
    });

    expect(validation.valid).toBe(false);
    expect(getCodes(validation.errorIssues)).toEqual(
      expect.arrayContaining([
        "schema-version",
        "flow-id-required",
        "flow-alias-empty",
        "flow-name-required",
        "missing-start",
      ]),
    );
  });

  it("rejects missing required variable values", () => {
    const flow = createFlow({
      blocks: [
        { id: "start", type: "START", title: "Start" },
        {
          id: "review",
          type: "PROMPT",
          title: "Review",
          prompt: "Review {{target:path}}.",
        },
        { id: "success", type: "END", title: "Success", status: "success" },
      ],
      edges: [
        { id: "start-to-review", from: "start", fromOutput: "SUCCESS", to: "review" },
        { id: "review-to-success", from: "review", fromOutput: "SUCCESS", to: "success" },
      ],
    });

    const validation = validateRalphFlow(flow, { variableValues: {} });

    expect(validation.valid).toBe(false);
    expect(getCodes(validation.errorIssues)).toContain("variable-missing");
    expect(validation.errors).toContain("missing required Ralph variable `target`.");
  });
});
