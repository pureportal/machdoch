import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessRalphRepositoryWorkYield,
  type RalphRepositoryObservation,
} from "../_helpers/ralph-repository-work-yield.helper.js";
import {
  runRalphFlow,
  type RalphBlockExecutionResult,
  type RalphRunCheckpoint,
} from "../ralph.js";
import {
  createFlow,
  customizations,
  runtimeConfig,
} from "./ralph-test-helpers.js";

const result = (
  blockId: string,
  data: unknown,
  output: RalphBlockExecutionResult["output"] = "SUCCESS",
  status: RalphBlockExecutionResult["status"] = "completed",
): RalphBlockExecutionResult => ({
  blockId,
  output,
  status,
  attempt: 1,
  summary: blockId,
  data,
});

const observation = (signature: string): RalphRepositoryObservation => ({
  head: "head-one",
  files: [{ path: "src/value.ts", signature }],
});

const checkpoint = (
  resultsByBlock: Record<string, RalphBlockExecutionResult>,
): RalphRunCheckpoint => ({
  currentBlockId: "transform",
  transitions: 1,
  variables: {},
  resultsByBlock,
  runLog: [],
  blockResults: Object.values(resultsByBlock),
  events: [],
  errorCounts: {},
  repeatedFailures: {},
});

const createTransformFlow = (verifyOnObservationError = false) =>
  createFlow({
    blocks: [
      { id: "start", type: "START", title: "Start" },
      {
        id: "transform",
        type: "UTILITY",
        title: "Assess Work Yield",
        utility: {
          type: "TRANSFORM_JSON",
          input: "{}",
          deterministicTransform: {
            type: "repository-work-yield",
            baselineBlockId: "baseline",
            currentBlockId: "current",
            scopeGuardBlockId: "scope",
            workItemBlockId: "selection",
            trackPrevious: true,
            verifyOnObservationError,
          },
        },
      },
      { id: "success", type: "END", title: "Success", status: "success" },
    ],
    edges: [
      {
        id: "start-transform",
        from: "start",
        fromOutput: "SUCCESS",
        to: "transform",
      },
      {
        id: "transform-success",
        from: "transform",
        fromOutput: "SUCCESS",
        to: "success",
      },
    ],
  });

describe("RALPH deterministic JSON transforms", () => {
  it("counts same-file repair content for the selected task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-work-yield-"));
    const selection = {
      path: ".machdoch/tasks.json",
      jsonPath: "tasks",
      taskIds: ["task-one"],
    };
    const previous = assessRalphRepositoryWorkYield({
      baseline: observation("before"),
      current: observation("after-one"),
      workSelection: selection,
      trackPrevious: true,
    });

    try {
      const run = await runRalphFlow(
        createTransformFlow(),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          runId: "deterministic-work-yield",
          checkpoint: checkpoint({
            baseline: result("baseline", observation("before")),
            current: result("current", observation("after-two")),
            scope: result("scope", {}, "IN_SCOPE"),
            selection: result("selection", selection, "SELECTED"),
            transform: result("transform", { output: previous }),
          }),
        },
      );

      expect(run.status).toBe("completed");
      expect(
        run.blockResults.find((entry) => entry.blockId === "transform")?.data,
      ).toMatchObject({
        output: {
          madeProgress: true,
          usefulWorkProduced: true,
          workSelection: { taskIds: ["task-one"] },
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("keeps verification reachable after repository observation failure", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ralph-work-yield-error-"));
    const selection = {
      path: ".machdoch/tasks.json",
      jsonPath: "tasks",
      taskIds: ["task-one"],
    };

    try {
      const run = await runRalphFlow(
        createTransformFlow(true),
        { ...runtimeConfig, workspaceRoot: workspace },
        customizations,
        {
          runId: "deterministic-work-yield-error",
          checkpoint: checkpoint({
            baseline: result("baseline", observation("before")),
            current: result("current", undefined, "ERROR", "error"),
            scope: result("scope", {}, "IN_SCOPE"),
            selection: result("selection", selection, "SELECTED"),
          }),
        },
      );

      expect(run.status).toBe("completed");
      expect(
        run.blockResults.find((entry) => entry.blockId === "transform")?.data,
      ).toMatchObject({
        output: {
          observationFailed: true,
          shouldVerify: true,
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
