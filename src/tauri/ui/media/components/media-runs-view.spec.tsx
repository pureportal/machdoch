import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MediaAssetRecord, MediaRunDetail } from "../../../../core/media/contracts.js";
import { readMediaAssetReferencePreview } from "../media-runtime";
import { MediaRunsView } from "./media-runs-view";

vi.mock("../media-runtime", () => ({
  readMediaAssetReferencePreview: vi.fn(() => Promise.resolve(new Blob(["preview"]))),
}));

const unresolvedOpenAiRun: MediaRunDetail = {
  id: "run:openai:unknown",
  flowId: "flow:openai",
  flowRevisionId: "revision:openai",
  flowName: "Create image",
  planId: "plan:openai",
  status: "needs-review",
  createdAt: "2026-07-14T12:00:00.000Z",
  updatedAt: "2026-07-14T12:01:00.000Z",
  prompt: "A durable provider request",
  modelLabel: "GPT Image 2",
  target: "remote",
  outputCount: 1,
  diagnosticCount: 0,
  progress: 0.1,
  currentStep: "Provider acceptance requires review",
  executor: "openai-image-api",
  error: "OpenAI request acceptance is unknown.",
  failure: null,
  events: [],
  assets: [],
  providerJobs: [
    {
      id: "provider:run:openai:unknown:1",
      runId: "run:openai:unknown",
      attempt: 1,
      status: "acceptance-unknown",
      rawState: "outcome-unknown",
      scenario: "openai:gpt-image-2",
      requestDigest: "a".repeat(64),
      idempotencyKey: null,
      providerJobId: null,
      providerRequestId: "req_openai_1",
      estimatedCostMin: 0,
      estimatedCostMax: 0,
      currency: "USD",
      pollAttempts: 0,
      nextPollAt: null,
      reconciliationDeadline: "2026-07-21T12:00:00.000Z",
      acceptedAt: null,
      retentionExpiresAt: null,
      lateSuccess: false,
      reviewRequired: true,
      reviewReason: "The paid request may have been accepted.",
      error: "Transport ended after submission.",
      failure: null,
      policy: {
        adapterId: "openai.images",
        adapterVersion: "1.0.0",
        endpointVersion: "gpt-image-2-2026-04-21",
        region: "OpenAI-managed",
        idempotencyMode: "none",
        retryPolicy: "Possible acceptance is never resubmitted automatically.",
        cancellationSemantics: "Synchronous provider request.",
        inputRetentionSeconds: null,
        outputRetentionSeconds: null,
        outputVisibility: "inline-base64-response",
        publicLinks: false,
        noStoreRequested: false,
        uploadAssetCount: 0,
        uploadBytes: 0,
        containsPersonalData: false,
        remoteUploadAllowed: true,
      },
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:01:00.000Z",
      completedAt: null,
    },
  ],
  humanReviews: [],
  nodeExecutions: [],
  planSnapshot: null,
};

const reviewAsset: MediaAssetRecord = {
  id: "asset:review-candidate",
  runId: "run:human-review",
  digest: "b".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 1_024,
  width: 512,
  height: 512,
  createdAt: "2026-07-14T12:00:00.000Z",
  outputIndex: 0,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [],
};
const alternateReviewAsset: MediaAssetRecord = {
  ...reviewAsset,
  id: "asset:review-candidate-alternate",
  outputIndex: 1,
};

const pendingHumanReviewRun: MediaRunDetail = {
  ...unresolvedOpenAiRun,
  id: "run:human-review",
  status: "waiting-for-review",
  currentStep: "Waiting for human review",
  error: null,
  assets: [reviewAsset],
  providerJobs: [],
  humanReviews: [
    {
      id: "review:human-review",
      runId: "run:human-review",
      nodeId: "review",
      sequence: 1,
      status: "pending",
      candidateAssetIds: [reviewAsset.id],
      selectedAssetIds: [],
      decisionId: null,
      decisionAction: null,
      comment: null,
      actor: null,
      createdAt: "2026-07-14T12:00:00.000Z",
      updatedAt: "2026-07-14T12:01:00.000Z",
      decidedAt: null,
      instructions: "Choose the strongest candidate.",
      maxSelections: 1,
      requireComment: false,
    },
  ],
};

