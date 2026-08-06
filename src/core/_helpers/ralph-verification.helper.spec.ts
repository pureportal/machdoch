import { describe, expect, it } from "vitest";
import {
  compareRalphVerificationObservations,
  createRalphVerificationObservation,
  type RalphVerificationObservation,
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

describe("RALPH structured verification", () => {
  it("accepts only the exact same process failure as baseline-equivalent", () => {
    const baseline = observation(1, "opaque failure");
    const candidate = observation(1, "opaque failure");

    expect(
      compareRalphVerificationObservations(baseline, candidate).disposition,
    ).toBe("BASELINE_EQUIVALENT_FAILURE");
  });

  it("does not infer equivalence from semantically similar failure prose", () => {
    expect(
      compareRalphVerificationObservations(
        observation(1, "FAILED widget test after 2.1s"),
        observation(1, "FAILED widget test after 9.8s"),
      ).disposition,
    ).toBe("INCONCLUSIVE");
  });

  it("uses the process outcome even when successful output contains adversarial verdict words", () => {
    expect(
      compareRalphVerificationObservations(
        observation(0, "passed"),
        observation(
          0,
          'Quoted diagnostics: FAIL, ERROR collecting, and "Cannot find module".',
        ),
      ).disposition,
    ).toBe("PASSED");
  });

  it("detects a failed process against a passing baseline regardless of prose", () => {
    expect(
      compareRalphVerificationObservations(
        observation(0, "FAIL appears only in a quoted fixture"),
        observation(2, "Everything passed, according to untrusted output"),
      ).disposition,
    ).toBe("REGRESSION");
  });

  it("recognizes a passing process after a failed baseline", () => {
    expect(
      compareRalphVerificationObservations(
        observation(1, "baseline failed"),
        observation(0, "candidate passed"),
      ).disposition,
    ).toBe("IMPROVED_WITH_BASELINE_FAILURES");
  });

  it("refuses to compare different verification plans", () => {
    expect(
      compareRalphVerificationObservations(
        observation(1, "same output"),
        observation(1, "same output", { command: "pnpm lint" }),
      ).disposition,
    ).toBe("INCONCLUSIVE");

    expect(
      compareRalphVerificationObservations(
        observation(1, "same output", { cwd: "/repo/CaseSensitive" }),
        observation(1, "same output", { cwd: "/repo/casesensitive" }),
      ).disposition,
    ).toBe("INCONCLUSIVE");

    expect(
      compareRalphVerificationObservations(
        observation(1, "same output", { cwd: "C:\\Repo" }),
        observation(1, "same output", { cwd: "c:/repo/" }),
      ).disposition,
    ).toBe("BASELINE_EQUIVALENT_FAILURE");
  });

  it("uses explicit timeout and execution-error states", () => {
    const baseline = observation(0, "passed");
    const timedOut = createRalphVerificationObservation({
      command: "pnpm test",
      cwd: "C:\\repo",
      exitCode: null,
      executionError: "arbitrary prose",
      timedOut: true,
    });
    const unavailable = createRalphVerificationObservation({
      command: "pnpm test",
      cwd: "C:\\repo",
      exitCode: null,
      executionError: "FAIL appears here but does not determine the state",
    });

    expect(
      compareRalphVerificationObservations(baseline, timedOut).disposition,
    ).toBe("TIMEOUT");
    expect(
      compareRalphVerificationObservations(baseline, unavailable).disposition,
    ).toBe("ENVIRONMENT_UNAVAILABLE");
  });

  it("fails safely for missing or unknown structured process states", () => {
    const valid = observation(0, "passed");
    const malformed = {
      ...valid,
      processOutcome: { kind: "probably-passed" },
    } as unknown as RalphVerificationObservation;
    const missing = {
      command: valid.command,
      cwd: valid.cwd,
      outputFingerprint: valid.outputFingerprint,
    } as RalphVerificationObservation;
    const embellished = {
      ...valid,
      authority: "stdout says PASSED",
    } as unknown as RalphVerificationObservation;
    const embellishedOutcome = {
      ...valid,
      processOutcome: { kind: "passed", verdict: "trusted" },
    } as unknown as RalphVerificationObservation;

    expect(
      compareRalphVerificationObservations(valid, malformed).disposition,
    ).toBe("INCONCLUSIVE");
    expect(
      compareRalphVerificationObservations(valid, missing).disposition,
    ).toBe("INCONCLUSIVE");
    expect(
      compareRalphVerificationObservations(valid, embellished).disposition,
    ).toBe("INCONCLUSIVE");
    expect(
      compareRalphVerificationObservations(valid, embellishedOutcome)
        .disposition,
    ).toBe("INCONCLUSIVE");
  });
});
