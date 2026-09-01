import { describe, expect, it } from "vitest";
import {
  assessRalphRepositoryWorkYield,
  resolveRalphCodeImprovementPlan,
  resolveRalphVisualRuntime,
  type RalphRepositoryObservation,
  type RalphWorkSelectionIdentity,
} from "./ralph-repository-work-yield.helper.js";
import { canonicalDigest } from "../instruction-system/index.js";

const observation = (
  files: Array<{ path: string; signature: string }>,
  head = "head-one",
): RalphRepositoryObservation => ({ head, files });

const workSelection = (taskIds: string[]): RalphWorkSelectionIdentity => ({
  path: ".machdoch/tasks.json",
  jsonPath: "tasks",
  taskIds,
});

describe("RALPH repository work yield", () => {
  it("counts content changes to the same file and rejects an identical repetition", () => {
    const baseline = observation([{ path: "src/a.ts", signature: "before" }]);
    const first = assessRalphRepositoryWorkYield({
      baseline,
      current: observation([{ path: "src/a.ts", signature: "after-one" }]),
      workSelection: workSelection(["task-one"]),
      trackPrevious: true,
    });
    const repaired = assessRalphRepositoryWorkYield({
      baseline,
      current: observation([{ path: "src/a.ts", signature: "after-two" }]),
      workSelection: workSelection(["task-one"]),
      previous: first,
      trackPrevious: true,
    });
    const repeated = assessRalphRepositoryWorkYield({
      baseline,
      current: observation([{ path: "src/a.ts", signature: "after-two" }]),
      workSelection: workSelection(["task-one"]),
      previous: repaired,
      trackPrevious: true,
    });

    expect(first.madeProgress).toBe(true);
    expect(repaired.madeProgress).toBe(true);
    expect(repaired.repositoryFingerprint).not.toBe(
      first.repositoryFingerprint,
    );
    expect(repeated).toMatchObject({ madeProgress: false, stalled: true });
  });

  it("scopes repetition detection to an explicit work selection", () => {
    const baseline = observation([]);
    const first = assessRalphRepositoryWorkYield({
      baseline,
      current: observation([{ path: "src/a.ts", signature: "after" }]),
      workSelection: workSelection(["task-one", "task-two"]),
      trackPrevious: true,
    });
    const nextTask = assessRalphRepositoryWorkYield({
      baseline,
      current: observation([{ path: "src/a.ts", signature: "after" }]),
      workSelection: workSelection(["task-one\0task-two"]),
      previous: first,
      trackPrevious: true,
    });

    expect(nextTask.madeProgress).toBe(true);
  });

  it("detects files removed relative to the baseline", () => {
    const result = assessRalphRepositoryWorkYield({
      baseline: observation([{ path: "src/removed.ts", signature: "before" }]),
      current: observation([]),
    });

    expect(result).toMatchObject({
      changedFiles: ["src/removed.ts"],
      implementationFiles: ["src/removed.ts"],
      producedWork: true,
    });
  });

  it("distinguishes state-file-only changes and preserves verification on observation failure", () => {
    const stateOnly = assessRalphRepositoryWorkYield({
      baseline: observation([]),
      current: observation([
        { path: ".machdoch/active-goal.json", signature: "state" },
      ]),
      excludedPaths: [".machdoch/active-goal.json"],
    });
    const failedObservation = assessRalphRepositoryWorkYield({
      baseline: observation([]),
      current: observation([]),
      observationFailed: true,
      verifyOnObservationError: true,
    });

    expect(stateOnly).toMatchObject({
      onlyExcludedFilesChanged: true,
      producedWork: false,
      shouldVerify: false,
    });
    expect(failedObservation).toMatchObject({
      observationFailed: true,
      shouldVerify: true,
    });
  });
});

describe("RALPH deterministic starter transforms", () => {
  it("creates collision-safe improvement plan identities from structured task ids", () => {
    const resolve = (taskIds: string[]) =>
      resolveRalphCodeImprovementPlan({
        draft: {
          decision: "IMPLEMENT",
          rationale: "Implement",
          stopReason: "",
          tasks: taskIds.map((id) => ({ id, status: "planned" })),
        },
        selection: { scope: { id: "scope-one", paths: ["src"] } },
        constitution: {},
        research: "Research",
        stableDigest: canonicalDigest,
      });

    expect(resolve(["a", "b"]).planId).not.toBe(resolve(["a,b"]).planId);
    expect(() =>
      resolveRalphCodeImprovementPlan({
        draft: { decision: "MAYBE", tasks: [] },
        selection: { scope: { id: "scope-one" } },
        constitution: {},
        research: "",
        stableDigest: canonicalDigest,
      }),
    ).toThrow("Improvement plan requires a valid draft and selected scope.");
  });

  it("returns explicit visual-runtime capabilities", () => {
    const transform = {
      type: "visual-runtime",
      commandsBlockId: "commands",
      targetUrlVariable: "targetUrl",
      healthUrlVariable: "healthUrl",
      serverCommandVariable: "serverCommand",
      serverCwdVariable: "serverCwd",
      screenshotPathVariable: "screenshotPath",
    } as const;

    expect(
      resolveRalphVisualRuntime({
        commands: {
          targetUrl: "http://localhost:3000",
          serveCommand: "pnpm dev",
          rootPath: "apps/web",
        },
        variables: {},
        transform,
      }),
    ).toMatchObject({
      visualStatus: "managed-or-reused",
      targetSource: "detected",
      commandSource: "detected",
    });
    expect(
      resolveRalphVisualRuntime({
        commands: {},
        variables: { screenshotPath: "artifacts/page.png" },
        transform,
      }),
    ).toMatchObject({ visualStatus: "screenshot-only" });
    expect(
      resolveRalphVisualRuntime({
        commands: {},
        variables: {},
        transform,
      }),
    ).toMatchObject({ visualStatus: "degraded-unavailable" });
  });
});
