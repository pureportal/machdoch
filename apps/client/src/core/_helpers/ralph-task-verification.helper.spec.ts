import { describe, expect, it } from "vitest";
import type { RalphBlockExecutionResult } from "../ralph.js";
import { getRalphTaskVerification } from "./ralph-task-verification.helper.js";
import { createRalphVerificationObservation } from "./ralph-verification.helper.js";

const task = {
  id: "task",
  status: "verifying",
  selectedAt: "2026-09-30T10:00:00.000Z",
  stateHistory: [{ at: "2026-09-30T10:00:00.000Z", to: "verifying" }],
};
const result = (
  exitCode = 0,
  verifiedAt = "2026-09-30T10:01:00.000Z",
  disposition = "PASSED",
): RalphBlockExecutionResult => ({
  blockId: "candidate",
  output: "SUCCESS",
  status: "completed",
  attempt: 1,
  summary: "Check",
  data: {
    verification: {
      role: "candidate",
      planId: "plan",
      verifiedAt,
      observation: createRalphVerificationObservation({
        command: "node check.js",
        cwd: "/workspace",
        exitCode,
      }),
      comparison: { disposition },
    },
  },
});

describe("task completion verification", () => {
  it("accepts a fresh passing check and retains the exact boundary", () => {
    expect(
      getRalphTaskVerification([result()], task, "candidate"),
    ).toMatchObject({
      command: "node check.js",
      cwd: "/workspace",
      planId: "plan",
    });
  });
  it.each([
    { results: [] },
    { results: [result(101, undefined, "BASELINE_EQUIVALENT_FAILURE")] },
    { results: [result(0, "2026-09-30T09:59:59.999Z")] },
    { results: [result(0, "invalid")] },
    { results: [result(), { ...result(), output: "INCONCLUSIVE" }] },
  ])(
    "rejects unavailable, failed, stale, or superseded evidence %#",
    ({ results }) => {
      expect(
        getRalphTaskVerification(results, task, "candidate"),
      ).toBeUndefined();
    },
  );
  it("requires the configured check and a task state timestamp", () => {
    expect(
      getRalphTaskVerification([result()], task, "other-check"),
    ).toBeUndefined();
    expect(
      getRalphTaskVerification([result()], { id: "task" }),
    ).toBeUndefined();
  });

  it("reconciles a committed completion only for the original operation", () => {
    const operation = { runId: "run", operationId: "operation" };
    const verification = {
      ...getRalphTaskVerification([result()], task, "candidate"),
      ...operation,
    };
    const completed = {
      ...task,
      status: "completed",
      completedAt: "2026-09-30T10:02:00.000Z",
      verification,
    };
    expect(
      getRalphTaskVerification([], completed, "candidate", operation),
    ).toEqual(verification);
    expect(
      getRalphTaskVerification([], completed, "candidate", {
        ...operation,
        operationId: "later-operation",
      }),
    ).toBeUndefined();
    expect(
      getRalphTaskVerification([], completed, "candidate", {
        ...operation,
        runId: "later-run",
      }),
    ).toBeUndefined();
    expect(
      getRalphTaskVerification(
        [],
        { ...completed, completedAt: "2026-09-30T10:00:00.000Z" },
        "candidate",
        operation,
      ),
    ).toBeUndefined();
  });
});
