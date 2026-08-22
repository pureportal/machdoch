// @vitest-environment jsdom

import { createElement, type ComponentProps } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import type {
  MediaCompiledPlan,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  normalizeMediaStudioState,
} from "../media-studio-store";
import { MediaGenerateView } from "./media-generate-view";

vi.mock("./media-visual-preview", () => ({
  MediaAssetPreview: () => null,
  MediaResourcePreview: () => null,
}));

const noop = (): void => {};
const baseState = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);
const catalog = createMediaModelCatalogSnapshot({
  isOpenAiConfigured: false,
  isLocalFluxInstalled: true,
});
const imageModel = catalog.models.find(
  (model) => model.id === "local:flux-2-klein-4b",
)!;
const readyPlan: MediaCompiledPlan = {
  schemaVersion: 1,
  id: "plan-basic-image",
  flowId: "flow-basic-image",
  flowFingerprint: "flow-fingerprint",
  status: "ready",
  compiledAt: "2026-08-20T10:00:00.000Z",
  model: imageModel,
  runtimeBindings: [],
  addons: [],
  steps: [],
  diagnostics: [],
  preflight: {
    target: "local",
    modelId: imageModel.id,
    modelLabel: imageModel.displayName,
    requiresRemoteRequest: false,
    requiresModelDownload: false,
    requiresHumanReview: false,
    remoteUploadAssetIds: [],
    generatedCandidates: 1,
    estimatedOutputs: 1,
    estimatedVramGb: null,
    estimatedDownloadGb: null,
    costHint: "Local",
    privacySummary: "Local",
  },
};

type MediaGenerateViewProps = ComponentProps<typeof MediaGenerateView>;

const createProps = (
  overrides: Partial<MediaGenerateViewProps> = {},
): MediaGenerateViewProps => ({
  target: "image",
  settings: {
    ...baseState.recipe,
    prompt: "A quiet lakeside cabin",
    modelId: imageModel.id,
  },
  videoSettings: baseState.videoRecipe,
  assetMetadata: {},
  plan: readyPlan,
  catalog,
  directGenerationModelIds: [imageModel.id],
  directReferenceImageModelIds: [imageModel.id],
  videoGenerationSupported: true,
  videoGenerationBlockedReason: null,
  referenceAssets: [],
  referenceImportSupported: true,
  referenceImportPending: false,
  generatedRun: null,
  persistenceError: null,
  onTargetChange: noop,
  onChange: noop,
  onVideoSettingsChange: noop,
  onOpenFlow: noop,
  onOpenAssets: noop,
  onOpenActivity: noop,
  onGenerate: noop,
  onAddReferenceImages: noop,
  onEditResult: noop,
  onAnimateResult: noop,
  onOpenResult: noop,
  generationPending: false,
  ...overrides,
});

const createQueuedRun = (): MediaRunDetail => ({
  id: "run-basic-image",
  flowId: "flow-basic-image",
  flowRevisionId: "revision-basic-image",
  flowName: "Create image",
  planId: readyPlan.id,
  status: "running",
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:01.000Z",
  prompt: "A quiet lakeside cabin",
  modelLabel: imageModel.displayName,
  target: "local",
  outputCount: 1,
  diagnosticCount: 0,
  progress: 0.42,
  currentStep: "Rendering image",
  executor: "local-import",
  error: null,
  failure: null,
  events: [],
  assets: [],
  providerJobs: [],
  humanReviews: [],
  nodeExecutions: [],
  planSnapshot: null,
});

afterEach(() => {
  cleanup();
});

describe("MediaGenerateView", () => {
  it("keeps optional settings collapsed while the primary inputs stay clear", () => {
    render(createElement(MediaGenerateView, createProps()));

    expect(screen.getByLabelText("Prompt")).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Reference images" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Add reference images" }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Aspect ratio")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /More options/u }));

    expect(screen.getByLabelText("Aspect ratio")).toBeTruthy();
    expect(screen.getByLabelText("Outputs")).toBeTruthy();
  });

  it("removes the prompt from SVG vectorization and requires a source image", () => {
    render(
      createElement(
        MediaGenerateView,
        createProps({
          target: "svg",
          settings: {
            ...baseState.recipe,
            prompt: "",
            modelId: null,
            outputFormat: "svg",
            svgMode: "vectorize",
          },
          directGenerationModelIds: [],
          directReferenceImageModelIds: [],
        }),
      ),
    );

    expect(screen.queryByLabelText("Prompt")).toBeNull();
    expect(screen.getByRole("heading", { name: "Source image" })).toBeTruthy();
    expect(screen.getByText("Choose an image to vectorize")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Generate svg",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("generates from the prompt with the platform submit shortcut", () => {
    const onGenerate = vi.fn();
    render(createElement(MediaGenerateView, createProps({ onGenerate })));

    fireEvent.keyDown(screen.getByLabelText("Prompt"), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it("keeps active run progress and the current step in the result pane", () => {
    render(
      createElement(
        MediaGenerateView,
        createProps({ generatedRun: createQueuedRun() }),
      ),
    );

    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("Rendering image")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "Generation progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("42");
    expect(
      (
        screen.getByRole("button", {
          name: "Generating image",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
