import { describe, expect, it } from "vitest";

import type {
  MediaAssetRecord,
  MediaCompiledPlan,
  MediaFlow,
  MediaNodeExecutionRecord,
  MediaNodeExecutionStatus,
  MediaRunDetail,
  MediaRunPlanSnapshot,
} from "../../../core/media/contracts.js";
import {
  projectMediaRunOverlay,
  selectMediaRunOutputAssetForNode,
  selectMediaRunOverlayForCurrentFlow,
} from "./media-run-overlay";

const flow = {
  id: "flow-1",
  name: "Image flow",
  description: "",
  schemaVersion: 1,
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:00:00.000Z",
  variables: [],
  variableBindings: {},
  presets: [],
  activePresetId: null,
  nodes: [
    {
      id: "source",
      type: "source.prompt",
      version: 1,
      label: "Prompt",
      layer: "source",
      config: { prompt: "portrait" },
    },
    {
      id: "task",
      type: "task.generate-image",
      version: 1,
      label: "Generate",
      layer: "task",
      config: {},
    },
    {
      id: "output",
      type: "output.asset",
      version: 1,
      label: "Output",
      layer: "output",
      config: {},
    },
  ],
  edges: [],
} as MediaFlow;

const plan = {
  flowId: flow.id,
  flowFingerprint: "fingerprint-1",
} as MediaCompiledPlan;

const snapshot: MediaRunPlanSnapshot = {
  schemaVersion: 1,
  planId: "plan-1",
  flowId: flow.id,
  flowFingerprint: plan.flowFingerprint,
  compiledAt: "2026-08-21T10:00:00.000Z",
  nodes: flow.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    label: node.label,
    layer: node.layer,
  })),
  steps: [
    { id: "source-step", sourceNodeId: "source" },
    { id: "task-step", sourceNodeId: "task" },
    { id: "output-step", sourceNodeId: "output" },
  ] as MediaRunPlanSnapshot["steps"],
};

const nodeExecution = (
  nodeId: string,
  status: MediaNodeExecutionStatus,
): MediaNodeExecutionRecord => ({
  runId: "run-1",
  nodeId,
  nodeType: flow.nodes.find((node) => node.id === nodeId)?.type ?? "unknown",
  nodeLabel: flow.nodes.find((node) => node.id === nodeId)?.label ?? nodeId,
  ordinal: flow.nodes.findIndex((node) => node.id === nodeId),
  status,
  activeStepId: null,
  runtimePhase: null,
  attempt: 1,
  progress: null,
  message: null,
  startedAt: null,
  updatedAt: "2026-08-21T10:00:01.000Z",
  finishedAt: null,
  stateSequence: 1,
});

const asset = (
  id: string,
  outputIndex = 0,
  outputNodeId = "output",
): MediaAssetRecord => ({
  id,
  runId: "run-1",
  digest: `digest-${id}`,
  kind: "image",
  mimeType: "image/png",
  byteSize: 1,
  width: 1,
  height: 1,
  createdAt: "2026-08-21T10:00:02.000Z",
  outputIndex,
  fixture: false,
  operation: {
    kind: "remote-image-generation",
    providerId: "openai",
    modelId: "openai:gpt-image-2",
    providerRequestId: "request-1",
    flowRevisionId: "revision-1",
    output: { index: outputIndex, outputNodeId },
  },
  sourceAssetIds: [],
  tags: [],
});

const run = (
  status: MediaRunDetail["status"],
  executions: readonly MediaNodeExecutionRecord[],
  assets: readonly MediaAssetRecord[] = [],
): MediaRunDetail => ({
  id: "run-1",
  flowId: flow.id,
  flowRevisionId: null,
  flowName: flow.name,
  planId: snapshot.planId,
  status,
  createdAt: "2026-08-21T10:00:00.000Z",
  updatedAt: "2026-08-21T10:00:03.000Z",
  prompt: "portrait",
  modelLabel: "Model",
  target: "local",
  outputCount: 1,
  diagnosticCount: 0,
  progress: 0.5,
  currentStep: "Generate",
  executor: "local-image-flow",
  error: null,
  failure: null,
  events: [],
  assets: [...assets],
  providerJobs: [],
  humanReviews: [],
  nodeExecutions: [...executions],
  planSnapshot: snapshot,
});

