import { describe, expect, it } from "vitest";
import {
  compareRalphVerificationObservations,
  createRalphVerificationObservation,
} from "./ralph-verification.helper.js";

const observation = (
  exitCode: number,
  output: string,
  overrides: Partial<{ command: string; cwd: string }> = {},
) =>
  createRalphVerificationObservation({
    command: overrides.command ?? "pnpm test",
    cwd: overrides.cwd ?? "C:\\repo",
    exitCode,
    stderr: output,
  });

describe("RALPH semantic verification", () => {
  it("accepts an unchanged baseline failure without claiming the check passed", () => {
    const baseline = observation(1, "FAILED tests/widget.spec.ts::keeps_state");
    const candidate = observation(
      1,
      "FAILED tests/widget.spec.ts::keeps_state in 4.77s",
    );

    expect(
      compareRalphVerificationObservations(baseline, candidate).disposition,
    ).toBe("BASELINE_EQUIVALENT_FAILURE");
  });

  it("detects a regression against a passing baseline", () => {
    expect(
      compareRalphVerificationObservations(
        observation(0, "12 tests passed"),
        observation(1, "FAIL src/new-feature.spec.ts"),
      ).disposition,
    ).toBe("REGRESSION");
  });

  it("recognizes resolved baseline failures", () => {
    expect(
      compareRalphVerificationObservations(
        observation(1, "FAIL src/old.spec.ts"),
        observation(0, "12 tests passed"),
      ).disposition,
    ).toBe("IMPROVED_WITH_BASELINE_FAILURES");
  });

  it("refuses to compare different verification plans", () => {
    expect(
      compareRalphVerificationObservations(
        observation(1, "FAIL src/old.spec.ts"),
        observation(1, "FAIL src/old.spec.ts", { command: "pnpm lint" }),
      ).disposition,
    ).toBe("INCONCLUSIVE");
  });

  it("detects new failures even when both checks fail", () => {
    const comparison = compareRalphVerificationObservations(
      observation(1, "FAIL src/old.spec.ts"),
      observation(1, "FAIL src/old.spec.ts\nFAIL src/new.spec.ts"),
    );

    expect(comparison.disposition).toBe("REGRESSION");
    expect(comparison.newFailureIds).toContain("src/new.spec.ts");
  });

  it("does not collapse different unstructured failures into one baseline", () => {
    expect(
      compareRalphVerificationObservations(
        observation(1, "Opaque compiler failure in parser backend"),
        observation(1, "Opaque compiler failure in renderer backend"),
      ).disposition,
    ).toBe("INCONCLUSIVE");
  });

  it("normalizes volatile timing in otherwise identical unstructured failures", () => {
    expect(
      compareRalphVerificationObservations(
        observation(1, "Opaque backend failure after 2.1s"),
        observation(1, "Opaque backend failure after 9.8s"),
      ).disposition,
    ).toBe("BASELINE_EQUIVALENT_FAILURE");
  });

  it("extracts pytest collection failures as structured evidence", () => {
    const comparison = compareRalphVerificationObservations(
      observation(1, "ERROR collecting tests/test_old.py"),
      observation(
        1,
        "ERROR collecting tests/test_old.py\nERROR collecting tests/test_new.py",
      ),
    );

    expect(comparison.disposition).toBe("REGRESSION");
    expect(comparison.newFailureIds).toContain("tests/test_new.py");
  });

  it("classifies an unchanged missing dependency as unavailable environment", () => {
    expect(
      compareRalphVerificationObservations(
        observation(1, "Error: Cannot find module 'optional-driver'"),
        observation(1, "Error: Cannot find module 'optional-driver'"),
      ).disposition,
    ).toBe("ENVIRONMENT_UNAVAILABLE");
  });

  it("does not hide a new test failure behind an unchanged missing dependency", () => {
    const comparison = compareRalphVerificationObservations(
      observation(1, "Error: Cannot find module 'optional-driver'"),
      observation(
        1,
        "Error: Cannot find module 'optional-driver'\nFAIL src/new.spec.ts",
      ),
    );

    expect(comparison.disposition).toBe("REGRESSION");
    expect(comparison.newFailureIds).toContain("src/new.spec.ts");
  });

  it("does not call changed collection diagnostics an unavailable environment", () => {
    expect(
      compareRalphVerificationObservations(
        observation(
          1,
          "ERROR collecting tests/test_widget.py\nTypeError: baseline diagnostic",
        ),
        observation(
          1,
          "ERROR collecting tests/test_widget.py\nSyntaxError: candidate diagnostic",
        ),
      ).disposition,
    ).toBe("INCONCLUSIVE");
  });

  it("classifies a timed-out candidate without calling it a source regression", () => {
    const baseline = observation(0, "12 tests passed");
    const candidate = createRalphVerificationObservation({
      command: "pnpm test",
      cwd: "C:\\repo",
      exitCode: null,
      executionError: "Command timed out after 30000ms.",
      timedOut: true,
    });

    expect(
      compareRalphVerificationObservations(baseline, candidate).disposition,
    ).toBe("TIMEOUT");
  });
});
