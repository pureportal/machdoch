// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MediaAssetRecord,
  MediaRuntimeRunRecord,
} from "../../../../core/media/contracts.js";
import { MediaActivityPreview } from "./media-runs-view";

vi.mock("./media-visual-preview", () => ({
  MediaAssetPreview: ({ asset }: { asset: MediaAssetRecord }) =>
    createElement("div", { "data-testid": "asset-preview" }, asset.kind),
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
