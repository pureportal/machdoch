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
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import type {
  MediaAssetRecord,
  MediaCompiledPlan,
  MediaModelAddonDescriptor,
} from "../../../../core/media/contracts.js";
import { getMediaModelAddonCapabilities } from "../../../../core/media/model-addons.js";
import type { MediaGenerationQueueJob } from "../media-generation-queue";
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
const sourceAsset: MediaAssetRecord = {
  id: "asset:source",
  runId: "run:source",
  digest: "c".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 1_024,
  width: 1_200,
  height: 800,
  createdAt: "2026-08-20T10:00:00.000Z",
  outputIndex: 0,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [],
};
const addon: MediaModelAddonDescriptor = {
  id: "addon:portrait-detail",
  kind: "lora",
  displayName: "Portrait Detail",
  architecture: "flux-2",
  architectureConfidence: "high",
  format: "safetensors",
  targetComponents: ["denoiser"],
  embeddingVectors: [],
  loraProfile: {
    algorithm: "lora",
    dialect: "diffusers-peft",
    rankMinimum: 16,
    rankMaximum: 16,
    heterogeneousRanks: false,
    targetModuleCount: 64,
    convolutionTargetCount: 0,
    magnitudeVectorCount: 0,
    networkAlphaCount: 64,
  },
  baseModelHint: "FLUX.2",
  triggerWords: ["portrait detail"],
  defaultToken: null,
  digest: "a".repeat(64),
  headerDigest: "b".repeat(64),
  byteSize: 1_000,
  relativePath: "portrait.safetensors",
  sourceUrl: null,
  license: {
    name: "Test",
    spdxId: null,
    sourceUrl: "https://example.test/license",
    commercialUse: "allowed",
    requiresAcceptance: false,
  },
  importedAt: "2026-08-20T10:00:00.000Z",
};
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
  categories: [],
  plan: readyPlan,
  catalog,
  directGenerationModelIds: [imageModel.id],
  directReferenceImageModelIds: [imageModel.id],
  directInpaintingModelIds: [imageModel.id],
  directPoseModelIds: [],
  videoGenerationSupported: true,
  videoGenerationBlockedReason: null,
  referenceAssets: [],
  referenceImportSupported: true,
  referenceImportPending: false,
  generationJob: null,
  generationJobs: [],
  queueBusy: false,
  persistenceError: null,
  onTargetChange: noop,
  onChange: noop,
  onVideoSettingsChange: noop,
  onOpenFlow: noop,
  onOpenAssets: noop,
  onOpenActivity: noop,
  onGenerate: noop,
  onAddReferenceImages: noop,
  onAddBaseImage: noop,
  onAddPoseImage: noop,
  onEditResult: noop,
  onAnimateResult: noop,
  onOpenResult: noop,
  generationPending: false,
  ...overrides,
});

