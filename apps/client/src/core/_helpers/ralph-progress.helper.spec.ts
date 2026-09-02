import { describe, expect, it } from "vitest";
import { createExecutionResult } from "../__test__/ralph-test-helpers.js";
import type { RalphBlockExecutionResult, RalphFlowBlock } from "../ralph.js";
import {
  assessRalphProgress,
  createRalphProgressState,
} from "./ralph-progress.helper.js";

const prompt: RalphFlowBlock = {
  id: "think",
  type: "PROMPT",
  title: "Think",
  prompt: "Think",
};
const git: RalphFlowBlock = {
  id: "diff",
  type: "UTILITY",
  title: "Diff",
  utility: { type: "GIT_DIFF_SUMMARY" },
};
const verification: RalphFlowBlock = {
  id: "candidate",
  type: "UTILITY",
  title: "Candidate",
  utility: { type: "RUN_CHECK" },
};
const result = (
  blockId: string,
  data?: unknown,
): RalphBlockExecutionResult => ({
  blockId,
  output: "SUCCESS",
  status: "completed",
  attempt: 1,
  summary: "done",
  data,
});

describe("RALPH progress detector", () => {
  it("does not treat repeated model output as progress and detects a cycle", () => {
    let state = createRalphProgressState();
    for (let transition = 1; transition <= 3; transition += 1) {
      state = assessRalphProgress(
        state,
        prompt,
        result(prompt.id),
        transition,
        { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
      ).state;
    }

    expect(state.stalledReason).toContain("semantic cycle");
  });

  it("leaves repeated execution failures to retry and recovery handling", () => {
    let state = createRalphProgressState();
    for (let transition = 1; transition <= 3; transition += 1) {
      state = assessRalphProgress(
        state,
        prompt,
        {
          ...result(prompt.id),
          output: "ERROR",
          status: "error",
          attempt: transition,
          summary: "Execution failed.",
          error: "Execution failed.",
        },
        transition,
        { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
      ).state;
    }

    expect(state.recent).toHaveLength(3);
    expect(state.recent.every((entry) => !entry.cycleEligible)).toBe(true);
    expect(state.consecutiveNoProgress).toBe(3);
    expect(state.stalledReason).toBeUndefined();
  });

  it("reassesses derived stall state when a run resumes", () => {
    const assessment = assessRalphProgress(
      createRalphProgressState({
        consecutiveNoProgress: 3,
        stalledReason:
          "Detected a 1-step semantic cycle repeated 3 times without objective progress.",
      }),
      prompt,
      result(prompt.id),
      4,
      { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
    );

    expect(assessment.stalled).toBe(false);
    expect(assessment.state.stalledReason).toBeUndefined();
    expect(assessment.state.consecutiveNoProgress).toBe(4);
  });

  it("counts a changed repository fingerprint as meaningful progress", () => {
    let state = assessRalphProgress(
      createRalphProgressState(),
      git,
      result(git.id, { files: [{ path: "a.ts", signature: "before" }] }),
      1,
      { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
    ).state;
    const assessment = assessRalphProgress(
      state,
      git,
      result(git.id, { files: [{ path: "a.ts", signature: "after" }] }),
      2,
      { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
    );

    expect(assessment.evidence.meaningful).toBe(true);
    expect(assessment.state.meaningfulTransitions).toBe(1);
    expect(assessment.state.consecutiveNoProgress).toBe(0);
  });

  it("counts complete machine-observed product file changes as progress", () => {
    const promptResult = result(prompt.id);
    const completeStage = { state: "complete" as const };
    promptResult.result = createExecutionResult({
      fileChanges: {
        files: [
          {
            path: "src/product.ts",
            operation: "modified",
            entryType: "text",
            oldMode: "100644",
            newMode: "100644",
            oldObjectId: "before",
            newObjectId: "after",
            lineAnalysis: { state: "complete", additions: 1, deletions: 0 },
          },
        ],
        totalFiles: 1,
        additions: 1,
        deletions: 0,
        binaryFiles: 0,
        gitlinkFiles: 0,
        symlinkFiles: 0,
        modeOnlyFiles: 0,
        failedFiles: 0,
        status: "complete",
        completeness: {
          discovery: completeStage,
          startSnapshots: completeStage,
          finishSnapshots: completeStage,
          renameAnalysis: completeStage,
          lineAnalysis: completeStage,
          persistence: completeStage,
        },
        attribution: "workspace-observed",
        repositoryCount: 1,
        issues: [],
      },
    });

    const assessment = assessRalphProgress(
      createRalphProgressState(),
      prompt,
      promptResult,
      1,
      { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
    );

    expect(assessment.evidence).toMatchObject({
      channel: "repository-execution",
      meaningful: true,
    });
  });

  it("does not count engine control-file changes as product progress", () => {
    const promptResult = result(prompt.id);
    const completeStage = { state: "complete" as const };
    promptResult.result = createExecutionResult({
      fileChanges: {
        files: [
          {
            path: ".machdoch/ralph/counters.json",
            operation: "modified",
            entryType: "text",
            oldMode: "100644",
            newMode: "100644",
            oldObjectId: "before",
            newObjectId: "after",
            lineAnalysis: { state: "complete", additions: 1, deletions: 0 },
          },
        ],
        totalFiles: 1,
        additions: 1,
        deletions: 0,
        binaryFiles: 0,
        gitlinkFiles: 0,
        symlinkFiles: 0,
        modeOnlyFiles: 0,
        failedFiles: 0,
        status: "complete",
        completeness: {
          discovery: completeStage,
          startSnapshots: completeStage,
          finishSnapshots: completeStage,
          renameAnalysis: completeStage,
          lineAnalysis: completeStage,
          persistence: completeStage,
        },
        attribution: "workspace-observed",
        repositoryCount: 1,
        issues: [],
      },
    });

    const assessment = assessRalphProgress(
      createRalphProgressState(),
      prompt,
      promptResult,
      1,
      { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
    );

    expect(assessment.evidence).toMatchObject({
      channel: "control",
      meaningful: false,
    });
  });

  it("restores state and detects a stagnant transition budget", () => {
    let state = createRalphProgressState({ consecutiveNoProgress: 1 });
    state = assessRalphProgress(state, prompt, result(prompt.id), 2, {
      maxStagnantTransitions: 2,
      maxRepeatedCycle: 5,
    }).state;

    expect(state.stalledReason).toContain("2 transitions");
  });

  it("counts the first successful candidate verification as progress", () => {
    const assessment = assessRalphProgress(
      createRalphProgressState(),
      verification,
      result(verification.id, {
        verification: {
          comparison: { disposition: "PASSED" },
        },
      }),
      1,
      { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
    );

    expect(assessment.evidence.meaningful).toBe(true);
    expect(assessment.state.meaningfulTransitions).toBe(1);
  });

  it("keeps work-item path and block fallback identities distinct", () => {
    const pathTarget: RalphFlowBlock = {
      id: "mark-with-path",
      type: "UTILITY",
      title: "Mark with path",
      utility: { type: "MARK_JSON_TASK", path: "shared-identity" },
    };
    const blockTarget: RalphFlowBlock = {
      id: "shared-identity",
      type: "UTILITY",
      title: "Mark with block identity",
      utility: { type: "MARK_JSON_TASK" },
    };
    const first = assessRalphProgress(
      createRalphProgressState(),
      pathTarget,
      result(pathTarget.id, { taskIds: ["task"] }),
      1,
      { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
    );
    const second = assessRalphProgress(
      first.state,
      blockTarget,
      result(blockTarget.id, { taskIds: ["task"] }),
      2,
      { maxStagnantTransitions: 20, maxRepeatedCycle: 3 },
    );

    expect(first.evidence.meaningful).toBe(true);
    expect(second.evidence.meaningful).toBe(true);
    expect(second.state.channelFingerprints).toHaveLength(2);
  });
});
