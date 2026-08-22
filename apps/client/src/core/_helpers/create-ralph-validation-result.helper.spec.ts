import type {
  RalphFlowVariable,
  RalphValidationIssue,
} from "../ralph.ts";
import {
  addRalphValidationIssue,
  createValidationResult,
} from "./create-ralph-validation-result.helper.ts";

describe("addRalphValidationIssue", () => {
  it("appends validation issues without block or edge context by default", () => {
    const issues: RalphValidationIssue[] = [];

    addRalphValidationIssue(issues, "flow-invalid", "Flow is invalid.");

    expect(issues).toEqual([
      {
        code: "flow-invalid",
        message: "Flow is invalid.",
      },
    ]);
  });

  it("preserves provided block and edge context", () => {
    const issues: RalphValidationIssue[] = [];

    addRalphValidationIssue(issues, "edge-invalid", "Edge is invalid.", {
      blockId: "review",
      edgeId: "review-to-done",
    });

    expect(issues).toEqual([
      {
        code: "edge-invalid",
        message: "Edge is invalid.",
        blockId: "review",
        edgeId: "review-to-done",
      },
    ]);
  });
});

describe("createValidationResult", () => {
  it("creates a valid empty result when optional inputs are omitted", () => {
    expect(createValidationResult([])).toEqual({
      valid: true,
      errors: [],
      warnings: [],
      errorIssues: [],
      warningIssues: [],
      variables: [],
    });
  });

  it("projects issue messages and keeps structured issues and variables", () => {
    const errors: RalphValidationIssue[] = [
      {
        code: "missing-start",
        message: "Ralph flow must contain exactly one START block.",
      },
      {
        code: "block-id-invalid",
        message: "block id `Bad ID` must match pattern.",
        blockId: "Bad ID",
      },
    ];
    const warnings: RalphValidationIssue[] = [
      {
        code: "pack-empty",
        message: "pack block does not reference any packs.",
        blockId: "pack",
      },
    ];
    const variables: RalphFlowVariable[] = [
      {
        name: "scope",
        type: "path",
        required: true,
      },
    ];

    expect(createValidationResult(errors, warnings, variables)).toEqual({
      valid: false,
      errors: [
        "Ralph flow must contain exactly one START block.",
        "block id `Bad ID` must match pattern.",
      ],
      warnings: ["pack block does not reference any packs."],
      errorIssues: errors,
      warningIssues: warnings,
      variables,
    });
  });

  it("stays valid when only warnings and variables are present", () => {
    const warning: RalphValidationIssue = {
      code: "note-empty",
      message: "note is empty.",
      blockId: "note",
    };

    expect(
      createValidationResult([], [warning], [
        { name: "optional", type: "string", required: false },
      ]),
    ).toMatchObject({
      valid: true,
      errors: [],
      warnings: ["note is empty."],
    });
  });
});
