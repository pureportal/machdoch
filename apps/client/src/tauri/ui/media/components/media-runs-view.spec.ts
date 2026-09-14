// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MediaAssetRecord,
  MediaRuntimeRunRecord,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import { MediaActivityPreview, MediaRunsView } from "./media-runs-view";
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
    render(createElement(MediaRunsView, props(failed)));
    expect(screen.getByText("Quality checks stopped this run.")).toBeTruthy();
    expect(screen.getByText("Inconclusive")).toBeTruthy();
    expect(
      screen.getByText("Quality check details").closest("details")?.open,
    ).toBe(false);
    expect(
      screen.getByText(failed.failure.message).closest("details"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review results" }));
    expect(onAction).toHaveBeenCalledWith("review-run");
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

describe("MediaActivityPreview", () => {
  it("previews the latest workflow result and prefers a final output over masks and attempts", () => {
    const workflow = {
      ...run("completed"),
      executor: "media-workflow" as const,
    };
    const mask = { ...asset(workflow.id, "image"), id: "mask", outputIndex: 0 };
    const first = {
      ...asset(workflow.id, "image"),
      id: "first",
      outputIndex: 1,
    };
    const latest = {
      ...asset(workflow.id, "image"),
      id: "latest",
      outputIndex: 3,
    };
    const final: MediaAssetRecord = {
      ...asset(workflow.id, "image"),
      id: "final",
      outputIndex: 2,
      operation: {
        kind: "workflow",
        sourceNodeId: "save",
        iteration: 1,
        details: { finalOutput: true },
      },
    };
    const view = render(
      createElement(MediaActivityPreview, {
        run: workflow,
        assets: [mask, latest, first, asset(workflow.id, "report")],
      }),
    );
    expect(
      screen.getByTestId("asset-preview").getAttribute("data-asset-id"),
    ).toBe("latest");
    view.rerender(
      createElement(MediaActivityPreview, {
        run: workflow,
        assets: [mask, final, latest, first],
      }),
    );
    expect(
      screen.getByTestId("asset-preview").getAttribute("data-asset-id"),
    ).toBe("final");
  });

  it("shows available media and distinct non-media states", () => {
    const completed = run("completed");
    const view = render(
      createElement(MediaActivityPreview, {
        run: completed,
        assets: [asset(completed.id, "image")],
      }),
    );
    expect(screen.getByTestId("asset-preview").textContent).toBe("image");

    view.rerender(
      createElement(MediaActivityPreview, {
        run: completed,
        assets: [asset(completed.id, "report")],
      }),
    );
    expect(screen.getByRole("img", { name: "Report generated" })).toBeTruthy();

    view.rerender(
      createElement(MediaActivityPreview, { run: completed, assets: [] }),
    );
    expect(
      screen.getByRole("img", { name: "Output unavailable" }),
    ).toBeTruthy();

    view.rerender(
      createElement(MediaActivityPreview, {
        run: run("failed"),
        assets: [],
      }),
    );
    expect(screen.getByRole("img", { name: "Generation failed" })).toBeTruthy();

    view.rerender(
      createElement(MediaActivityPreview, {
        run: run("canceled"),
        assets: [],
      }),
    );
    expect(
      screen.getByRole("img", { name: "Generation canceled" }),
    ).toBeTruthy();
  });

  it("shows queued and running work as status instead of missing media", () => {
    const view = render(
      createElement(MediaActivityPreview, {
        run: run("queued"),
        assets: [],
      }),
    );
    expect(
      screen.getByRole("status", { name: "Generation queued" }),
    ).toBeTruthy();

    view.rerender(
      createElement(MediaActivityPreview, {
        run: run("running"),
        assets: [],
      }),
    );
    expect(
      screen.getByRole("status", { name: "Generation running" }),
    ).toBeTruthy();
  });
});
