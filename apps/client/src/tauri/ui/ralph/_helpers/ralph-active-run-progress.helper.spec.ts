import { describe, expect, it } from "vitest";
import type { TaskExecutionProgress } from "../../../../core/types.js";
import {
  applyActiveRunProgress,
  type ActiveRalphRun,
} from "./ralph-active-run-progress.helper";

const createRun = (): ActiveRalphRun => ({
  id: "task-1",
  flowId: "flow-1",
  flowName: "Improve code",
  scope: "workspace",
  startedAt: 1,
  status: "running",
  mode: "machdoch",
  provider: "codex-cli",
  model: "gpt-6.1-sol",
  variableValues: {},
  events: [],
  blockDetails: {},
});

const createProgress = (
  metadata: Record<string, string>,
): TaskExecutionProgress => ({
  task: "Improve code",
  mode: "machdoch",
  state: "executing",
  message: "Running implementation",
  executedTools: [],
  outputSections: [],
  cancellable: true,
  timelineEvent: {
    kind: "state",
    phase: "started",
    label: "Running implementation",
    metadata,
  },
});

describe("applyActiveRunProgress", () => {
  it("retains startup progress before the first block is reached", () => {
    const progress = createProgress({});
    delete progress.timelineEvent;
    progress.state = "resolving-context";
    progress.message = "Preparing the Ralph CLI";
    const run = applyActiveRunProgress(createRun(), progress, 100);
    expect(run.lastMessage).toBe("Preparing the Ralph CLI");
    expect(run.lastProgressTimestamp).toBe(100);
    expect(run.currentBlockId).toBeUndefined();
    expect(run.blockDetails).toEqual({});
  });

  it("clears the previous output when a block starts another iteration or retries", () => {
    const completed = applyActiveRunProgress(
      createRun(),
      createProgress({
        ralphEventType: "block-output",
        ralphBlockId: "implement",
        ralphOutput: "SUCCESS",
      }),
      100,
    );
    expect(completed.blockDetails.implement?.status).toBe("completed");

    for (const eventType of ["block-start", "retry"]) {
      const running = applyActiveRunProgress(
        completed,
        createProgress({
          ralphEventType: eventType,
          ralphBlockId: "implement",
        }),
        200,
      );
      expect(running.blockDetails.implement).toMatchObject({
        status: "running",
      });
      expect(running.blockDetails.implement?.output).toBeUndefined();
      expect(running.blockDetails.implement?.summary).toBeUndefined();
      expect(running.lastOutput).toBeUndefined();
    }
  });

  it("restores the current block, timeline, and node detail from retained progress", () => {
    const run = applyActiveRunProgress(
      createRun(),
      createProgress({
        ralphEventType: "block-start",
        ralphBlockId: "implement",
        ralphBlockTitle: "Implement Improvement",
      }),
      100,
    );

    expect(run.currentBlockId).toBe("implement");
    expect(run.currentBlockTitle).toBe("Implement Improvement");
    expect(run.events).toHaveLength(1);
    expect(run.blockDetails.implement?.progress).toHaveLength(1);
    expect(run.lastProgressTimestamp).toBe(100);
  });

  it("keeps the routed destination active while recording the completed source block", () => {
    const run = applyActiveRunProgress(
      createRun(),
      createProgress({
        ralphEventType: "edge-route",
        ralphBlockId: "select",
        ralphBlockTitle: "Select Task",
        ralphActiveBlockId: "implement",
        ralphActiveBlockTitle: "Implement Improvement",
      }),
      100,
    );

    expect(run.currentBlockId).toBe("implement");
    expect(run.currentBlockTitle).toBe("Implement Improvement");
    expect(run.blockDetails.select?.events).toHaveLength(1);
  });

  it("ignores snapshots already delivered live and older reconciliation responses", () => {
    const progress = createProgress({
      ralphEventType: "block-start",
      ralphBlockId: "implement",
    });
    const run = applyActiveRunProgress(createRun(), progress, 200);

    expect(applyActiveRunProgress(run, progress, 200)).toBe(run);
    expect(
      applyActiveRunProgress(
        run,
        createProgress({
          ralphEventType: "block-start",
          ralphBlockId: "select",
        }),
        100,
      ),
    ).toBe(run);
    expect(run.events).toHaveLength(1);
  });

  it("restores streaming agent output even when lifecycle events have aged out", () => {
    const progress = createProgress({
      ralphBlockId: "implement",
      ralphBlockTitle: "Implement Improvement",
    });
    progress.actionOutput = {
      toolName: "run_shell_command",
      stream: "stdout",
      chunk: "Checking changes",
    };
    const completed = applyActiveRunProgress(
      createRun(),
      createProgress({
        ralphEventType: "block-output",
        ralphBlockId: "implement",
        ralphOutput: "SUCCESS",
      }),
      100,
    );
    const run = applyActiveRunProgress(completed, progress, 300);

    expect(run.currentBlockId).toBe("implement");
    expect(run.blockDetails.implement?.status).toBe("running");
    expect(run.blockDetails.implement?.output).toBeUndefined();
    expect(run.lastOutput).toBeUndefined();
    expect(run.blockDetails.implement?.progress.at(-1)).toMatchObject({
      kind: "action-output",
      content: "Checking changes",
    });
  });
});
