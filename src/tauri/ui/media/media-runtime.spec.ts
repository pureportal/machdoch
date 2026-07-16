import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileMediaFlow,
  createAlphaMatteFlow,
  createSubjectCutoutFlow,
  createImageCompositeFlow,
  createImageContactSheetFlow,
  createImageRecipeFlow,
  createImageTransformFlow,
  createMediaFlowLayout,
} from "../../../core/media/compiler.js";
import {
  BUILTIN_MEDIA_CATALOG_REVISION,
  createMediaModelCatalog,
} from "../../../core/media/catalog.js";
import {
  analyzeMediaImageQuality,
  autoTagMediaAsset,
  cancelMediaRun,
  deleteMediaAsset,
  executeMediaLocalImageFlow,
  enqueueMediaFixtureRun,
  enqueueMediaMockRemoteRun,
  exportMediaAsset,
  getMediaModelCatalog,
  getMediaModelInstallJob,
  getMediaRunDetail,
  getMediaFlow,
  initializeMediaRuntime,
  listMediaAssets,
  listMediaFlows,
  MediaRuntimeError,
  normalizeMediaError,
  planMediaAssetDeletion,
  planMediaModelInstall,
  planMediaModelRemoval,
  readMediaAssetPreview,
  readMediaQualityReport,
  retryMediaFixtureRun,
  resolveMediaHumanReview,
  resolveMediaProviderReview,
  removeMediaModel,
  saveMediaFlowRevision,
  setMediaAssetTags,
  startMediaModelInstall,
  transformMediaImage,
} from "./media-runtime";