describe("MediaRunsView", () => {
  it("does not offer an unsupported lookup for an uncertain OpenAI Images charge", () => {
    const onResolveProviderReview = vi.fn();
    render(
      <MediaRunsView
        runs={[unresolvedOpenAiRun]}
        selectedRun={unresolvedOpenAiRun}
        runtimeStatus={{
          schemaVersion: 17,
          recoveredRuns: 0,
          queuedRuns: 0,
          activeRuns: 0,
          storageReady: true,
          mode: "native",
          directGenerationModelIds: ["openai:gpt-image-2"],
          directReferenceImageModelIds: ["openai:gpt-image-2"],
          localDiffusers: {
            status: "unavailable",
            ready: false,
            workerVersion: null,
            pythonVersion: null,
            packages: {},
            device: null,
            deviceLabel: null,
            deviceMemoryBytes: null,
            architectures: [],
            capabilities: [],
            diagnostic: "Not installed",
          },
        }}
        runtimeError={null}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onResolveProviderReview={onResolveProviderReview}
        providerReviewPending={false}
        onResolveHumanReview={vi.fn()}
        humanReviewPending={false}
        onInspectInFlow={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Lookup original request" })).toBeNull();
    expect(screen.getByText(/no documented request lookup/u)).toBeTruthy();
    expect(screen.getByText("Provider calculator")).toBeTruthy();
    expect(screen.getByText("inline base64 response")).toBeTruthy();
    expect(screen.getByText("Not asserted by provider")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: "I confirmed no charge — allow a new Generate",
      }),
    );
    expect(onResolveProviderReview).toHaveBeenCalledWith(
      "provider:run:openai:unknown:1",
      "confirm-not-accepted-and-retry",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Accept possible duplicate charge — allow a new Generate",
      }),
    );
    expect(onResolveProviderReview).toHaveBeenCalledWith(
      "provider:run:openai:unknown:1",
      "accept-duplicate-charge-risk-and-retry",
    );
  });

  it("keeps human-review candidate thumbnails stable across metadata refreshes", async () => {
    const previewReadMock = vi.mocked(readMediaAssetReferencePreview);
    previewReadMock.mockClear();
    const renderRunsView = (run: MediaRunDetail) => (
      <MediaRunsView
        runs={[run]}
        selectedRun={run}
        runtimeStatus={{
          schemaVersion: 17,
          recoveredRuns: 0,
          queuedRuns: 0,
          activeRuns: 0,
          storageReady: true,
          mode: "native",
          directGenerationModelIds: ["openai:gpt-image-2"],
          directReferenceImageModelIds: ["openai:gpt-image-2"],
          localDiffusers: {
            status: "unavailable",
            ready: false,
            workerVersion: null,
            pythonVersion: null,
            packages: {},
            device: null,
            deviceLabel: null,
            deviceMemoryBytes: null,
            architectures: [],
            capabilities: [],
            diagnostic: "Not installed",
          },
        }}
        runtimeError={null}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onResolveProviderReview={vi.fn()}
        providerReviewPending={false}
        onResolveHumanReview={vi.fn()}
        humanReviewPending={false}
        onInspectInFlow={vi.fn()}
        onRefresh={vi.fn()}
      />
    );
    const { rerender } = render(renderRunsView(pendingHumanReviewRun));

    await waitFor(() => expect(previewReadMock).toHaveBeenCalledTimes(1));
    rerender(
      renderRunsView({
        ...pendingHumanReviewRun,
        assets: pendingHumanReviewRun.assets.map((asset) => ({ ...asset })),
        humanReviews: pendingHumanReviewRun.humanReviews.map((review) => ({ ...review })),
      }),
    );
    expect(previewReadMock).toHaveBeenCalledTimes(1);
  });

  it("lets a single-choice reviewer replace the selection in one click", () => {
    const onResolveHumanReview = vi.fn();
    const run: MediaRunDetail = {
      ...pendingHumanReviewRun,
      assets: [reviewAsset, alternateReviewAsset],
      humanReviews: pendingHumanReviewRun.humanReviews.map((review) => ({
        ...review,
        candidateAssetIds: [reviewAsset.id, alternateReviewAsset.id],
      })),
    };
    render(
      <MediaRunsView
        runs={[run]}
        selectedRun={run}
        runtimeStatus={{
          schemaVersion: 17,
          recoveredRuns: 0,
          queuedRuns: 0,
          activeRuns: 0,
          storageReady: true,
          mode: "native",
          directGenerationModelIds: ["openai:gpt-image-2"],
          directReferenceImageModelIds: ["openai:gpt-image-2"],
          localDiffusers: {
            status: "unavailable",
            ready: false,
            workerVersion: null,
            pythonVersion: null,
            packages: {},
            device: null,
            deviceLabel: null,
            deviceMemoryBytes: null,
            architectures: [],
            capabilities: [],
            diagnostic: "Not installed",
          },
        }}
        runtimeError={null}
        onCreate={vi.fn()}
        onSelect={vi.fn()}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onResolveProviderReview={vi.fn()}
        providerReviewPending={false}
        onResolveHumanReview={onResolveHumanReview}
        humanReviewPending={false}
        onInspectInFlow={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Candidate 1, not selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Candidate 2, not selected" }));
    expect(screen.getByRole("button", { name: "Candidate 1, not selected" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Candidate 2, selected" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve 1" }));
    expect(onResolveHumanReview).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "approve",
        selectedAssetIds: [alternateReviewAsset.id],
      }),
    );
  });
});
