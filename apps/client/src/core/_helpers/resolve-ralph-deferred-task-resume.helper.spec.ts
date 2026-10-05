import { expect, it } from "vitest";
import type { RalphFlow } from "../ralph.js";
import { resolveRalphDeferredTaskResumeBlock } from "./resolve-ralph-deferred-task-resume.helper.js";

const blocks: RalphFlow["blocks"] = [
  {
    id: "verify",
    title: "Verify",
    type: "UTILITY",
    utility: {
      type: "MARK_JSON_TASK",
      status: "verifying",
      path: "tasks.json",
    },
  },
  {
    id: "repair",
    title: "Repair",
    type: "UTILITY",
    utility: {
      type: "MARK_JSON_TASK",
      status: "repairing",
      path: "tasks.json",
    },
  },
];
const task = (phase = "verifying", blockId = "verify", runId = "run") => ({
  status: "deferred",
  runId,
  stateHistory: [
    { from: "implementing", to: phase, runId, blockId },
    { from: phase, to: "deferred", runId, blockId: "defer" },
  ],
});

it("restores the run-owned phase from the pinned flow", () => {
  expect(resolveRalphDeferredTaskResumeBlock([task()], blocks, "run")).toBe(
    "verify",
  );
  expect(
    resolveRalphDeferredTaskResumeBlock(
      [task("repairing", "repair")],
      blocks,
      "run",
    ),
  ).toBe("repair");
});

it("leaves completed and active work unchanged", () => {
  expect(
    resolveRalphDeferredTaskResumeBlock(
      [{ status: "completed" }, { status: "verifying" }],
      blocks,
      "run",
    ),
  ).toBeUndefined();
});

it("rejects foreign ownership and missing pinned phases", () => {
  expect(() =>
    resolveRalphDeferredTaskResumeBlock(
      [task("verifying", "verify", "foreign")],
      blocks,
      "run",
    ),
  ).toThrow("owned by this run");
  expect(() =>
    resolveRalphDeferredTaskResumeBlock(
      [task("verifying", "missing")],
      blocks,
      "run",
    ),
  ).toThrow("pinned flow");
});

it("rejects a batch requiring different recovery phases", () => {
  expect(() =>
    resolveRalphDeferredTaskResumeBlock(
      [task(), task("repairing", "repair")],
      blocks,
      "run",
    ),
  ).toThrow("different recovery phases");
});
