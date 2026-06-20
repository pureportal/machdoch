import { createGenerationDidNotConvergeSummary } from "./create-generation-did-not-converge-summary.helper.ts";
import type { RalphValidationResult } from "../ralph.ts";

const createValidation = (
  overrides: Partial<RalphValidationResult> = {},
): RalphValidationResult => ({
  valid: true,
  errors: [],
  warnings: [],
  errorIssues: [],
  warningIssues: [],
  variables: [],
  ...overrides,
});

describe("createGenerationDidNotConvergeSummary", () => {
  it("summarizes max rounds when no validation or feedback detail is available", () => {
    expect(
      createGenerationDidNotConvergeSummary(3, createValidation(), undefined),
    ).toBe("Ralph flow generation did not converge after 3 round(s).");
  });

  it("includes the first schema error and normalized validator feedback", () => {
    expect(
      createGenerationDidNotConvergeSummary(
        2,
        createValidation({
          valid: false,
          errors: ["Missing START block.", "Missing END block."],
        }),
        "Retry\nwith a bounded loop.",
      ),
    ).toBe(
      "Ralph flow generation did not converge after 2 round(s). Last schema error: Missing START block. Last feedback: Retry with a bounded loop.",
    );
  });

  it("omits whitespace-only validator feedback", () => {
    expect(
      createGenerationDidNotConvergeSummary(
        1,
        createValidation({ valid: false, errors: ["Invalid edge."] }),
        "   ",
      ),
    ).toBe(
      "Ralph flow generation did not converge after 1 round(s). Last schema error: Invalid edge.",
    );
  });
});