describe("projectMediaRunOverlay", () => {
  it("follows durable node state through success and clears active nodes at completion", () => {
    const queued = run("queued", [
      nodeExecution("source", "queued"),
      nodeExecution("task", "pending"),
      nodeExecution("output", "pending"),
    ]);
    const running = run("running", [
      nodeExecution("source", "completed"),
      nodeExecution("task", "running"),
      nodeExecution("output", "pending"),
    ]);
    const completed = run("completed", [
      nodeExecution("source", "completed"),
      nodeExecution("task", "completed"),
      nodeExecution("output", "completed"),
    ]);

    expect(projectMediaRunOverlay({ flow, plan, run: queued })?.activeNodeIds).toEqual([]);
    expect(projectMediaRunOverlay({ flow, plan, run: running })?.activeNodeIds).toEqual([
      "task",
    ]);
    expect(projectMediaRunOverlay({ flow, plan, run: completed })?.activeNodeIds).toEqual([]);
  });

  it("does not animate nodes that are waiting or blocked", () => {
    const waiting = run("waiting-for-review", [
      nodeExecution("source", "completed"),
      nodeExecution("task", "waiting-for-review"),
      nodeExecution("output", "pending"),
    ]);

    const projection = projectMediaRunOverlay({ flow, plan, run: waiting });
    expect(projection?.observations.get("task")?.label).toBe("Awaiting review");
    expect(projection?.activeNodeIds).toEqual([]);
  });

  it("does not mark a queued retry as the active node", () => {
    const retrying = run("queued", [
      nodeExecution("source", "completed"),
      nodeExecution("task", "retrying"),
      nodeExecution("output", "pending"),
    ]);

    expect(projectMediaRunOverlay({ flow, plan, run: retrying })?.activeNodeIds).toEqual([]);
  });

  it("marks later nodes not reached after a failed node without leaving an active state", () => {
    const failed = run("failed", [
      nodeExecution("source", "completed"),
      nodeExecution("task", "failed"),
      nodeExecution("output", "pending"),
    ]);
    const projection = projectMediaRunOverlay({ flow, plan, run: failed });

    expect(projection?.activeNodeIds).toEqual([]);
    expect(projection?.observations.get("task")?.state).toBe("failed");
    expect(projection?.observations.get("output")?.state).toBe("not-reached");
  });

  it("does not project a stale run's active node onto an edited flow", () => {
    const running = run("running", [
      nodeExecution("source", "completed"),
      nodeExecution("task", "running"),
      nodeExecution("output", "pending"),
    ]);
    const stalePlan = { ...plan, flowFingerprint: "new-fingerprint" };
    const projection = projectMediaRunOverlay({
      flow,
      plan: stalePlan,
      run: running,
    });

    expect(projection?.activeNodeIds).toEqual(["task"]);
    expect(selectMediaRunOverlayForCurrentFlow(projection)).toBeNull();
  });
});

describe("selectMediaRunOutputAssetForNode", () => {
  it("shows each completed output by node, clears it while rerunning, and replaces it on the next run", () => {
    const firstResult = asset("result-one", 1, "png-output");
    const webpResult = asset("result-webp", 0, "webp-output");
    const completed = run(
      "completed",
      [
        nodeExecution("source", "completed"),
        nodeExecution("task", "completed"),
        nodeExecution("output", "completed"),
      ],
      [asset("later", 2, "other-output"), firstResult, webpResult],
    );
    const completedProjection = projectMediaRunOverlay({
      flow,
      plan,
      run: completed,
    });
    const rerunning = run(
      "running",
      [
        nodeExecution("source", "completed"),
        nodeExecution("task", "running"),
        nodeExecution("output", "pending"),
      ],
      [firstResult],
    );
    const secondResult = asset("result-two", 0, "png-output");
    const nextCompleted = { ...completed, id: "run-2", assets: [secondResult] };
    const nextProjection = projectMediaRunOverlay({
      flow,
      plan,
      run: nextCompleted,
    });

    expect(
      selectMediaRunOutputAssetForNode(
        completed,
        completedProjection,
        "png-output",
      )?.id,
    ).toBe(
      "result-one",
    );
    expect(
      selectMediaRunOutputAssetForNode(
        completed,
        completedProjection,
        "webp-output",
      )?.id,
    ).toBe("result-webp");
    expect(
      selectMediaRunOutputAssetForNode(
        rerunning,
        projectMediaRunOverlay({ flow, plan, run: rerunning }),
        "png-output",
      ),
    ).toBeNull();
    expect(
      selectMediaRunOutputAssetForNode(
        nextCompleted,
        nextProjection,
        "png-output",
      )?.id,
    ).toBe(
      "result-two",
    );
  });
});
