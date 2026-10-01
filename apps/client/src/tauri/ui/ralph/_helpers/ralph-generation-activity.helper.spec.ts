import { describe, expect, it } from "vitest";
import type { TaskExecutionProgress } from "../../../../core/types.js";
import {
  applyGenerationActivity,
  applyRetainedGenerationProgress,
  type RalphGenerationActivityState,
} from "./ralph-generation-activity.helper";

const createJob = (): RalphGenerationActivityState => ({
  summary: "Starting generation",
  activity: [],
});

const progress = (label: string, round: number): TaskExecutionProgress => ({
  task: "Generate flow",
  mode: "machdoch",
  state: "executing",
  message: label,
  executedTools: [],
  outputSections: [],
  cancellable: true,
  timelineEvent: {
    kind: "state",
    phase: "started",
    label,
    metadata: {
      ralphGenerationEventType: "round-start",
      ralphGenerationRound: round,
    },
  },
});

describe("retained RALPH generation activity", () => {
  it("restores the latest activity and round after reopening and polling again", () => {
    const events = [
      { timestamp: 200, progress: progress("Validating flow", 2) },
      { timestamp: 100, progress: progress("Generating flow", 1) },
    ];
    const job = applyRetainedGenerationProgress(createJob(), events);
    expect(job.summary).toBe("Validating flow");
    expect(job.currentRound).toBe(2);
    expect(job.activity.map((event) => event.label)).toEqual([
      "Generating flow",
      "Validating flow",
    ]);
    expect(applyRetainedGenerationProgress(job, events)).toBe(job);
  });

  it("keeps live progress newer than a delayed snapshot and ignores duplicates", () => {
    const event = {
      id: "live",
      type: "round-start",
      label: "Live round",
      round: 3,
      timestamp: 300,
    };
    const job = applyGenerationActivity(createJob(), event);
    const restored = applyRetainedGenerationProgress(job, [
      { timestamp: 100, progress: progress("Old round", 1) },
    ]);
    expect(restored).toBe(job);
    expect(applyGenerationActivity(job, event)).toBe(job);
    expect(job.currentRound).toBe(3);
  });

  it("bounds repeated polling of a long-running generation", () => {
    const events = Array.from({ length: 160 }, (_, index) => ({
      timestamp: index + 1,
      progress: progress(`Round ${index + 1}`, index + 1),
    }));
    const job = applyRetainedGenerationProgress(createJob(), events);
    expect(job.activity).toHaveLength(80);
    expect(applyRetainedGenerationProgress(job, events)).toBe(job);
    expect(job.currentRound).toBe(160);
  });
});
