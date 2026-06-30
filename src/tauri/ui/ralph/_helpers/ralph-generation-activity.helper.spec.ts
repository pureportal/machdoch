import { describe, expect, it, vi } from "vitest";

import type { RalphGenerationEvent } from "../../../../core/ralph-generation.js";
import type { TaskExecutionProgress } from "../../../../core/types.js";
import {
  appendGenerationActivity,
  applyGenerationActivity,
  createGenerationActivityFromProgress,
  createGenerationActivityFromResultEvent,
  type RalphGenerationActivityState,
} from "./ralph-generation-activity.helper";

const createProgress = (
  overrides: Partial<TaskExecutionProgress> = {},
): TaskExecutionProgress => ({
  task: "Generate Ralph flow",
  mode: "full",
  state: "running",
  message: "Fallback progress",
  executedTools: [],
  outputSections: [],
  cancellable: true,
  ...overrides,
});

describe("ralph-generation-activity helper", () => {
  it("ignores progress without Ralph generation metadata", () => {
    expect(createGenerationActivityFromProgress(createProgress(), 100)).toBeNull();
  });

  it("creates activity from task progress metadata", () => {
    const activity = createGenerationActivityFromProgress(
      createProgress({
        timelineEvent: {
          id: "event-1",
          label: "Validated generated flow",
          description: "Validation completed",
          phase: "validate",
          tone: "success",
          detail: "All checks passed",
          provider: "openai",
          model: "gpt-4.1",
          metadata: {
            ralphGenerationEventType: "validation",
            ralphGenerationRound: 2,
            ralphGenerationMaxRounds: 3,
            ralphGenerationActor: "validator",
            ralphGenerationFlowPath: "flows/main.json",
            ralphGenerationTempFlowPath: ".machdoch/tmp/main.json",
            ralphGenerationValidationValid: true,
            ralphGenerationValidationErrorCount: 0,
            ralphGenerationValidationWarningCount: 1,
            ralphGenerationValidatorDecision: "continue",
            ralphGenerationBlockCount: 5,
            ralphGenerationEdgeCount: 4,
          },
        },
      }),
      123,
    );

    expect(activity).toMatchObject({
      id: "123-validation-2-Validated generated flow",
      type: "validation",
      label: "Validated generated flow",
      timestamp: 123,
      detail: "All checks passed",
      round: 2,
      maxRounds: 3,
      actor: "validator",
      provider: "openai",
      model: "gpt-4.1",
      flowPath: "flows/main.json",
      tempFlowPath: ".machdoch/tmp/main.json",
      validationValid: true,
      validationErrorCount: 0,
      validationWarningCount: 1,
      validatorDecision: "continue",
      blockCount: 5,
      edgeCount: 4,
    });
  });

  it("creates activity from generation result events", () => {
    const activity = createGenerationActivityFromResultEvent({
      type: "flow-written",
      generationRunId: "run-1",
      message: "Flow written",
      createdAt: "2026-06-30T10:00:00.000Z",
      round: 1,
      maxRounds: 2,
      actor: "generator",
      provider: "openai",
      model: "gpt-4.1",
      flowPath: "flows/main.json",
      generationFlowPath: ".machdoch/tmp/main.json",
      validationValid: false,
      validationErrorCount: 1,
      validationWarningCount: 2,
      validatorDecision: "revise",
      blockCount: 3,
      edgeCount: 2,
    } satisfies RalphGenerationEvent);

    expect(activity).toMatchObject({
      id: "2026-06-30T10:00:00.000Z-flow-written-1-Flow written",
      type: "flow-written",
      label: "Flow written",
      timestamp: Date.parse("2026-06-30T10:00:00.000Z"),
      round: 1,
      maxRounds: 2,
      actor: "generator",
      provider: "openai",
      model: "gpt-4.1",
      flowPath: "flows/main.json",
      tempFlowPath: ".machdoch/tmp/main.json",
      validationValid: false,
      validationErrorCount: 1,
      validationWarningCount: 2,
      validatorDecision: "revise",
      blockCount: 3,
      edgeCount: 2,
    });
  });

  it("falls back to current time for invalid result event timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-30T12:00:00.000Z"));

    try {
      expect(
        createGenerationActivityFromResultEvent({
          type: "started",
          generationRunId: "run-1",
          message: "Started",
          createdAt: "invalid",
        }).timestamp,
      ).toBe(Date.parse("2026-06-30T12:00:00.000Z"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("appends unique activity in timestamp order and caps history", () => {
    const current = [{ id: "b", type: "event", label: "B", timestamp: 2 }];
    const manyEvents = Array.from({ length: 82 }, (_, index) => ({
      id: `event-${index}`,
      type: "event",
      label: `Event ${index}`,
      timestamp: index + 3,
    }));

    const appended = appendGenerationActivity(current, [
      { id: "b", type: "event", label: "Duplicate", timestamp: 1 },
      { id: "a", type: "event", label: "A", timestamp: 1 },
      ...manyEvents,
    ]);

    expect(appended).toHaveLength(80);
    expect(appended[0]?.id).toBe("event-2");
    expect(appended.at(-1)?.id).toBe("event-81");
  });

  it("applies activity details to a generation job state", () => {
    const job: RalphGenerationActivityState & { id: string } = {
      id: "job-1",
      summary: "Starting",
      activity: [],
    };

    expect(
      applyGenerationActivity(job, {
        id: "event-1",
        type: "validation",
        label: "Validation complete",
        timestamp: 10,
        round: 2,
        maxRounds: 3,
        actor: "validator",
        provider: "openai",
        model: "gpt-4.1",
        flowPath: "flows/main.json",
        tempFlowPath: ".machdoch/tmp/main.json",
        validationValid: true,
        validationErrorCount: 0,
        validationWarningCount: 1,
        validatorDecision: "continue",
        blockCount: 5,
        edgeCount: 4,
      }),
    ).toMatchObject({
      id: "job-1",
      summary: "Validation complete",
      currentRound: 2,
      maxRounds: 3,
      currentActor: "validator",
      provider: "openai",
      model: "gpt-4.1",
      flowPath: "flows/main.json",
      tempFlowPath: ".machdoch/tmp/main.json",
      validationValid: true,
      validationErrorCount: 0,
      validationWarningCount: 1,
      validatorDecision: "continue",
      blockCount: 5,
      edgeCount: 4,
      activity: [
        {
          id: "event-1",
        },
      ],
    });
  });
});