const createRequest = (runId: string, outputCount = 2) => ({
  runId,
  flowId: "fixture-flow",
  flowRevisionId: null,
  flowName: "Fixture image",
  planId: "fixture-plan",
  prompt: "A deterministic studio fixture",
  modelLabel: "Fixture model",
  target: "local" as const,
  outputCount,
  diagnosticCount: 0,
  aspectRatio: "16:9" as const,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Media runtime browser adapter", () => {
  it("appends immutable flow revisions with idempotency and optimistic concurrency", async () => {
    const flow = createImageRecipeFlow({
      id: "flow:browser-revisions",
      createdAt: "2026-07-14T12:00:00.000Z",
      settings: {
        prompt: "A revisioned studio image",
        providerPolicy: "auto",
        modelPolicy: "balanced",
        modelId: null,
        aspectRatio: "1:1",
        outputCount: 1,
        outputFormat: "png",
        transparentBackground: false,
      qualityGateEnabled: false,
      referenceImages: [],
      modelAddons: [],
      },
    });
    const layout = createMediaFlowLayout(flow);
    const firstRequest = {
      schemaVersion: 1 as const,
      idempotencyKey: "browser-save-1",
      expectedHeadRevisionId: null,
      changeSummary: "Initial browser revision",
      flow,
      layout,
    };

    const first = await saveMediaFlowRevision(firstRequest);
    expect(first).toMatchObject({
      created: true,
      head: { headRevisionNumber: 1 },
      revision: { parentRevisionId: null, isHead: true },
    });
    await expect(saveMediaFlowRevision(firstRequest)).resolves.toMatchObject({
      created: false,
      revision: { revisionId: first.revision.revisionId },
    });

    const changed = structuredClone(flow);
    const prompt = changed.nodes.find((node) => node.id === "prompt");
    if (!prompt) throw new Error("Fixture prompt node is missing.");
    prompt.config.prompt = "A second immutable revision";
    await expect(
      saveMediaFlowRevision({
        ...firstRequest,
        idempotencyKey: "browser-save-stale",
        flow: changed,
      }),
    ).rejects.toMatchObject({
      detail: { code: "FLOW_REVISION_CONFLICT" },
    });

    const second = await saveMediaFlowRevision({
      ...firstRequest,
      idempotencyKey: "browser-save-2",
      expectedHeadRevisionId: first.revision.revisionId,
      changeSummary: "Updated prompt",
      flow: changed,
    });
    expect(second).toMatchObject({
      created: true,
      head: { headRevisionNumber: 2 },
      revision: { parentRevisionId: first.revision.revisionId },
    });
    await expect(getMediaFlow(flow.id)).resolves.toMatchObject({
      head: { headRevisionId: second.revision.revisionId },
      revisions: [
        { revisionNumber: 2, isHead: true },
        { revisionNumber: 1, isHead: false },
      ],
    });
    expect((await listMediaFlows()).some((head) => head.flowId === flow.id)).toBe(
      true,
    );

    const planSnapshot = {
      schemaVersion: 1 as const,
      planId: "plan:revisioned-browser-run",
      flowId: flow.id,
      flowFingerprint: second.revision.executionDigest,
      compiledAt: "2026-07-14T12:01:00.000Z",
      nodes: changed.nodes.map(({ id, type, label, layer }) => ({
        id,
        type,
        label,
        layer,
      })),
      steps: [
        {
          id: "step:generate",
          sourceNodeId: "generate",
          kind: "generate-image" as const,
          label: "Generate image",
          target: "local" as const,
          cacheable: true,
        },
      ],
    };
    await expect(
      enqueueMediaFixtureRun({
        ...createRequest("run:revisioned-browser", 1),
        flowId: flow.id,
        flowRevisionId: second.revision.revisionId,
        planId: planSnapshot.planId,
        planSnapshot,
      }),
    ).resolves.toMatchObject({
      flowRevisionId: second.revision.revisionId,
      planSnapshot: { flowFingerprint: second.revision.executionDigest },
    });
    await expect(
      enqueueMediaFixtureRun({
        ...createRequest("run:mismatched-browser", 1),
        flowId: flow.id,
        flowRevisionId: second.revision.revisionId,
        planId: planSnapshot.planId,
        planSnapshot: {
          ...planSnapshot,
          flowFingerprint: "sha256:mismatch",
        },
      }),
    ).rejects.toThrow("does not match the compiled plan");
  });

  it("preserves structured native errors and normalizes legacy browser failures", () => {
    const nativeFailure = {
      schemaVersion: 1 as const,
      code: "REMOTE_RETRY_COST_RISK" as const,
      category: "provider" as const,
      message: "Retrying could create a duplicate remote charge.",
      technicalDiagnostic: "acceptance is unknown",
      context: {
        nodeId: "node:generate",
        providerId: "provider:test",
        modelId: null,
        runtimeId: null,
        runId: "run:test",
        assetId: null,
        operation: "media_retry_run",
      },
      retryability: "reconcile-first" as const,
      partialOutputsExist: true,
      suggestedActions: [
        {
          id: "review-run" as const,
          label: "Review provider job",
          description: "Reconcile before retrying.",
        },
      ],
    };

    expect(normalizeMediaError(nativeFailure, "fallback")).toEqual(nativeFailure);
    const legacy = normalizeMediaError(
      new Error("Media asset missing was not found at https://example.test/a?token=secret"),
      "read_asset",
    );
    expect(legacy).toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      retryability: "after-user-action",
      context: { operation: "read_asset" },
      suggestedActions: [{ id: "refresh" }],
    });
    expect(legacy.technicalDiagnostic).not.toContain("token=secret");
    expect(new MediaRuntimeError(legacy).message).toBe(legacy.message);
  });

  it("advertises non-durable browser preview mode", async () => {
    await expect(initializeMediaRuntime()).resolves.toMatchObject({
      schemaVersion: 21,
      storageReady: true,
      mode: "browser-preview",
      directGenerationModelIds: ["openai:gpt-image-2"],
      directReferenceImageModelIds: ["openai:gpt-image-2"],
    });
    await expect(
      exportMediaAsset({
        assetId: "asset-1",
        destinationPath: "C:\\tmp\\asset.png",
        mode: "verified-original",
      }),
    ).rejects.toThrow("native desktop app only");
  });

  it("returns a revisioned capability catalog without persisting provider secrets", async () => {
    const unavailable = await getMediaModelCatalog([]);
    const configured = await getMediaModelCatalog(["openai", "openai", " "]);

    expect(unavailable).toMatchObject({
      schemaVersion: 1,
      catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
    });
    expect(unavailable.providers).toHaveLength(4);
    expect(unavailable.models).toHaveLength(5);
    expect(
      unavailable.models.find((model) => model.id === "local:border-matte-v1"),
    ).toMatchObject({
      displayName: "Local Border Matte",
      installed: true,
      bundled: true,
      installationStatus: "bundled",
    });
    expect(
      unavailable.models.find((model) => model.id === "openai:gpt-image-2"),
    ).toMatchObject({
      configured: false,
      installationStatus: "remote",
      license: { commercialUse: "provider-terms" },
    });
    expect(
      configured.models.find((model) => model.id === "openai:gpt-image-2"),
    ).toMatchObject({ configured: true });
    expect(
      configured.models.find(
        (model) => model.id === "local:flux-2-klein-4b",
      ),
    ).toMatchObject({
      installed: false,
      installationStatus: "not-installed",
      license: { spdxId: "Apache-2.0", requiresAcceptance: true },
    });
  });

  it("requires reviewed license acceptance and advances the browser install state machine", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
    const plan = await planMediaModelInstall("local:flux-2-klein-4b");

    expect(plan).toMatchObject({
      schemaVersion: 1,
      revision: "e7b7dc27f91deacad38e78976d1f2b499d76a294",
      totalBytes: 15_980_141_329,
      requiredWorkingBytes: 17_897_758_289,
      hasSufficientSpace: null,
    });
    expect(plan.files).toHaveLength(19);
    await expect(
      startMediaModelInstall({
        modelId: plan.modelId,
        reviewToken: plan.reviewToken,
        manifestDigest: plan.manifestDigest,
        licenseDigest: plan.licenseDigest,
        acceptLicense: false,
      }),
    ).rejects.toThrow("license acceptance");

    const queued = await startMediaModelInstall({
      modelId: plan.modelId,
      reviewToken: plan.reviewToken,
      manifestDigest: plan.manifestDigest,
      licenseDigest: plan.licenseDigest,
      acceptLicense: true,
    });
    expect(queued.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(3_200);
    await expect(getMediaModelInstallJob(queued.id)).resolves.toMatchObject({
      status: "verifying",
      filesCompleted: 19,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(getMediaModelInstallJob(queued.id)).resolves.toMatchObject({
      status: "installed",
      progress: 1,
    });
    expect(
      (await getMediaModelCatalog([])).models.find(
        (model) => model.id === "local:flux-2-klein-4b",
      ),
    ).toMatchObject({ installed: true, installationStatus: "installed" });

    const removal = await planMediaModelRemoval(plan.modelId);
    expect(removal).toMatchObject({
      canRemove: true,
      installedBytes: 15_980_141_329,
    });
    await expect(
      removeMediaModel({
        modelId: removal.modelId,
        confirmationToken: removal.confirmationToken,
        confirmRemoval: true,
      }),
    ).resolves.toMatchObject({
      reclaimedBytes: 15_980_141_329,
      cleanupPending: false,
    });
    expect(
      (await getMediaModelCatalog([])).models.find(
        (model) => model.id === "local:flux-2-klein-4b",
      ),
    ).toMatchObject({ installed: false, installationStatus: "not-installed" });
  });

  it("publishes deterministic fixture records with ordered events", async () => {
    vi.useFakeTimers();
    const runId = "browser-runtime-complete";
    await enqueueMediaFixtureRun(createRequest(runId));

    await vi.advanceTimersByTimeAsync(1_000);
    const detail = await getMediaRunDetail(runId);

    expect(detail.status).toBe("completed");
    expect(detail.progress).toBe(1);
    expect(detail.assets).toHaveLength(2);
    expect(detail.assets[0]).toMatchObject({
      width: 512,
      height: 288,
      fixture: true,
    });
    expect(detail.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    await expect(
      enqueueMediaFixtureRun({
        ...createRequest(runId),
        planId: "fixture-plan-conflict",
      }),
    ).rejects.toThrow("Run idempotency conflict");
  });

  it("pauses for bounded human review and records an idempotent approval", async () => {
    vi.useFakeTimers();
    const runId = "browser-runtime-human-review";
    await enqueueMediaFixtureRun({
      ...createRequest(runId, 3),
      planSnapshot: {
        schemaVersion: 1,
        planId: "fixture-plan",
        flowId: "fixture-flow",
        flowFingerprint: "sha256:browser-human-review",
        compiledAt: "2026-07-14T00:00:00.000Z",
        nodes: [
          {
            id: "node:review",
            type: "control.human-review",
            label: "Human review",
            layer: "control",
          },
        ],
        steps: [
          {
            id: "step:review",
            sourceNodeId: "node:review",
            kind: "wait-for-review",
            label: "Pause for review",
            target: "orchestrator",
            cacheable: false,
            review: {
              instructions: "Select the strongest candidate.",
              maxSelections: 2,
              requireComment: true,
            },
          },
        ],
      },
    });

    await vi.advanceTimersByTimeAsync(1_500);
    const waiting = await getMediaRunDetail(runId);
    expect(waiting.status).toBe("waiting-for-review");
    expect(waiting.humanReviews).toHaveLength(1);
    expect(waiting.humanReviews[0]).toMatchObject({
      status: "pending",
      maxSelections: 2,
      requireComment: true,
    });
    expect(waiting.humanReviews[0]?.candidateAssetIds).toHaveLength(3);
    expect(
      (await listMediaAssets()).filter((asset) => asset.runId === runId),
    ).toHaveLength(0);
    const review = waiting.humanReviews[0];
    if (!review) throw new Error("Expected a pending human review.");
    const decision = {
      reviewId: review.id,
      decisionId: "browser-review-decision-1",
      action: "approve" as const,
      selectedAssetIds: review.candidateAssetIds.slice(0, 2),
      comment: "Strong composition and clean technical finish.",
    };
    await expect(
      resolveMediaHumanReview({ ...decision, comment: "" }),
    ).rejects.toThrow("requires a comment");
    const completed = await resolveMediaHumanReview(decision);
    expect(completed).toMatchObject({ status: "completed", progress: 1 });
    expect(completed.humanReviews[0]).toMatchObject({
      status: "approved",
      decisionId: decision.decisionId,
      selectedAssetIds: decision.selectedAssetIds,
    });
    expect(
      (await listMediaAssets()).filter((asset) => asset.runId === runId),
    ).toHaveLength(2);
    const eventCount = completed.events.length;
    await expect(resolveMediaHumanReview(decision)).resolves.toMatchObject({
      status: "completed",
      events: { length: eventCount },
    });
  });

  it("executes the compiled Generate & choose recipe without publishing rejected candidates", async () => {
    vi.useFakeTimers();
    const runId = "browser-runtime-generate-and-choose";
    const flow = createImageRecipeFlow({
      id: "flow:generate-and-choose",
      createdAt: "2026-07-14T00:00:00.000Z",
      settings: {
        prompt: "A cobalt paper sculpture under gallery lighting",
        providerPolicy: "remote",
        modelPolicy: "balanced",
        modelId: "openai:gpt-image-2",
        aspectRatio: "1:1",
        outputCount: 4,
        outputFormat: "png",
        transparentBackground: false,
      qualityGateEnabled: false,
      referenceImages: [],
      modelAddons: [],
      },
      review: {
        instructions: "Choose the strongest candidate for publication.",
        maxSelections: 1,
        requireComment: false,
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({ isOpenAiConfigured: true }),
      compiledAt: "2026-07-14T00:01:00.000Z",
    });

    await enqueueMediaFixtureRun({
      ...createRequest(runId, plan.preflight.generatedCandidates),
      flowId: flow.id,
      flowName: "Generate & choose",
      planId: plan.id,
      diagnosticCount: plan.diagnostics.length,
      planSnapshot: {
        schemaVersion: 1,
        planId: plan.id,
        flowId: flow.id,
        flowFingerprint: plan.flowFingerprint,
        compiledAt: plan.compiledAt,
        nodes: flow.nodes.map(({ id, type, label, layer }) => ({
          id,
          type,
          label,
          layer,
        })),
        steps: plan.steps,
      },
    });
    await vi.advanceTimersByTimeAsync(1_500);

    const waiting = await getMediaRunDetail(runId);
    const review = waiting.humanReviews[0];
    expect(waiting).toMatchObject({
      status: "waiting-for-review",
      outputCount: 4,
    });
    expect(review).toMatchObject({
      status: "pending",
      maxSelections: 1,
      candidateAssetIds: { length: 4 },
    });
    expect(
      (await listMediaAssets()).filter((asset) => asset.runId === runId),
    ).toHaveLength(0);
    if (!review) throw new Error("Expected a pending generated-image review.");

    await resolveMediaHumanReview({
      reviewId: review.id,
      decisionId: "decision:generate-and-choose",
      action: "approve",
      selectedAssetIds: [review.candidateAssetIds[2]!],
      comment: "",
    });
    expect(
      (await listMediaAssets()).filter((asset) => asset.runId === runId),
    ).toEqual([
      expect.objectContaining({ id: review.candidateAssetIds[2] }),
    ]);
  });

  it("reconciles a remote provider result and immediately publishes it", async () => {
    vi.useFakeTimers();
    const runId = "browser-provider-complete";
    await enqueueMediaMockRemoteRun({
      ...createRequest(runId, 1),
      modelLabel: "Mock Remote Image v1",
      target: "remote",
      scenario: "success",
      allowRemoteUpload: false,
      planSnapshot: {
        schemaVersion: 1,
        planId: "fixture-plan",
        flowId: "fixture-flow",
        flowFingerprint: "sha256:browser-plan",
        compiledAt: "2026-07-14T00:00:00.000Z",
        nodes: [
          {
            id: "node:generate",
            type: "task.generate-image",
            label: "Generate image",
            layer: "task",
          },
        ],
        steps: [
          {
            id: "step:generate",
            sourceNodeId: "node:generate",
            kind: "generate-image",
            label: "Generate with mock provider",
            target: "remote",
            cacheable: false,
            sideEffect: "paid-request",
          },
        ],
      },
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const detail = await getMediaRunDetail(runId);
    expect(detail).toMatchObject({
      status: "completed",
      executor: "mock-remote-provider",
    });
    expect(detail.assets).toHaveLength(1);
    expect(detail.providerJobs[0]).toMatchObject({
      status: "completed",
      pollAttempts: 2,
      policy: {
        idempotencyMode: "provider-key",
        outputVisibility: "private-signed-url",
        publicLinks: false,
      },
    });
    expect(detail.planSnapshot).toMatchObject({
      flowFingerprint: "sha256:browser-plan",
      nodes: [{ id: "node:generate" }],
      steps: [{ sourceNodeId: "node:generate", sideEffect: "paid-request" }],
    });
  });

  it("records a typed provider failure with retry and partial-output semantics", async () => {
    vi.useFakeTimers();
    const runId = "browser-provider-failure";
    await enqueueMediaMockRemoteRun({
      ...createRequest(runId, 1),
      modelLabel: "Mock Remote Image v1",
      target: "remote",
      scenario: "provider-failure",
      allowRemoteUpload: false,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const detail = await getMediaRunDetail(runId);
    expect(detail).toMatchObject({
      status: "failed",
      failure: {
        schemaVersion: 1,
        code: "PROVIDER_REQUEST_FAILED",
        category: "provider",
        retryability: "user-approval-required",
        partialOutputsExist: false,
        context: { providerId: "mock-remote", runId },
        suggestedActions: [{ id: "review-run" }],
      },
    });
    expect(detail.providerJobs[0]?.failure).toEqual(detail.failure);
  });

  it("blocks duplicate submission until unknown acceptance is reconciled", async () => {
    vi.useFakeTimers();
    const runId = "browser-provider-uncertain";
    await enqueueMediaMockRemoteRun({
      ...createRequest(runId, 1),
      modelLabel: "Mock Remote Image v1",
      target: "remote",
      scenario: "acceptance-unknown",
      allowRemoteUpload: false,
    });
    await vi.advanceTimersByTimeAsync(500);
    const uncertain = await getMediaRunDetail(runId);
    expect(uncertain.status).toBe("needs-review");
    expect(uncertain.providerJobs).toHaveLength(1);
    expect(uncertain.providerJobs[0]).toMatchObject({
      status: "acceptance-unknown",
      reviewRequired: true,
    });

    await resolveMediaProviderReview(
      uncertain.providerJobs[0].id,
      "reconcile-only",
    );
    await vi.advanceTimersByTimeAsync(2_000);
    const reconciled = await getMediaRunDetail(runId);
    expect(reconciled.status).toBe("completed");
    expect(reconciled.providerJobs).toHaveLength(1);
    expect(
      reconciled.events.some(
        (event) =>
          event.kind === "provider_reconciled" &&
          event.message.includes("No second submission"),
      ),
    ).toBe(true);
  });

  it("ingests and flags a paid result that wins a cancellation race", async () => {
    vi.useFakeTimers();
    const runId = "browser-provider-cancel-race";
    await enqueueMediaMockRemoteRun({
      ...createRequest(runId, 1),
      modelLabel: "Mock Remote Image v1",
      target: "remote",
      scenario: "cancel-race-success",
      allowRemoteUpload: false,
    });
    await cancelMediaRun(runId);
    await vi.advanceTimersByTimeAsync(2_000);

    const detail = await getMediaRunDetail(runId);
    expect(detail.status).toBe("completed");
    expect(detail.providerJobs[0]).toMatchObject({
      status: "completed",
      lateSuccess: true,
    });
    expect(
      detail.events.some((event) => event.kind === "provider_late_success"),
    ).toBe(true);
  });

  it("cancels before claim and retries without duplicating outputs", async () => {
    vi.useFakeTimers();
    const runId = "browser-runtime-cancel";
    await enqueueMediaFixtureRun(createRequest(runId, 4));

    const canceling = await cancelMediaRun(runId);
    expect(canceling.status).toBe("canceling");
    await vi.advanceTimersByTimeAsync(150);

    const canceled = await getMediaRunDetail(runId);
    expect(canceled.status).toBe("canceled");
    expect(canceled.events.at(-1)?.kind).toBe("run_canceled");

    const retrying = await retryMediaFixtureRun(runId);
    expect(retrying.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(2_000);

    const completed = await getMediaRunDetail(runId);
    expect(completed.status).toBe("completed");
    expect(completed.assets).toHaveLength(4);
    expect(completed.events.some((event) => event.kind === "retry_queued")).toBe(
      true,
    );
  });

  it("creates previewable derived image metadata with explicit lineage", async () => {
    vi.useFakeTimers();
    const runId = "browser-runtime-transform";
    await enqueueMediaFixtureRun(createRequest(runId, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const source = (await getMediaRunDetail(runId)).assets[0];

    const transformed = await transformMediaImage({
      sourceAssetId: source.id,
      operation: {
        kind: "resize",
        width: 300,
        height: 300,
        fit: "contain",
      },
      outputFormat: "webp",
    });

    expect(transformed).toMatchObject({
      executor: "local-transform",
      status: "completed",
    });
    expect(transformed.assets[0]).toMatchObject({
      width: 300,
      height: 169,
      mimeType: "image/webp",
      operation: { kind: "resize", fit: "contain" },
      sourceAssetIds: [source.id],
    });
    expect(await readMediaAssetPreview(transformed.assets[0])).toMatchObject({
      type: "image/svg+xml",
    });
    expect((await listMediaAssets())[0].id).toBe(transformed.assets[0].id);
  });

  it("executes a pinned model-free image flow with exact lineage", async () => {
    vi.useFakeTimers();
    const sourceRunId = "browser-local-flow-source";
    await enqueueMediaFixtureRun(createRequest(sourceRunId, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const source = (await getMediaRunDetail(sourceRunId)).assets[0];
    const flow = createImageTransformFlow({
      id: "flow:browser-local-transform",
      createdAt: "2026-07-14T12:00:00.000Z",
      request: {
        sourceAssetId: source.id,
        operation: {
          kind: "resize",
          width: 640,
          height: 360,
          fit: "cover",
        },
        outputFormat: "jpeg",
        quality: 86,
        jpegBackground: "#111827",
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({ isOpenAiConfigured: false }),
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    const saved = await saveMediaFlowRevision({
      schemaVersion: 1,
      idempotencyKey: "save-browser-local-transform",
      expectedHeadRevisionId: null,
      changeSummary: "Pinned local flow",
      flow,
      layout: createMediaFlowLayout(flow),
    });
    const detail = await executeMediaLocalImageFlow(
      {
        schemaVersion: 1,
        runId: "browser-local-flow-run",
        flowId: flow.id,
        flowRevisionId: saved.revision.revisionId,
        planId: plan.id,
        planSnapshot: {
          schemaVersion: 1,
          planId: plan.id,
          flowId: flow.id,
          flowFingerprint: plan.flowFingerprint,
          compiledAt: plan.compiledAt,
          nodes: flow.nodes.map(({ id, type, label, layer }) => ({
            id,
            type,
            label,
            layer,
          })),
          steps: plan.steps,
        },
      },
      flow,
    );

    expect(detail).toMatchObject({
      flowId: flow.id,
      flowRevisionId: saved.revision.revisionId,
      executor: "local-image-flow",
      status: "completed",
      planSnapshot: { flowFingerprint: plan.flowFingerprint },
    });
    expect(detail.assets[0]).toMatchObject({
      width: 640,
      height: 360,
      mimeType: "image/jpeg",
      sourceAssetIds: [source.id],
      operation: {
        kind: "local-image-flow",
        flowRevisionId: saved.revision.revisionId,
      },
    });
    expect(detail.events.slice(-3).map((event) => event.kind)).toEqual([
      "local_flow_executed",
      "asset_published",
      "run_completed",
    ]);
    expect(
      detail.events.filter((event) => event.kind === "node_state_changed"),
    ).toHaveLength(flow.nodes.length * 2);
  });

  it("refuses to fake the subject-cutout model fallback policy in browser preview", async () => {
    vi.useFakeTimers();
    const sourceRunId = "browser-background-source";
    await enqueueMediaFixtureRun(createRequest(sourceRunId, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const source = (await getMediaRunDetail(sourceRunId)).assets[0];
    const flow = createSubjectCutoutFlow({
      id: "flow:browser-background-matte",
      createdAt: "2026-07-14T12:00:00.000Z",
      sourceAssetId: source.id,
    });
    const plan = compileMediaFlow({
      flow,
      models: createMediaModelCatalog({
        isOpenAiConfigured: false,
        isLocalBiRefNetInstalled: true,
      }),
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    const saved = await saveMediaFlowRevision({
      schemaVersion: 1,
      idempotencyKey: "save-browser-background-matte",
      expectedHeadRevisionId: null,
      changeSummary: "Pinned background matte flow",
      flow,
      layout: createMediaFlowLayout(flow),
    });
    await expect(executeMediaLocalImageFlow(
      {
        schemaVersion: 1,
        runId: "browser-background-matte-run",
        flowId: flow.id,
        flowRevisionId: saved.revision.revisionId,
        planId: plan.id,
        planSnapshot: {
          schemaVersion: 1,
          planId: plan.id,
          flowId: flow.id,
          flowFingerprint: plan.flowFingerprint,
          compiledAt: plan.compiledAt,
          nodes: flow.nodes.map(({ id, type, label, layer }) => ({
            id,
            type,
            label,
            layer,
          })),
          steps: plan.steps,
        },
      },
      flow,
    )).rejects.toThrow(/native local model runtime/u);
  });

  it("publishes a tagged exact-alpha fixture for a pinned extraction flow", async () => {
    vi.useFakeTimers();
    const sourceRunId = "browser-alpha-source";
    await enqueueMediaFixtureRun(createRequest(sourceRunId, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const source = (await getMediaRunDetail(sourceRunId)).assets[0];
    const flow = createAlphaMatteFlow({
      id: "flow:browser-alpha-extraction",
      createdAt: "2026-07-14T12:00:00.000Z",
      sourceAssetId: source.id,
    });
    const plan = compileMediaFlow({
      flow,
      models: [],
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    const saved = await saveMediaFlowRevision({
      schemaVersion: 1,
      idempotencyKey: "save-browser-alpha-extraction",
      expectedHeadRevisionId: null,
      changeSummary: "Pinned alpha extraction flow",
      flow,
      layout: createMediaFlowLayout(flow),
    });
    const detail = await executeMediaLocalImageFlow(
      {
        schemaVersion: 1,
        runId: "browser-alpha-extraction-run",
        flowId: flow.id,
        flowRevisionId: saved.revision.revisionId,
        planId: plan.id,
        planSnapshot: {
          schemaVersion: 1,
          planId: plan.id,
          flowId: flow.id,
          flowFingerprint: plan.flowFingerprint,
          compiledAt: plan.compiledAt,
          nodes: flow.nodes.map(({ id, type, label, layer }) => ({
            id,
            type,
            label,
            layer,
          })),
          steps: plan.steps,
        },
      },
      flow,
    );

    expect(detail).toMatchObject({
      outputCount: 1,
      diagnosticCount: 0,
      assets: [
        {
          mimeType: "image/png",
          fixture: false,
          operation: {
            kind: "local-image-flow",
            assetRole: "alpha-matte",
            alphaExtraction: null,
          },
          sourceAssetIds: [source.id],
        },
      ],
    });
    expect(detail.assets[0]?.tags.map((tag) => tag.value)).toEqual(
      expect.arrayContaining([
        "alpha-matte",
        "image",
        "png",
        "landscape",
        "low-resolution",
      ]),
    );
    expect(
      detail.events.find((event) => event.kind === "local_flow_executed")?.message,
    ).toContain("no source pixels");
  });

  it("publishes a typed two-source composite fixture with ordered provenance", async () => {
    vi.useFakeTimers();
    const sourceRunId = "browser-composite-sources";
    await enqueueMediaFixtureRun(createRequest(sourceRunId, 2));
    await vi.advanceTimersByTimeAsync(1_000);
    const [foreground, background] = (await getMediaRunDetail(sourceRunId)).assets;
    const flow = createImageCompositeFlow({
      id: "flow:browser-composite",
      createdAt: "2026-07-14T12:00:00.000Z",
      foregroundAssetId: foreground.id,
      backgroundAssetId: background.id,
      fit: "contain",
      opacityPercent: 75,
    });
    const plan = compileMediaFlow({
      flow,
      models: [],
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    const saved = await saveMediaFlowRevision({
      schemaVersion: 1,
      idempotencyKey: "save-browser-composite",
      expectedHeadRevisionId: null,
      changeSummary: "Pinned composite flow",
      flow,
      layout: createMediaFlowLayout(flow),
    });
    const detail = await executeMediaLocalImageFlow(
      {
        schemaVersion: 1,
        runId: "browser-composite-run",
        flowId: flow.id,
        flowRevisionId: saved.revision.revisionId,
        planId: plan.id,
        planSnapshot: {
          schemaVersion: 1,
          planId: plan.id,
          flowId: flow.id,
          flowFingerprint: plan.flowFingerprint,
          compiledAt: plan.compiledAt,
          nodes: flow.nodes.map(({ id, type, label, layer }) => ({
            id,
            type,
            label,
            layer,
          })),
          steps: plan.steps,
        },
      },
      flow,
    );

    expect(detail.assets[0]).toMatchObject({
      width: background.width,
      height: background.height,
      sourceAssetIds: [foreground.id, background.id],
      operation: {
        kind: "local-image-flow",
        assetRole: "primary",
        autoTagProfile: "technical-metadata-v1",
        composite: {
          engine: "center-alpha-over-v1",
          fit: "contain",
          opacityPercent: 75,
          foregroundSourceAssetIds: [foreground.id],
          backgroundSourceAssetIds: [background.id],
        },
      },
    });
    expect(detail.assets[0]?.tags.map((tag) => tag.value)).toEqual(
      expect.arrayContaining(["image", "png", "landscape", "low-resolution"]),
    );
  });

  it("publishes an ordered guided contact sheet with explicit render provenance", async () => {
    vi.useFakeTimers();
    const sourceRunId = "browser-contact-sheet-sources";
    await enqueueMediaFixtureRun(createRequest(sourceRunId, 3));
    await vi.advanceTimersByTimeAsync(1_000);
    const sources = (await getMediaRunDetail(sourceRunId)).assets;
    const flow = createImageContactSheetFlow({
      id: "flow:browser-contact-sheet",
      createdAt: "2026-07-14T12:00:00.000Z",
      sourceAssetIds: [sources[1].id, sources[0].id, sources[2].id],
      cellWidth: 256,
      cellHeight: 192,
      gap: 8,
    });
    const plan = compileMediaFlow({
      flow,
      models: [],
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    const saved = await saveMediaFlowRevision({
      schemaVersion: 1,
      idempotencyKey: "save-browser-contact-sheet",
      expectedHeadRevisionId: null,
      changeSummary: "Pinned contact sheet flow",
      flow,
      layout: createMediaFlowLayout(flow),
    });
    const detail = await executeMediaLocalImageFlow(
      {
        schemaVersion: 1,
        runId: "browser-contact-sheet-run",
        flowId: flow.id,
        flowRevisionId: saved.revision.revisionId,
        planId: plan.id,
        planSnapshot: {
          schemaVersion: 1,
          planId: plan.id,
          flowId: flow.id,
          flowFingerprint: plan.flowFingerprint,
          compiledAt: plan.compiledAt,
          nodes: flow.nodes.map(({ id, type, label, layer }) => ({
            id,
            type,
            label,
            layer,
          })),
          steps: plan.steps,
        },
      },
      flow,
    );

    expect(detail.assets[0]).toMatchObject({
      width: 520,
      height: 392,
      sourceAssetIds: [sources[1].id, sources[0].id, sources[2].id],
      operation: {
        kind: "local-image-flow",
        autoTagProfile: "technical-metadata-v1",
        contactSheet: {
          engine: "grid-contact-sheet-v1",
          columns: 2,
          cellWidth: 256,
          cellHeight: 192,
          gap: 8,
          background: "#0f172a",
          labelMode: "index",
          sourceAssetIds: [sources[1].id, sources[0].id, sources[2].id],
        },
      },
    });
  });

  it("publishes an explicit tri-state quality report without inventing pixel metrics", async () => {
    vi.useFakeTimers();
    const runId = "browser-runtime-analysis";
    await enqueueMediaFixtureRun(createRequest(runId, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const source = (await getMediaRunDetail(runId)).assets[0];

    const analyzed = await analyzeMediaImageQuality(source.id);

    expect(analyzed.report).toMatchObject({
      schemaVersion: 1,
      sourceAssetId: source.id,
      verdict: "warn",
      profile: { id: "technical-image-baseline", version: "1.0.0" },
    });
    expect(
      analyzed.report.observations.find(
        (observation) => observation.metricId === "decode.valid",
      ),
    ).toMatchObject({ status: "unknown" });
    expect(analyzed.detail.assets[0]).toMatchObject({
      kind: "report",
      mimeType: "application/json",
      operation: { kind: "analyze-quality", verdict: "warn" },
      sourceAssetIds: [source.id],
    });
    await expect(
      readMediaQualityReport(analyzed.detail.assets[0].id),
    ).resolves.toEqual(analyzed.report);
  });

  it("revisions user and technical tags without changing immutable bytes", async () => {
    vi.useFakeTimers();
    const runId = "browser-runtime-tags";
    await enqueueMediaFixtureRun(createRequest(runId, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const source = (await getMediaRunDetail(runId)).assets[0];

    const userTagged = await setMediaAssetTags({
      assetId: source.id,
      tags: ["Hero Image", "campaign_2026", "Hero Image"],
    });
    const autoTagged = await autoTagMediaAsset(source.id);

    expect(userTagged.digest).toBe(source.digest);
    expect(autoTagged.tags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "hero-image", source: "user" }),
        expect.objectContaining({ value: "landscape", source: "technical" }),
        expect.objectContaining({ value: "low-resolution", source: "technical" }),
      ]),
    );
    expect((await getMediaRunDetail(runId)).events.at(-1)?.kind).toBe(
      "asset_tagged",
    );
  });

  it("requires dependency review before replacing source metadata with a tombstone", async () => {
    vi.useFakeTimers();
    const runId = "browser-runtime-delete";
    await enqueueMediaFixtureRun(createRequest(runId, 1));
    await vi.advanceTimersByTimeAsync(1_000);
    const source = (await getMediaRunDetail(runId)).assets[0];
    const derived = await transformMediaImage({
      sourceAssetId: source.id,
      operation: { kind: "convert" },
      outputFormat: "webp",
    });
    const impact = await planMediaAssetDeletion(source.id);

    expect(impact.dependentAssetIds).toEqual([derived.assets[0].id]);
    await expect(
      deleteMediaAsset({
        assetId: source.id,
        mode: "metadata-only",
        confirmationToken: impact.confirmationToken,
        confirmDependencies: false,
      }),
    ).rejects.toThrow("explicit deletion acknowledgement");

    const deleted = await deleteMediaAsset({
      assetId: source.id,
      mode: "metadata-only",
      confirmationToken: impact.confirmationToken,
      confirmDependencies: true,
    });

    expect(deleted).toMatchObject({
      reclaimedBytes: 0,
      tombstone: {
        assetId: source.id,
        bytesStatus: "retained",
      },
    });
    expect((await listMediaAssets()).some((asset) => asset.id === source.id)).toBe(
      false,
    );
    expect((await getMediaRunDetail(runId)).events.at(-1)?.kind).toBe(
      "asset_deleted",
    );
  });
});
