import { describe, expect, it } from "vitest";
import type { MediaRunDetail } from "../../../core/media/contracts.js";
import { createImageRecipeFlow } from "../../../core/media/compiler.js";
import { DEFAULT_IMAGE_RECIPE_SETTINGS } from "./media-studio-store";
import { MediaGenerationTiming } from "./media-generation-timing";

const start = Date.parse("2026-09-14T12:00:00Z");
const run = (
  id: string,
  seconds: number,
  status: MediaRunDetail["status"] = "completed",
): MediaRunDetail => ({
  id,
  flowId: "flow",
  flowRevisionId: "revision",
  flowName: "Image",
  planId: "plan",
  status,
  createdAt: new Date(start).toISOString(),
  updatedAt: new Date(start + seconds * 1000).toISOString(),
  prompt: "Bowl",
  modelLabel: "Model",
  target: "local",
  outputCount: 1,
  diagnosticCount: 0,
  progress: 0.5,
  currentStep: "Generating",
  executor: "local-image-flow",
  error: null,
  failure: null,
  events: [],
  assets: [],
  providerJobs: [],
  humanReviews: [],
  nodeExecutions: [],
  planSnapshot: null,
});
const flow = createImageRecipeFlow({
  id: "flow",
  createdAt: new Date(start).toISOString(),
  settings: { ...DEFAULT_IMAGE_RECIPE_SETTINGS, prompt: "Bowl" },
});

describe("generation completion estimates", () => {
  it("averages recent successful runs and separates hardware and sampling settings", () => {
    const timing = new MediaGenerationTiming();
    timing.setHardware("gpu-a");
    timing.registerFlow("revision", flow);
    timing.record(run("a", 100), "gpu-a");
    timing.record(run("b", 130), "gpu-a");
    timing.record(run("failed", 2000, "failed"), "gpu-a");
    timing.record(run("other-gpu", 2000), "gpu-b");
    expect(timing.estimate(run("next", 20, "running"), start + 20_000)).toEqual(
      { remainingMs: 100_000, scope: "run" },
    );
    timing.registerFlow("different", {
      ...flow,
      nodes: flow.nodes.map((node) =>
        node.type === "task.generate-image"
          ? { ...node, config: { ...node.config, numInferenceSteps: 60 } }
          : node,
      ),
    });
    expect(
      timing.estimate(
        { ...run("new-settings", 20, "running"), flowRevisionId: "different" },
        start + 20_000,
      ),
    ).toBeNull();
    timing.setHardware("gpu-c");
    expect(
      timing.estimate(run("unknown", 20, "running"), start + 20_000),
    ).toBeNull();
  });

  it("uses sampling speed without calling a partial stage the whole workflow", () => {
    const timing = new MediaGenerationTiming();
    const active = run("active", 70, "running");
    active.currentStep = "Sampling 3/8";
    active.events = [1, 2, 3].map((step) => ({
      id: step,
      sequence: step,
      runId: active.id,
      kind: "node_state_changed",
      message: `Sampling ${step}/8`,
      createdAt: new Date(start + step * 20_000).toISOString(),
      progress: step / 8,
      nodeId: "generate",
      stepId: null,
    }));
    expect(timing.estimate(active, start + 70_000)).toEqual({
      remainingMs: 90_000,
      scope: "step",
    });
    expect(timing.estimate(active, start + 300_000)).toBeNull();
    active.status = "canceled";
    expect(timing.estimate(active, start + 70_000)).toBeNull();
  });

  it("does not count queued time or show a negative countdown after the estimate expires", () => {
    const timing = new MediaGenerationTiming();
    timing.registerFlow("revision", flow);
    timing.setHardware("gpu");
    timing.record(run("completed", 60), "gpu");
    expect(
      timing.estimate(run("queued", 999, "queued"), start + 999_000),
    ).toEqual({ remainingMs: 60_000, scope: "run" });
    expect(
      timing.estimate(run("slow", 80, "running"), start + 80_000),
    ).toBeNull();
  });
  it("combines measured node durations for a new workflow", () => {
    const timing = new MediaGenerationTiming();
    timing.setHardware("gpu");
    timing.registerFlow("revision", flow);
    const completed = run("measured", 90);
    completed.nodeExecutions = [
      {
        runId: completed.id,
        nodeId: "generate",
        nodeType: "task.generate-image",
        nodeLabel: "Generate",
        ordinal: 0,
        status: "completed",
        activeStepId: null,
        runtimePhase: null,
        attempt: 1,
        progress: 1,
        message: null,
        startedAt: new Date(start).toISOString(),
        updatedAt: new Date(start + 60000).toISOString(),
        finishedAt: new Date(start + 60000).toISOString(),
        stateSequence: 1,
      },
    ];
    timing.record(completed, "gpu");
    const generation = flow.nodes.find((node) => node.id === "generate")!;
    timing.registerFlow("combined", {
      ...flow,
      nodes: [...flow.nodes, { ...generation, id: "second" }],
      edges: [
        ...flow.edges,
        {
          id: "prompt-to-second",
          fromNodeId: "prompt",
          fromPortId: "prompt",
          toNodeId: "second",
          toPortId: "prompt",
        },
      ],
    });
    const active = {
      ...run("combined-run", 20, "running"),
      flowRevisionId: "combined",
      nodeExecutions: [
        {
          ...completed.nodeExecutions[0]!,
          status: "running" as const,
          finishedAt: null,
        },
      ],
    };
    expect(timing.estimate(active, start + 20000)).toEqual({
      remainingMs: 100000,
      scope: "run",
    });
  });

  it("uses execution events instead of queue time or later record updates", () => {
    const timing = new MediaGenerationTiming();
    timing.setHardware("gpu");
    timing.registerFlow("revision", flow);
    const completed = run("measured", 900);
    completed.events = [
      {
        id: 1,
        sequence: 1,
        runId: completed.id,
        kind: "run_started",
        createdAt: new Date(start + 120000).toISOString(),
        message: "Started",
        progress: 0,
        stepId: null,
        nodeId: null,
      },
      {
        id: 2,
        sequence: 2,
        runId: completed.id,
        kind: "run_completed",
        createdAt: new Date(start + 180000).toISOString(),
        message: "Completed",
        progress: 1,
        stepId: null,
        nodeId: null,
      },
    ];
    timing.record(completed, "gpu");
    expect(timing.estimate(run("next", 20, "running"), start + 20000)).toEqual({
      remainingMs: 40000,
      scope: "run",
    });
  });
});
