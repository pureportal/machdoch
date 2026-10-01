import { describe, expect, it } from "vitest";
import { createFlow } from "../__test__/ralph-test-helpers.js";
import type { RalphBlockExecutionResult, RalphUtilityBlock } from "../ralph.js";
import { getRalphIntegrationChecks } from "./ralph-integration-checks.helper.js";
import { createRalphVerificationObservation } from "./ralph-verification.helper.js";

const check: RalphUtilityBlock = {
  id: "check",
  type: "UTILITY",
  title: "Check",
  utility: { type: "RUN_CHECK", command: "node verify.mjs" },
};
const baseline: RalphUtilityBlock = {
  id: "baseline",
  type: "UTILITY",
  title: "Baseline",
  utility: {
    type: "RUN_CHECK",
    command: "node verify.mjs",
    verificationRole: "baseline",
  },
};
const flow = createFlow({ blocks: [check, baseline] });
const result = (
  exitCode = 0,
  blockId = "check",
): RalphBlockExecutionResult => ({
  blockId,
  output: exitCode === 0 ? "SUCCESS" : "FAILED",
  status: "completed",
  attempt: 1,
  summary: "Checked",
  data: { command: "node verify.mjs", cwd: "/workspace", exitCode },
});

describe("RALPH integration checks", () => {
  it("includes checks without a baseline role and deduplicates successful repeats", () => {
    expect(getRalphIntegrationChecks(flow, [result(), result()])).toEqual([
      { block: check, command: "node verify.mjs", cwd: "/workspace" },
    ]);
  });

  it("excludes baseline checks and checks whose latest observation failed", () => {
    expect(
      getRalphIntegrationChecks(flow, [
        result(0, "baseline"),
        result(),
        result(1),
      ]),
    ).toEqual([]);
    expect(getRalphIntegrationChecks(flow, [result(1), result()])).toHaveLength(
      1,
    );
  });

  it("requires passing process evidence when a verification observation exists", () => {
    const failed = result();
    failed.data = {
      verification: {
        role: "candidate",
        observation: createRalphVerificationObservation({
          command: "node verify.mjs",
          cwd: "/workspace",
          exitCode: 1,
        }),
      },
    };
    expect(getRalphIntegrationChecks(flow, [failed])).toEqual([]);
    expect(
      getRalphIntegrationChecks(flow, [
        {
          ...result(),
          data: {
            verification: {
              role: "candidate",
              observation: createRalphVerificationObservation({
                command: "node verify.mjs",
                cwd: "/workspace",
                exitCode: 0,
              }),
            },
          },
        },
      ]),
    ).toHaveLength(1);
  });
});
