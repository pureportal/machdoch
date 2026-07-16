import { describe, expect, it } from "vitest";
import { createMediaModelCatalog } from "../../../core/media/catalog.js";
import { compileMediaFlow } from "../../../core/media/compiler.js";
import type {
  MediaHumanReviewRecord,
  MediaRunDetail,
  MediaRunPlanSnapshot,
} from "../../../core/media/contracts.js";
import { instantiateMediaFlowTemplate } from "../../../core/media/templates.js";
import { projectMediaRunOverlay } from "./media-run-overlay";

const createdAt = "2026-07-14T12:00:00.000Z";
const template = instantiateMediaFlowTemplate({
  templateId: "product-cutout-quality",
  flowId: "flow:overlay-test",
  createdAt,
});
const models = createMediaModelCatalog({ isOpenAiConfigured: true });
const plan = compileMediaFlow({
  flow: template.flow,
  models,
  compiledAt: createdAt,
});
const planSnapshot: MediaRunPlanSnapshot = {
  schemaVersion: 1,
  planId: plan.id,
  flowId: plan.flowId,
  flowFingerprint: plan.flowFingerprint,
  compiledAt: plan.compiledAt,
  nodes: template.flow.nodes.map(({ id, type, label, layer }) => ({
    id,
    type,
    label,
    layer,
  })),
  steps: plan.steps.map((step) => ({ ...step })),
};
const reviewStep = plan.steps.find((step) => step.kind === "wait-for-review");
if (!reviewStep?.review) throw new Error("Expected template human-review step.");

const review: MediaHumanReviewRecord = {
  id: "review:overlay-test",
  runId: "run:overlay-test",
  nodeId: reviewStep.sourceNodeId,
  sequence: 1,
  status: "pending",
  candidateAssetIds: ["asset:a", "asset:b"],
  selectedAssetIds: [],
  decisionId: null,
  decisionAction: null,
  comment: null,
  actor: null,
  createdAt,
  updatedAt: createdAt,
  decidedAt: null,
  ...reviewStep.review,
};

const createRun = (
  overrides: Partial<MediaRunDetail> = {},
): MediaRunDetail => ({
  id: "run:overlay-test",
  flowId: template.flow.id,
  flowRevisionId: "revision:overlay-test",
  flowName: template.flow.name,
  planId: plan.id,
  status: "waiting-for-review",
  createdAt,
  prompt: "A product cutout",
  modelLabel: plan.preflight.modelLabel,
  target: plan.preflight.target,
  outputCount: 2,
  diagnosticCount: plan.diagnostics.length,
  updatedAt: createdAt,
  progress: 0.96,
  currentStep: "Waiting for human review",
  executor: "deterministic-fixture",
  error: null,
  failure: null,
  events: [
    {
      id: 1,
      runId: "run:overlay-test",
      sequence: 1,
      kind: "human_review_requested",
      createdAt,
      message: "Candidates are ready for review.",
      progress: 0.96,
      stepId: review.nodeId,
      nodeId: review.nodeId,
    },
  ],
  assets: [],
  providerJobs: [],
  humanReviews: [review],
  nodeExecutions: [],
  planSnapshot,
  ...overrides,
});

describe("media run overlay projection", () => {
  it("projects an exact review boundary without inventing later node progress", () => {
    const projection = projectMediaRunOverlay({
      flow: template.flow,
      plan,
      run: createRun(),
    });

    expect(projection).not.toBeNull();
    expect(projection?.exactFlowMatch).toBe(true);
    expect(projection?.observations.get(review.nodeId)).toMatchObject({
      state: "waiting",
      observedEventCount: 1,
    });
    expect(
      projection?.observations.get("asset-output"),
    ).toMatchObject({ state: "not-reached" });
    expect(
      [...(projection?.observations.values() ?? [])].some(
        (observation) => observation.state === "completed",
      ),
    ).toBe(true);
  });

  it("marks terminal success and reports execution-fingerprint drift", () => {
    const changedFlow = structuredClone(template.flow);
    const promptNode = changedFlow.nodes.find((node) => node.id === "prompt");
    if (!promptNode) throw new Error("Expected prompt node.");
    promptNode.config.prompt = "A materially changed prompt";
    const changedPlan = compileMediaFlow({
      flow: changedFlow,
      models,
      compiledAt: "2026-07-14T12:05:00.000Z",
    });
    const projection = projectMediaRunOverlay({
      flow: changedFlow,
      plan: changedPlan,
      run: createRun({
        status: "completed",
        progress: 1,
        currentStep: "Completed",
        humanReviews: [{ ...review, status: "approved" }],
      }),
    });

    expect(projection).toMatchObject({
      exactFlowMatch: false,
      flowIdentityMatches: true,
      fingerprintMatches: false,
      missingSnapshotNodeCount: 0,
      currentOnlyNodeCount: 0,
    });
    expect(
      [...(projection?.observations.values() ?? [])]
        .filter((observation) => observation.stepCount > 0)
        .every((observation) => observation.state === "completed"),
    ).toBe(true);
  });

  it("prefers durable node executions and exposes every active DAG branch", () => {
    const activeIds = planSnapshot.nodes.slice(1, 3).map((node) => node.id);
    const nodeExecutions = planSnapshot.nodes.map((node, ordinal) => ({
      runId: "run:overlay-test",
      nodeId: node.id,
      nodeType: node.type,
      nodeLabel: node.label,
      ordinal,
      status: activeIds.includes(node.id)
        ? (ordinal === 1 ? "running" as const : "retrying" as const)
        : "pending" as const,
      activeStepId:
        planSnapshot.steps.find((step) => step.sourceNodeId === node.id)?.id ?? null,
      runtimePhase: activeIds.includes(node.id) ? "fixture.parallel" : null,
      attempt: activeIds.includes(node.id) ? 1 : 0,
      progress: activeIds.includes(node.id) ? 0.4 : null,
      message: activeIds.includes(node.id) ? `Working on ${node.label}` : null,
      startedAt: activeIds.includes(node.id) ? createdAt : null,
      updatedAt: createdAt,
      finishedAt: null,
      stateSequence: activeIds.includes(node.id) ? 1 : 0,
    }));
    const projection = projectMediaRunOverlay({
      flow: template.flow,
      plan,
      run: createRun({
        status: "running",
        progress: 0.4,
        currentStep: "Parallel work",
        events: [],
        humanReviews: [],
        nodeExecutions,
      }),
    });

    expect(projection?.activeNodeIds).toEqual(activeIds);
    expect(projection?.observations.get(activeIds[0] ?? "")?.state).toBe("running");
    expect(projection?.observations.get(activeIds[1] ?? "")?.state).toBe("retrying");
    expect(projection?.observations.get(activeIds[0] ?? "")?.detail).toContain("Working on");
  });
});
