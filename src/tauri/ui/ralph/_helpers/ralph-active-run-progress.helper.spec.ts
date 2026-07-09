import type { TaskExecutionProgress } from "../../../../core/types.js";
import {
  applyActiveRunBlockProgressSnapshot,
  applyActiveRunEventSnapshot,
  createRalphBlockProgressSnapshot,
  getRalphProgressSnapshot,
  getSortedActiveBlockDetails,
  type ActiveRalphRun,
} from "./ralph-active-run-progress.helper";

const createProgress = (
  overrides: Partial<TaskExecutionProgress> = {},
): TaskExecutionProgress => ({
  task: "run Ralph flow",
  mode: "machdoch",
  state: "executing",
  message: "Working",
  executedTools: [],
  outputSections: [],
  cancellable: true,
  ...overrides,
});

const createActiveRun = (
  overrides: Partial<ActiveRalphRun> = {},
): ActiveRalphRun => ({
  id: "task-1",
  flowId: "flow-1",
  scope: "workspace",
  flowName: "Flow",
  startedAt: 1_000,
  status: "running",
  mode: "machdoch",
  provider: "openai",
  model: "gpt-5",
  variableValues: {},
  events: [],
  blockDetails: {},
  ...overrides,
});

describe("ralph active run progress helpers", () => {
  it("creates Ralph event snapshots from timeline metadata", () => {
    const snapshot = getRalphProgressSnapshot(
      createProgress({
        timelineEvent: {
          kind: "state",
          phase: "started",
          label: "Prompt started",
          metadata: {
            ralphEventType: "block-start",
            ralphBlockId: "prompt",
            ralphBlockTitle: "Draft answer",
            ralphAttempt: 2,
          },
        },
      }),
    );

    expect(snapshot).toEqual({
      eventType: "block-start",
      label: "Prompt started",
      phase: "started",
      tone: "info",
      blockId: "prompt",
      blockTitle: "Draft answer",
      activeBlockId: "prompt",
      activeBlockTitle: "Draft answer",
      attempt: 2,
    });
  });

  it("applies run event snapshots to run and block detail state", () => {
    const run = createActiveRun();
    const snapshot = getRalphProgressSnapshot(
      createProgress({
        timelineEvent: {
          kind: "output",
          phase: "completed",
          label: "Prompt completed",
          detail: "Created a draft.",
          metadata: {
            ralphEventType: "block-output",
            ralphBlockId: "prompt",
            ralphBlockTitle: "Draft answer",
            ralphOutput: "NEXT",
            ralphAttempt: 1,
          },
        },
      }),
    );

    expect(snapshot).not.toBeNull();

    const updatedRun = applyActiveRunEventSnapshot(run, snapshot!, 2_000);

    expect(updatedRun.lastEventType).toBe("block-output");
    expect(updatedRun.lastOutput).toBe("NEXT");
    expect(updatedRun.events).toHaveLength(1);
    expect(updatedRun.blockDetails.prompt).toMatchObject({
      blockId: "prompt",
      blockTitle: "Draft answer",
      output: "NEXT",
      attempt: 1,
      status: "completed",
      summary: "Created a draft.",
    });
  });

  it("captures streamed block progress for the active block", () => {
    const snapshot = createRalphBlockProgressSnapshot(
      createProgress({
        modelStream: {
          kind: "assistant",
          label: "Assistant",
          content: "partial answer",
        },
        timelineEvent: {
          kind: "model-call",
          phase: "streaming",
          label: "Streaming",
          metadata: {
            ralphActiveBlockId: "prompt",
            ralphActiveBlockTitle: "Draft answer",
          },
        },
      }),
      Date.parse("2026-06-30T10:00:00.000Z"),
    );

    expect(snapshot).toMatchObject({
      blockId: "prompt",
      blockTitle: "Draft answer",
      event: {
        timestamp: "2026-06-30T10:00:00.000Z",
        kind: "model-stream",
        label: "Assistant",
        streamKind: "assistant",
        content: "partial answer",
      },
    });

    const updatedRun = applyActiveRunBlockProgressSnapshot(
      createActiveRun(),
      snapshot!,
    );

    expect(updatedRun.currentBlockId).toBe("prompt");
    expect(updatedRun.blockDetails.prompt.progress).toHaveLength(1);
  });

  it("sorts active block details by latest progress or event timestamp", () => {
    const sortedDetails = getSortedActiveBlockDetails(
      createActiveRun({
        blockDetails: {
          older: {
            blockId: "older",
            events: [{ id: "e1", timestamp: 1_000, eventType: "block-start", label: "Older", phase: "started", tone: "info" }],
            progress: [],
          },
          newer: {
            blockId: "newer",
            events: [],
            progress: [
              {
                timestamp: "2026-06-30T10:00:00.000Z",
                kind: "message",
                label: "Newer",
              },
            ],
          },
        },
      }),
    );

    expect(sortedDetails.map((detail) => detail.blockId)).toEqual([
      "newer",
      "older",
    ]);
  });
});