const createQueuedRun = (): MediaGenerationQueueJob => ({
  id: "run-basic-image",
  runId: "run-basic-image",
  status: "running",
  label: "Image generation",
  submittedAt: "2026-08-20T10:00:00.000Z",
  startedAt: "2026-08-20T10:00:01.000Z",
  completedAt: null,
  progress: 0.42,
  currentStep: "Rendering image",
  recipe: {
    schemaVersion: 1,
    mode: "basic",
    target: "image",
    flowId: "flow-basic-image",
    flowName: "Create image",
    flowRevisionId: "revision-basic-image",
    flowRevisionNumber: 1,
    planId: readyPlan.id,
    prompt: "A quiet lakeside cabin",
    modelId: imageModel.id,
    modelLabel: imageModel.displayName,
    modelAddons: [],
    outputBranches: [],
    imageSettings: null,
    videoSettings: null,
    resultDestination: "assets",
  },
  error: null,
  failure: null,
  assets: [],
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

  it("keeps a capable FLUX model runnable after selecting a reference", () => {
    render(
      createElement(
        MediaGenerateView,
        createProps({
          settings: {
            ...baseState.recipe,
            prompt: "Preserve this subject",
            modelId: imageModel.id,
            referenceImages: [
              { assetId: sourceAsset.id, role: "subject", influence: 1 },
            ],
          },
          referenceAssets: [sourceAsset],
        }),
      ),
    );

    expect(
      screen.getByRole("combobox", { name: "Model" }).textContent,
    ).toContain("FLUX.2 klein 4B");
    expect(
      (
        screen.getByRole("button", {
          name: "Generate image",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("does not offer unsupported KREA image conditioning", () => {
    const kreaModel = {
      ...imageModel,
      id: "local:user:krea-2",
      displayName: "KREA 2 test model",
      architecture: "krea-2" as const,
      addonCapabilities: getMediaModelAddonCapabilities(
        "local-diffusers",
        "krea-2",
      ),
    };
    const kreaPlan = {
      ...readyPlan,
      model: kreaModel,
      preflight: {
        ...readyPlan.preflight,
        modelId: kreaModel.id,
        modelLabel: kreaModel.displayName,
      },
    };
    const onGenerate = vi.fn();
    render(
      createElement(
        MediaGenerateView,
        createProps({
          settings: {
            ...baseState.recipe,
            prompt: "",
            modelId: kreaModel.id,
            referenceImages: [
              { assetId: sourceAsset.id, role: "style", influence: 0.35 },
            ],
          },
          catalog: { ...catalog, models: [kreaModel] },
          plan: kreaPlan,
          directGenerationModelIds: [kreaModel.id],
          directReferenceImageModelIds: [],
          directInpaintingModelIds: [],
          referenceAssets: [sourceAsset],
          onGenerate,
        }),
      ),
    );

    expect(
      screen.getByLabelText("Reference 1 role").querySelectorAll("option"),
    ).toHaveLength(0);
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
      "",
    );
    const generate = screen.getByRole("button", { name: "Generate image" });
    expect((generate as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(generate);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("defaults a new SDXL reference to its only executable role", () => {
    const sdxlModel = {
      ...imageModel,
      id: "local:user:sdxl",
      displayName: "SDXL test model",
      architecture: "stable-diffusion-xl" as const,
      addonCapabilities: getMediaModelAddonCapabilities(
        "local-diffusers",
        "stable-diffusion-xl",
      ),
    };
    const onChange = vi.fn();
    render(
      createElement(
        MediaGenerateView,
        createProps({
          settings: {
            ...baseState.recipe,
            modelId: sdxlModel.id,
            referenceImages: [],
          },
          catalog: { ...catalog, models: [sdxlModel] },
          plan: {
            ...readyPlan,
            model: sdxlModel,
            preflight: {
              ...readyPlan.preflight,
              modelId: sdxlModel.id,
              modelLabel: sdxlModel.displayName,
            },
          },
          directGenerationModelIds: [sdxlModel.id],
          directReferenceImageModelIds: [sdxlModel.id],
          referenceAssets: [sourceAsset],
          onChange,
        }),
      ),
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Choose from Assets" })[0]!,
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose asset 1" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceImages: [
          { assetId: sourceAsset.id, role: "composition", influence: 1 },
        ],
      }),
    );
  });

  it("runs masked edits only when the selected model is directly inpainting-capable", () => {
    const inpaintingCatalog = {
      ...catalog,
      models: catalog.models.map((model) =>
        model.id === imageModel.id
          ? {
              ...model,
              capabilities: [
                ...model.capabilities,
                "masked-image-edit" as const,
              ],
            }
          : model,
      ),
    };
    const settings = {
      ...baseState.recipe,
      prompt: "Replace the painted region",
      modelId: imageModel.id,
      baseImageAssetId: sourceAsset.id,
      editMask: {
        schemaVersion: 2 as const,
        sourceAssetId: sourceAsset.id,
        inverted: false,
        strokes: [
          {
            mode: "paint" as const,
            size: 0.08,
            opacity: 1,
            softness: 0.35,
            points: [{ x: 0.5, y: 0.5 }],
          },
        ],
      },
    };
    const { rerender } = render(
      createElement(
        MediaGenerateView,
        createProps({
          settings,
          catalog: inpaintingCatalog,
          referenceAssets: [sourceAsset],
        }),
      ),
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Generate image",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    rerender(
      createElement(
        MediaGenerateView,
        createProps({
          settings,
          catalog: inpaintingCatalog,
          referenceAssets: [sourceAsset],
          directInpaintingModelIds: [],
        }),
      ),
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Generate image",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("runs a full base-image edit without forcing a mask", () => {
    const onChange = vi.fn();
    render(
      createElement(
        MediaGenerateView,
        createProps({
          settings: {
            ...baseState.recipe,
            prompt: "Restyle the whole image",
            modelId: imageModel.id,
            baseImageAssetId: sourceAsset.id,
            editMask: null,
          },
          referenceAssets: [sourceAsset],
          directInpaintingModelIds: [],
          onChange,
        }),
      ),
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Generate image",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(screen.queryByLabelText("Image edit mask canvas")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Mask area" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        outputFormat: "png",
        editMask: {
          schemaVersion: 2,
          sourceAssetId: sourceAsset.id,
          inverted: false,
          strokes: [],
        },
      }),
    );
  });

  it("keeps active run progress and the current step in the result pane", () => {
    render(
      createElement(
        MediaGenerateView,
        createProps({
          generationJob: createQueuedRun(),
          generationJobs: [createQueuedRun()],
          queueBusy: true,
        }),
      ),
    );

    expect(screen.getByText(/running · 42%/i)).toBeTruthy();
    expect(screen.getByText("Rendering image")).toBeTruthy();
    expect(
      screen
        .getByRole("progressbar", { name: "FLUX.2 klein 4B progress" })
        .getAttribute("aria-valuenow"),
    ).toBe("42");
    expect(
      (
        screen.getByRole("button", {
          name: "Queue image",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("opens compact add-on browsing in a dialog without leaving for Assets", () => {
    const onOpenAssets = vi.fn();
    const onChange = vi.fn();
    render(
      createElement(
        MediaGenerateView,
        createProps({
          catalog: { ...catalog, addons: [addon] },
          assetMetadata: {
            [addon.id]: {
              categoryIds: ["portrait"],
              tags: ["warm"],
              triggerWords: "",
              sourceUrl: null,
              sampleAssetIds: [],
              sampleImages: [],
            },
          },
          categories: [{ id: "portrait", name: "Portrait" }],
          onOpenAssets,
          onChange,
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /More options/u }));
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));

    const dialog = screen.getByRole("dialog", { name: "Model add-ons" });
    expect(within(dialog).getByLabelText("Search add-ons")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: /Portrait Detail/u }),
    );
    expect(onChange).toHaveBeenCalled();
    expect(onOpenAssets).not.toHaveBeenCalled();
  });

  it("prunes stale add-ons that cannot run on the selected model", () => {
    const incompatible = {
      ...addon,
      id: "addon:stale-krea",
      architecture: "krea-2" as const,
      digest: "e".repeat(64),
    };
    const onChange = vi.fn();
    render(
      createElement(
        MediaGenerateView,
        createProps({
          catalog: { ...catalog, addons: [incompatible] },
          settings: {
            ...baseState.recipe,
            modelId: imageModel.id,
            modelAddons: [
              {
                kind: "lora",
                addonId: incompatible.id,
                enabled: true,
                modelStrength: 1,
                textEncoderStrength: null,
                denoisingSchedule: null,
              },
            ],
          },
          onChange,
        }),
      ),
    );

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ modelAddons: [] }),
    );
    expect(screen.queryByText("1 selected")).toBeNull();
  });

  it("keeps the active job type when the editor switches to video", () => {
    render(
      createElement(
        MediaGenerateView,
        createProps({
          target: "video",
          generationJob: createQueuedRun(),
          generationJobs: [createQueuedRun()],
          queueBusy: true,
        }),
      ),
    );

    expect(screen.getByText(`${imageModel.displayName} · image`)).toBeTruthy();
    expect(screen.queryByText(`${imageModel.displayName} · video`)).toBeNull();
    expect(screen.getByText("Rendering image")).toBeTruthy();
  });

  it("shows every active and terminal queue entry individually", () => {
    const statuses = [
      ["running", "Generating model", "Sampling"],
      ["queued", "Queued model", "Waiting"],
      ["completed", "Completed model", "Published"],
      ["failed", "Failed model", "Failed"],
      ["canceled", "Cancelled model", "Canceled"],
    ] as const;
    const jobs = statuses.map(([status, modelLabel, currentStep], index) => ({
      ...createQueuedRun(),
      id: `run-${status}`,
      runId: `run-${status}`,
      status,
      progress: status === "queued" ? 0 : 1,
      currentStep,
      completedAt:
        status === "running" || status === "queued"
          ? null
          : `2026-08-20T10:00:0${index}.000Z`,
      recipe: {
        ...createQueuedRun().recipe,
        modelLabel,
      },
    }));

    render(
      createElement(
        MediaGenerateView,
        createProps({
          generationJob: jobs[0],
          generationJobs: jobs,
          queueBusy: true,
        }),
      ),
    );

    for (const [, modelLabel, currentStep] of statuses) {
      expect(screen.getByText(new RegExp(modelLabel, "u"))).toBeTruthy();
      expect(screen.getByText(currentStep)).toBeTruthy();
    }
    expect(screen.getByText("running · 100%")).toBeTruthy();
    expect(screen.getByText("queued · 0%")).toBeTruthy();
    expect(screen.getByText("completed")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("cancelled")).toBeTruthy();
  });
});
