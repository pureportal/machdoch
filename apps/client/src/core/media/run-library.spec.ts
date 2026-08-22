import { describe, expect, it } from "vitest";
import type { MediaRuntimeRunRecord } from "./contracts.js";
import {
  matchesMediaRunQuery,
  mergeMediaRunUpdates,
} from "./run-library.js";

const run = (
  id: string,
  overrides: Partial<MediaRuntimeRunRecord> = {},
): MediaRuntimeRunRecord => ({
  id,
  flowId: "flow:wan-loop",
  flowRevisionId: "revision:1",
  flowName: "Game character idle loop",
  planId: "plan:1",
  status: "completed",
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:01:00.000Z",
  prompt: "Game-style girl character in an idle pose",
  modelLabel: "Wan2.2 TI2V 5B",
  target: "local",
  outputCount: 2,
  diagnosticCount: 0,
  progress: 1,
  currentStep: "Completed",
  executor: "local-wan-video",
  error: null,
  failure: null,
  ...overrides,
});

describe("run library", () => {
  it("matches multi-term queries across status, model, prompt, and workflow", () => {
    const candidate = run("run:1");
    expect(matchesMediaRunQuery(candidate, "wan idle completed")).toBe(true);
    expect(matchesMediaRunQuery(candidate, "wan idle failed")).toBe(false);
  });

  it("merges fresh progress without reordering historical membership", () => {
    const original = [run("run:2"), run("run:1")];
    const updates = [
      run("run:1", {
        status: "running",
        progress: 0.5,
        currentStep: "Denoising frame 9",
      }),
    ];

    const merged = mergeMediaRunUpdates(original, updates);

    expect(merged.map((entry) => entry.id)).toEqual(["run:2", "run:1"]);
    expect(merged[1]).toMatchObject({
      status: "running",
      progress: 0.5,
      currentStep: "Denoising frame 9",
    });
  });

  it("temporarily surfaces a newly inserted run observed between snapshots", () => {
    const merged = mergeMediaRunUpdates(
      [run("run:old")],
      [
        run("run:new", { createdAt: "2026-07-25T00:02:00.000Z" }),
        run("run:old"),
      ],
    );

    expect(merged.map((entry) => entry.id)).toEqual(["run:new", "run:old"]);
  });
});
