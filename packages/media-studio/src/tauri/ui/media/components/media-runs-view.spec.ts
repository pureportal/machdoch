// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MediaAssetRecord,
  MediaRuntimeRunRecord,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import { MediaRunsView } from "./media-runs-view";
import { MediaRunRow } from "./media-run-row";
import { selectRunPreview } from "../media-run-presentation";
import { MediaErrorNotice } from "./media-error-notice";

vi.mock("./media-visual-preview", () => ({
  MediaAssetPreview: ({ asset }: { asset: MediaAssetRecord }) =>
    createElement(
      "div",
      { "data-testid": "asset-preview", "data-asset-id": asset.id },
      asset.kind,
    ),
}));

const run = (
  status: MediaRuntimeRunRecord["status"],
): MediaRuntimeRunRecord => ({
  id: `run-${status}`,
  flowId: "flow-image",
  flowRevisionId: "revision-image",
  flowName: "Create image",
  planId: "plan-image",
  status,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:01.000Z",
  prompt: "A portrait",
  modelLabel: "Image model",
  target: "local",
  outputCount: 1,
  diagnosticCount: 0,
  progress: status === "completed" ? 1 : 0.5,
  currentStep: status,
  executor: "local-image-flow",
  error: null,
  failure: null,
});

describe("Activity journeys", () => {
  const detail = (status: MediaRuntimeRunRecord["status"]): MediaRunDetail => ({
    ...run(status),
    executor: "media-workflow",
    assets: [],
    events: [],
    providerJobs: [],
    humanReviews: [],
    nodeExecutions: [],
    planSnapshot: null,
  });
  const props = (
    selectedRun: MediaRunDetail,
  ): ComponentProps<typeof MediaRunsView> => ({
    runs: [selectedRun],
    assets: selectedRun.assets,
    selectedRun,
    selectedRunId: selectedRun.id,
    selectedRunLoading: false,
    selectedRecipe: null,
    onCreate: vi.fn(),
    onClose: vi.fn(),
    onSelect: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onResolveProviderReview: vi.fn(),
    providerReviewPending: false,
    onResolveHumanReview: vi.fn(),
    humanReviewPending: false,
    onInspectInFlow: vi.fn(),
    onReuseSettings: vi.fn(),
    onRefresh: vi.fn(),
    onOpenAsset: vi.fn(),
  });
  it("combines search and status filters, resets pagination, and clears empty results", () => {
    const selected = detail("completed");
    const handlers = props(selected);
    const runs = Array.from({ length: 35 }, (_, index) => ({
      ...run(index % 2 ? "failed" : "completed"),
      id: `history-${index}`,
      prompt: index % 2 ? "Forest" : "Ocean",
      createdAt: new Date(Date.UTC(2026, 7, 20, 10, index)).toISOString(),
    }));
    render(
      createElement(MediaRunsView, {
        ...handlers,
        runs,
        selectedRun: null,
        selectedRunId: null,
      }),
    );
    expect(
      screen.getAllByRole("button", { name: /^Open Create image/ }),
    ).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Next runs page" }));
    expect(
      screen.getAllByRole("button", { name: /^Open Create image/ }),
    ).toHaveLength(5);
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search run history" }),
      { target: { value: "Ocean" } },
    );
    expect(
      screen.getAllByRole("button", { name: /^Open Create image/ }),
    ).toHaveLength(18);
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter runs by status" }),
      { target: { value: "failed" } },
    );
    expect(screen.getByText("No matching runs")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(
      screen.getAllByRole("button", { name: /^Open Create image/ }),
    ).toHaveLength(30);
    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalledWith({ top: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh runs" }));
    expect(handlers.onRefresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "New recipe" }));
    expect(handlers.onCreate).toHaveBeenCalledOnce();
  });

  it("keeps full prompts and settings in the dialog and offers a close action", () => {
    const selected = detail("completed");
    const handlers = props(selected);
    render(createElement(MediaRunsView, handlers));
    const dialog = within(screen.getByRole("dialog", { name: "Create image" }));
    expect(dialog.getByText("A portrait")).toBeTruthy();
    expect(dialog.getByText("Settings").closest("details")?.open).toBe(false);
    fireEvent.click(dialog.getByRole("button", { name: "Reuse settings" }));
    expect(handlers.onReuseSettings).toHaveBeenCalledWith(selected.id);
    fireEvent.click(dialog.getByRole("button", { name: "Inspect flow" }));
    expect(handlers.onInspectInFlow).toHaveBeenCalledWith(selected);
    vi.mocked(handlers.onClose).mockClear();
    fireEvent.click(dialog.getByRole("button", { name: "Close" }));
    expect(handlers.onClose).toHaveBeenCalledOnce();
  });

  it("opens the exact final output and loads intermediates only on request", () => {
    const selected = detail("completed");
    const final: MediaAssetRecord = {
      ...asset(selected.id, "image"),
      id: "final",
      outputIndex: 2,
      operation: {
        kind: "workflow",
        sourceNodeId: "save",
        iteration: 1,
        details: { finalOutput: true },
      },
    };
    selected.assets = [
      asset(selected.id, "image"),
      final,
      asset(selected.id, "report"),
    ];
    const handlers = props(selected);
    render(createElement(MediaRunsView, handlers));
    const results = within(screen.getByRole("region", { name: "Run results" }));
    expect(results.getAllByTestId("asset-preview")).toHaveLength(1);
    fireEvent.click(results.getByRole("button", { name: "View Image 3" }));
    expect(handlers.onOpenAsset).toHaveBeenCalledWith(final);
    const disclosure = results
      .getByText("Intermediate results (2)")
      .closest("details")!;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(results.getAllByTestId("asset-preview")).toHaveLength(2);
    expect(results.getByRole("button", { name: "Save report" })).toBeTruthy();
  });
  it("keeps action errors inside the open dialog", () => {
    const selected = detail("running");
    render(
      createElement(MediaRunsView, {
        ...props(selected),
        errorNotice: createElement(
          "div",
          { role: "alert" },
          "Cancellation failed. Try again.",
        ),
      }),
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("alert").textContent,
    ).toBe("Cancellation failed. Try again.");
  });
  it("keeps provider review actions visible and respects pending decisions", () => {
    const selected = detail("needs-review");
    selected.executor = "mock-remote-provider";
    selected.providerJobs = [
      {
        id: "provider-1",
        runId: selected.id,
        attempt: 1,
        status: "acceptance-unknown",
        rawState: null,
        scenario: "acceptance-unknown",
        requestDigest: "a".repeat(64),
        idempotencyKey: "request-1",
        providerJobId: null,
        providerRequestId: null,
        estimatedCostMin: 0,
        estimatedCostMax: 1,
        currency: "USD",
        pollAttempts: 0,
        nextPollAt: null,
        reconciliationDeadline: selected.createdAt,
        acceptedAt: null,
        retentionExpiresAt: null,
        lateSuccess: false,
        reviewRequired: true,
        reviewReason: "Check whether the request was accepted.",
        error: null,
        failure: null,
        createdAt: selected.createdAt,
        updatedAt: selected.updatedAt,
        completedAt: null,
        policy: {
          adapterId: "mock",
          adapterVersion: "1",
          endpointVersion: "1",
          region: "test",
          idempotencyMode: "provider-key",
          retryPolicy: "Reconcile before retrying.",
          cancellationSemantics: "Cancellation may race with completion.",
          inputRetentionSeconds: null,
          outputRetentionSeconds: null,
          outputVisibility: "private-signed-url",
          publicLinks: false,
          noStoreRequested: true,
          uploadAssetCount: 0,
          uploadBytes: 0,
          containsPersonalData: false,
          remoteUploadAllowed: true,
        },
      },
    ];
    const handlers = props(selected);
    const view = render(createElement(MediaRunsView, handlers));
    expect(screen.getByText("Provider review").closest("details")?.open).toBe(
      true,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Lookup original request" }),
    );
    expect(handlers.onResolveProviderReview).toHaveBeenCalledWith(
      "provider-1",
      "reconcile-only",
    );
    view.rerender(
      createElement(MediaRunsView, {
        ...handlers,
        providerReviewPending: true,
      }),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Reconciling…",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("requires a candidate and review note, and confirms rejection", () => {
    const selected = detail("waiting-for-review");
    selected.assets = [asset(selected.id, "image")];
    selected.humanReviews = [
      {
        id: "review-1",
        runId: selected.id,
        nodeId: "review",
        sequence: 1,
        status: "pending",
        instructions: "Choose the strongest composition.",
        maxSelections: 1,
        requireComment: true,
        candidateAssetIds: [selected.assets[0]!.id],
        selectedAssetIds: [],
        decisionId: null,
        decisionAction: null,
        comment: null,
        actor: null,
        createdAt: selected.createdAt,
        updatedAt: selected.updatedAt,
        decidedAt: null,
      },
    ];
    const handlers = props(selected);
    const view = render(createElement(MediaRunsView, handlers));
    const approve = screen.getByRole("button", {
      name: "Approve selection",
    }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Candidate 1, not selected" }),
    );
    expect(
      (screen.getByRole("button", { name: "Approve 1" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /Review note/ }), {
      target: { value: "Clear composition" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Approve 1" }));
    expect(handlers.onResolveHumanReview).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: "review-1",
        action: "approve",
        selectedAssetIds: [selected.assets[0]!.id],
        comment: "Clear composition",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reject all candidates" }),
    );
    expect(handlers.onResolveHumanReview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Confirm reject all" }));
    expect(handlers.onResolveHumanReview).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: "reject", selectedAssetIds: [] }),
    );
    view.rerender(
      createElement(MediaRunsView, { ...handlers, humanReviewPending: true }),
    );
    expect(
      (screen.getByRole("button", { name: "Recording…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("keeps inconclusive outcomes visible and routes recovery to their results", () => {
    const failed = detail("failed");
    failed.failure = {
      schemaVersion: 1,
      code: "QUALITY_GATE_FAILED",
      category: "validation",
      message: "The visual reviews could not assess the handle count.",
      technicalDiagnostic: "Incomplete assessment from both reviews",
      retryability: "after-user-action",
      partialOutputsExist: true,
      context: {
        runId: failed.id,
        operation: "run_execution",
        nodeId: "gate",
        providerId: null,
        modelId: null,
        runtimeId: null,
        assetId: null,
      },
      suggestedActions: [
        {
          id: "review-input",
          label: "Review gate",
          description: "Review the image and gate settings.",
        },
      ],
    };
    failed.assets = [
      {
        ...asset(failed.id, "report"),
        operation: {
          kind: "workflow",
          sourceNodeId: "check",
          iteration: 1,
          details: { verdict: "unknown" },
        },
      },
    ];
    const onAction = vi.fn();
    render(
      createElement(MediaErrorNotice, {
        error: failed.failure,
        onAction,
        onDismiss: vi.fn(),
      }),
    );
    expect(screen.getByText("Quality checks stopped this run.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review results" }));
    expect(onAction).toHaveBeenCalledWith("review-run");
    render(createElement(MediaRunsView, props(failed)));
    expect(screen.getByText("Inconclusive")).toBeTruthy();
    expect(
      screen.getByText("Quality check details").closest("details")?.open,
    ).toBe(false);
    expect(
      screen.getByText(failed.failure.message).closest("details"),
    ).not.toBeNull();
  });
  it("retains failed attempts for inspection and exposes rerun and cancellation at the run", () => {
    const failed = detail("failed");
    failed.assets = [asset(failed.id, "image")];
    const handlers = props(failed);
    const view = render(createElement(MediaRunsView, handlers));
    expect(screen.getByText("Intermediate results (1)")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Results" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit and rerun" }));
    expect(handlers.onReuseSettings).toHaveBeenCalledWith(failed.id);
    const running = detail("running");
    view.rerender(
      createElement(MediaRunsView, {
        ...handlers,
        runs: [running],
        selectedRun: running,
        selectedRunId: running.id,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(handlers.onCancel).toHaveBeenCalledWith(running.id);
    view.rerender(
      createElement(MediaRunsView, {
        ...handlers,
        selectedRun: null,
        selectedRunLoading: true,
      }),
    );
    expect(screen.getByText("Loading run…")).toBeTruthy();
    expect(
      screen.queryByRole("complementary", { name: "Run inspector" }),
    ).toBeNull();
  });
});

const asset = (
  runId: string,
  kind: MediaAssetRecord["kind"],
): MediaAssetRecord => ({
  id: `asset-${kind}`,
  runId,
  digest: "a".repeat(64),
  kind,
  mimeType: kind === "report" ? "application/json" : "image/png",
  byteSize: 128,
  width: kind === "report" ? 0 : 512,
  height: kind === "report" ? 0 : 512,
  createdAt: "2026-08-20T10:00:01.000Z",
  outputIndex: 0,
  fixture: true,
  operation: null,
  sourceAssetIds: [],
  tags: [],
});

afterEach(cleanup);

beforeEach(() => {
  HTMLElement.prototype.scrollTo = vi.fn();
});

describe("Activity rows", () => {
  it("prefers a final workflow output over intermediate attempts", () => {
    const workflow = {
      ...run("completed"),
      executor: "media-workflow" as const,
    };
    const first = {
      ...asset(workflow.id, "image"),
      id: "first",
      outputIndex: 0,
    };
    const latest = { ...first, id: "latest", outputIndex: 3 };
    const final: MediaAssetRecord = {
      ...first,
      id: "final",
      outputIndex: 2,
      operation: {
        kind: "workflow",
        sourceNodeId: "save",
        iteration: 1,
        details: { finalOutput: true },
      },
    };
    expect(selectRunPreview(workflow, [first, latest])).toBe(latest);
    expect(selectRunPreview(workflow, [first, latest, final])).toBe(final);
  });

  it("shows one state, omits terminal progress, and counts saved outputs", () => {
    const canceled = run("canceled");
    const view = render(
      createElement(MediaRunRow, {
        run: canceled,
        assets: [],
        selected: false,
        onSelect: vi.fn(),
      }),
    );
    expect(screen.getAllByText("Canceled")).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/output/)).toBeNull();
    expect(screen.queryByTestId("asset-preview")).toBeNull();
    const completed = {
      ...run("completed"),
      executor: "media-workflow" as const,
    };
    const final: MediaAssetRecord = {
      ...asset(completed.id, "image"),
      id: "final",
      operation: {
        kind: "workflow",
        sourceNodeId: "save",
        iteration: 1,
        details: { finalOutput: true },
      },
    };
    view.rerender(
      createElement(MediaRunRow, {
        run: completed,
        assets: [asset(completed.id, "image"), final],
        selected: false,
        onSelect: vi.fn(),
      }),
    );
    expect(screen.getByText("1 output")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("shows progress only for active execution and opens the selected run", () => {
    const onSelect = vi.fn();
    const running = { ...run("running"), currentStep: "Sampling image" };
    const view = render(
      createElement(MediaRunRow, {
        run: running,
        assets: [],
        selected: false,
        onSelect,
      }),
    );
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "50",
    );
    expect(screen.getByText("Sampling image")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open Create image/ }));
    expect(onSelect).toHaveBeenCalledWith(running.id);
    view.rerender(
      createElement(MediaRunRow, {
        run: run("queued"),
        assets: [],
        selected: false,
        onSelect,
      }),
    );
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
