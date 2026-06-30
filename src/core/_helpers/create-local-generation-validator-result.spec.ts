import { createLocalGenerationValidatorResult } from "./create-local-generation-validator-result.helper.ts";

describe("createLocalGenerationValidatorResult", () => {
  it("creates a successful local validator result for clean validation", () => {
    const result = createLocalGenerationValidatorResult(
      "Validate generated flow.",
      "machdoch",
      { decision: "DONE", issues: [], warnings: [] },
      42,
    );

    expect(result).toMatchObject({
      task: "Validate generated flow.",
      mode: "machdoch",
      status: "executed",
      summary: "Local Ralph generation validator returned DONE.",
      executedTools: [],
    });
    expect(result.outputSections[0]?.lines).toEqual([
      "decision: DONE",
      "durationMs: 42",
      "No local structural issues found.",
    ]);
    expect(result.response?.markdown).toBe(
      "No local structural issues found.\nRALPH_DECISION: DONE",
    );
  });

  it("includes issue and warning lines in both sections and markdown", () => {
    const result = createLocalGenerationValidatorResult(
      "Validate generated flow.",
      "ask",
      {
        decision: "RETRY",
        issues: ["Cycle requires maxTransitions."],
        warnings: ["Avoid example ids."],
      },
      7,
    );

    expect(result.outputSections[0]?.lines).toEqual([
      "decision: RETRY",
      "durationMs: 7",
      "- Cycle requires maxTransitions.",
      "Warnings:",
      "- Avoid example ids.",
    ]);
    expect(result.response?.markdown).toBe(
      "- Cycle requires maxTransitions.\nWarnings:\n- Avoid example ids.\nRALPH_DECISION: RETRY",
    );
  });
});
