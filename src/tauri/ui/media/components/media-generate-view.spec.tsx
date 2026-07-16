import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import {
  compileMediaFlow,
  createImageEditFlow,
  createImageRecipeFlow,
} from "../../../../core/media/compiler.js";
import type {
  ImageRecipeSettings,
  MediaAssetRecord,
  MediaModelAddonDescriptor,
  MediaRunDetail,
} from "../../../../core/media/contracts.js";
import * as mediaRuntime from "../media-runtime";
import { MediaGenerateView } from "./media-generate-view";

const settings: ImageRecipeSettings = {
  prompt: "A cobalt paper sculpture under gallery lighting",
  providerPolicy: "remote",
  modelPolicy: "balanced",
  modelId: "openai:gpt-image-2",
  aspectRatio: "1:1",
  outputCount: 3,
  outputFormat: "png",
  transparentBackground: false,
  qualityGateEnabled: false,
  referenceImages: [],
  modelAddons: [],
};
const catalog = createMediaModelCatalogSnapshot({ isOpenAiConfigured: true });
const flow = createImageRecipeFlow({
  id: "flow:generate-disclosure",
  createdAt: "2026-07-14T12:00:00.000Z",
  settings,
});
const plan = compileMediaFlow({
  flow,
  models: catalog.models,
  compiledAt: "2026-07-14T12:01:00.000Z",
});

const referenceAssets: MediaAssetRecord[] = ["asset:base", "asset:style"].map(
  (id, index) => ({
    id,
    runId: `run:reference-${index}`,
    digest: `${index}`.repeat(64),
    kind: "image",
    mimeType: "image/png",
    byteSize: 1_024,
    width: 1_024,
    height: 1_024,
    createdAt: "2026-07-14T12:00:00.000Z",
    outputIndex: 0,
    fixture: false,
    operation: null,
    sourceAssetIds: [],
    tags: [],
  }),
);

describe("MediaGenerateView", () => {
  it("loads the newest submitted prompt with ArrowUp", () => {
    const onChange = vi.fn();
    const draftSettings = {
      ...settings,
      prompt: "An unsent variation",
    };

    render(
      <MediaGenerateView
        settings={draftSettings}
        plan={plan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        promptHistory={["First submitted prompt", "Latest submitted prompt"]}
        onChange={onChange}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    const textarea = screen.getByRole("textbox", {
      name: "Describe your image",
    }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });

    expect(onChange).toHaveBeenCalledWith({
      ...draftSettings,
      prompt: "Latest submitted prompt",
    });
  });

  it("exposes and preserves the explicit multi-LoRA stack order", () => {
    const localCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    });
    const addon = (id: string, displayName: string, digestCharacter: string) => ({
      id,
      kind: "lora",
      displayName,
      architecture: "flux-2",
      architectureConfidence: "high",
      format: "safetensors",
      targetComponents: ["denoiser"],
      embeddingVectors: [],
      loraProfile: {
        algorithm: "lora",
        dialect: "kohya",
        rankMinimum: 8,
        rankMaximum: 8,
        heterogeneousRanks: false,
        targetModuleCount: 1,
        convolutionTargetCount: 0,
        magnitudeVectorCount: 0,
        networkAlphaCount: 0,
      },
      baseModelHint: null,
      triggerWords: [],
      defaultToken: null,
      digest: digestCharacter.repeat(64),
      headerDigest: "f".repeat(64),
      byteSize: 1_024,
      relativePath: `addons/${id}.safetensors`,
      sourceUrl: null,
      license: {
        name: "Test terms",
        spdxId: null,
        sourceUrl: "https://example.com/terms",
        commercialUse: "review-required",
        requiresAcceptance: false,
      },
      importedAt: "2026-07-14T12:00:00.000Z",
    }) satisfies MediaModelAddonDescriptor;
    const first = addon("addon:first", "First look", "a");
    const second = addon("addon:second", "Second look", "b");
    localCatalog.addons = [first, second];
    const localSettings: ImageRecipeSettings = {
      ...settings,
      providerPolicy: "local",
      modelId: "local:flux-2-klein-4b",
      modelAddons: [
        {
          kind: "lora",
          addonId: first.id,
          enabled: true,
          modelStrength: 0.8,
          textEncoderStrength: null,
          denoisingSchedule: null,
        },
        {
          kind: "lora",
          addonId: second.id,
          enabled: true,
          modelStrength: 0.6,
          textEncoderStrength: null,
          denoisingSchedule: null,
        },
      ],
    };
    const localPlan = compileMediaFlow({
      flow: createImageRecipeFlow({
        id: "flow:ordered-loras",
        createdAt: "2026-07-14T12:00:00.000Z",
        settings: localSettings,
      }),
      models: localCatalog.models,
      addons: localCatalog.addons,
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    const onChange = vi.fn();

    render(
      <MediaGenerateView
        settings={localSettings}
        plan={localPlan}
        catalog={localCatalog}
        directGenerationModelIds={["local:flux-2-klein-4b"]}
        directReferenceImageModelIds={[]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={onChange}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(screen.getByText("Stack 1")).toBeTruthy();
    expect(screen.getByText("Stack 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move Second look up" }));
    expect(onChange).toHaveBeenCalledWith({
      ...localSettings,
      modelAddons: [localSettings.modelAddons[1], localSettings.modelAddons[0]],
    });
    fireEvent.click(screen.getByText("Strength · 0.80"));
    fireEvent.click(
      screen.getAllByRole("checkbox", { name: "Limit to part of denoising" })[0]!,
    );
    expect(onChange).toHaveBeenCalledWith({
      ...localSettings,
      modelAddons: [
        {
          ...localSettings.modelAddons[0],
          denoisingSchedule: { start: 0, end: 1 },
        },
        localSettings.modelAddons[1],
      ],
    });
  });

  it("offers a direct Generate action without redundant runtime copy", () => {
    const onGenerate = vi.fn();
    const onGenerateWithReview = vi.fn();
    render(
      <MediaGenerateView
        settings={settings}
        plan={plan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={vi.fn()}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={onGenerate}
        onGenerateWithReview={onGenerateWithReview}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="browser-preview"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Generate 3 images" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate & choose" }));
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerateWithReview).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("combobox", {
        name: "Model / provider",
      }) as HTMLSelectElement).value,
    ).toBe("openai:gpt-image-2");
  });

  it("explains that OpenAI cannot use LoRAs or textual-inversion embeddings", () => {
    const onOpenModels = vi.fn();
    render(
      <MediaGenerateView
        settings={settings}
        plan={plan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={vi.fn()}
        onOpenFlow={vi.fn()}
        onOpenModels={onOpenModels}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(
      screen.getByText(/OpenAI image generation does not accept LoRA weights/u),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Manage library" }));
    expect(onOpenModels).toHaveBeenCalledTimes(1);
  });

  it("keeps transparent output enabled and explains the local matte step", () => {
    const transparentSettings: ImageRecipeSettings = {
      ...settings,
      transparentBackground: true,
    };
    const transparentFlow = createImageRecipeFlow({
      id: "flow:transparent-generation",
      createdAt: "2026-07-14T12:00:00.000Z",
      settings: transparentSettings,
    });
    const transparentPlan = compileMediaFlow({
      flow: transparentFlow,
      models: catalog.models,
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    const onChange = vi.fn();

    render(
      <MediaGenerateView
        settings={transparentSettings}
        plan={transparentPlan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={onChange}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(
      (screen.getByRole("checkbox", {
        name: /Transparent background/u,
      }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.getByText(/remove the generated background locally/u)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("routes a durable candidate handoff to Runs before publication", () => {
    const onOpenRunReview = vi.fn();
    const previewReadSpy = vi
      .spyOn(mediaRuntime, "readMediaAssetReferencePreview")
      .mockResolvedValue(new Blob(["preview"], { type: "image/png" }));
    const generatedRun: MediaRunDetail = {
      id: "run:generate-and-choose",
      flowId: "media-image-review-draft",
      flowRevisionId: "revision:generate-and-choose",
      flowName: "Generate & choose",
      planId: "plan:generate-and-choose",
      status: "waiting-for-review",
      createdAt: "2026-07-14T12:02:00.000Z",
      updatedAt: "2026-07-14T12:03:00.000Z",
      prompt: settings.prompt,
      modelLabel: "GPT Image 2",
      target: "remote",
      outputCount: 3,
      diagnosticCount: 1,
      progress: 0.8,
      currentStep: "Waiting for a human decision",
      executor: "openai-image-api",
      error: null,
      failure: null,
      events: [],
      assets: referenceAssets.map((asset) => ({
        ...asset,
        runId: "run:generate-and-choose",
      })),
      providerJobs: [],
      humanReviews: [],
      nodeExecutions: [],
      planSnapshot: null,
    };

    render(
      <MediaGenerateView
        settings={settings}
        plan={plan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={generatedRun}
        persistenceError={null}
        onChange={vi.fn()}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onOpenRunReview={onOpenRunReview}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(screen.getByText("Candidates are ready for your decision")).toBeTruthy();
    expect(screen.getByText(/Nothing is published to the active Library/u)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review 2 candidates" }));
    expect(onOpenRunReview).toHaveBeenCalledTimes(1);
    previewReadSpy.mockRestore();
  });

  it("keeps an empty prompt quiet instead of showing passive help cards", () => {
    const emptyPromptSettings: ImageRecipeSettings = {
      ...settings,
      prompt: "",
    };
    const emptyPromptFlow = createImageRecipeFlow({
      id: "flow:empty-prompt",
      createdAt: "2026-07-14T12:00:00.000Z",
      settings: emptyPromptSettings,
    });
    const emptyPromptPlan = compileMediaFlow({
      flow: emptyPromptFlow,
      models: catalog.models,
      compiledAt: "2026-07-14T12:01:00.000Z",
    });

    render(
      <MediaGenerateView
        settings={emptyPromptSettings}
        plan={emptyPromptPlan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={vi.fn()}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(screen.queryByText(/will receive the prompt/u)).toBeNull();
    expect(screen.queryByText(/Add a concrete subject/u)).toBeNull();
    expect(screen.queryByText(/Describe the image before compiling/u)).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Generate 3 images",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("stops an uncertain paid request at an explicit review state", () => {
    const generatedRun: MediaRunDetail = {
      id: "run:uncertain-openai",
      flowId: flow.id,
      flowRevisionId: "revision:uncertain-openai",
      flowName: flow.name,
      planId: plan.id,
      status: "needs-review",
      createdAt: "2026-07-14T12:02:00.000Z",
      updatedAt: "2026-07-14T12:03:00.000Z",
      prompt: settings.prompt,
      modelLabel: "GPT Image 2",
      target: "remote",
      outputCount: 3,
      diagnosticCount: 0,
      progress: 0.1,
      currentStep: "Provider acceptance requires review",
      executor: "openai-image-api",
      error: "Provider acceptance is unknown.",
      failure: null,
      events: [],
      assets: [],
      providerJobs: [],
      humanReviews: [],
      nodeExecutions: [],
      planSnapshot: null,
    };
    render(
      <MediaGenerateView
        settings={settings}
        plan={plan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={generatedRun}
        persistenceError={null}
        onChange={vi.fn()}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(screen.getByText("Provider decision needs review")).toBeTruthy();
    expect(screen.getByText(/will not be submitted again automatically/u)).toBeTruthy();
  });

  it("lists only text-to-image models that can run now", () => {
    const onChange = vi.fn();
    render(
      <MediaGenerateView
        settings={settings}
        plan={plan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={onChange}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(
      screen.getByRole("option", { name: "GPT Image 2 · OpenAI" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("option", { name: /FLUX\.2 klein 4B/u }),
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("normalizes an installed model without a direct executor", () => {
    const installedCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: true,
      isLocalFluxInstalled: true,
    });
    const fluxSettings: ImageRecipeSettings = {
      ...settings,
      providerPolicy: "local",
      modelId: "local:flux-2-klein-4b",
    };
    const fluxFlow = createImageRecipeFlow({
      id: "flow:generate-flux",
      createdAt: "2026-07-14T12:00:00.000Z",
      settings: fluxSettings,
    });
    const fluxPlan = compileMediaFlow({
      flow: fluxFlow,
      models: installedCatalog.models,
      compiledAt: "2026-07-14T12:01:00.000Z",
    });

    const onChange = vi.fn();
    render(
      <MediaGenerateView
        settings={fluxSettings}
        plan={fluxPlan}
        catalog={installedCatalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={onChange}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(
      screen.queryByRole("option", { name: /FLUX\.2 klein 4B/u }),
    ).toBeNull();
    expect(onChange).toHaveBeenCalledWith({
      ...fluxSettings,
      providerPolicy: "remote",
      modelId: "openai:gpt-image-2",
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Generate 3 images",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("excludes an uninstalled model even when its executor is available", () => {
    const fluxSettings: ImageRecipeSettings = {
      ...settings,
      providerPolicy: "local",
      modelId: "local:flux-2-klein-4b",
    };
    const fluxFlow = createImageRecipeFlow({
      id: "flow:installable-flux",
      createdAt: "2026-07-14T12:00:00.000Z",
      settings: fluxSettings,
    });
    const fluxPlan = compileMediaFlow({
      flow: fluxFlow,
      models: catalog.models,
      compiledAt: "2026-07-14T12:01:00.000Z",
    });

    const onChange = vi.fn();
    render(
      <MediaGenerateView
        settings={fluxSettings}
        plan={fluxPlan}
        catalog={catalog}
        directGenerationModelIds={[
          "openai:gpt-image-2",
          "local:flux-2-klein-4b",
        ]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={onChange}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(
      screen.queryByRole("option", { name: /FLUX\.2 klein 4B/u }),
    ).toBeNull();
    expect(onChange).toHaveBeenCalledWith({
      ...fluxSettings,
      providerPolicy: "remote",
      modelId: "openai:gpt-image-2",
    });
  });

  it("excludes unconfigured remote models", () => {
    const unconfiguredCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
    });
    const unconfiguredPlan = compileMediaFlow({
      flow,
      models: unconfiguredCatalog.models,
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    render(
      <MediaGenerateView
        settings={settings}
        plan={unconfiguredPlan}
        catalog={unconfiguredCatalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={[]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={vi.fn()}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    expect(
      screen.queryByRole("option", { name: /GPT Image 2/u }),
    ).toBeNull();
    expect(
      (screen.getByRole("combobox", {
        name: "Model / provider",
      }) as HTMLSelectElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("option", { name: "No available image models" })).toBeTruthy();
  });

  it("adds, labels, and removes multiple image references without exposing flow setup", async () => {
    const referenceSettings: ImageRecipeSettings = {
      ...settings,
      referenceImages: [
        { assetId: "asset:base", role: "base", influence: 1 },
        { assetId: "asset:style", role: "style", influence: 0.7 },
      ],
    };
    const referenceFlow = createImageEditFlow({
      id: "flow:simple-reference-generation",
      createdAt: "2026-07-14T12:00:00.000Z",
      settings: referenceSettings,
      sourceAssetId: "asset:base",
      referenceAssets: [
        { assetId: "asset:style", role: "style", influence: 0.7 },
      ],
    });
    const referencePlan = compileMediaFlow({
      flow: referenceFlow,
      models: catalog.models,
      compiledAt: "2026-07-14T12:01:00.000Z",
    });
    const onChange = vi.fn();
    const onAddReferenceImages = vi.fn();
    const previewReadSpy = vi
      .spyOn(mediaRuntime, "readMediaAssetReferencePreview")
      .mockResolvedValue(new Blob(["preview"], { type: "image/webp" }));
    const libraryAsset: MediaAssetRecord = {
      ...referenceAssets[1],
      id: "asset:library",
      runId: "run:library",
      digest: "2".repeat(64),
    };
    const renderReferenceView = (assets: readonly MediaAssetRecord[]) => (
      <MediaGenerateView
        settings={referenceSettings}
        plan={referencePlan}
        catalog={catalog}
        directGenerationModelIds={["openai:gpt-image-2"]}
        directReferenceImageModelIds={["openai:gpt-image-2"]}
        referenceAssets={assets}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={onChange}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={onAddReferenceImages}
        generationPending={false}
        runtimeMode="native"
      />
    );

    const availableAssets = [...referenceAssets, libraryAsset];
    const { rerender } = render(renderReferenceView(availableAssets));

    await waitFor(() => expect(previewReadSpy).toHaveBeenCalledTimes(2));
    rerender(renderReferenceView(availableAssets.map((asset) => ({ ...asset }))));
    expect(previewReadSpy).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Add images" }));
    await waitFor(() => expect(previewReadSpy).toHaveBeenCalledTimes(3));
    fireEvent.click(
      screen.getByRole("button", { name: "Add library image 222222222222" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      ...referenceSettings,
      referenceImages: [
        ...referenceSettings.referenceImages,
        { assetId: libraryAsset.id, role: "subject", influence: 1 },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload images" }));
    expect(onAddReferenceImages).toHaveBeenCalledTimes(1);
    onChange.mockClear();
    expect(screen.getByText("Base image")).toBeTruthy();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Reference 2 role" }),
      { target: { value: "palette" } },
    );
    expect(onChange).toHaveBeenCalledWith({
      ...referenceSettings,
      referenceImages: [
        referenceSettings.referenceImages[0],
        { ...referenceSettings.referenceImages[1], role: "palette" },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Remove base reference" }));
    expect(onChange).toHaveBeenCalledWith({
      ...referenceSettings,
      referenceImages: [
        { ...referenceSettings.referenceImages[1], role: "base" },
      ],
    });
    expect(
      screen.getByText(/metadata-stripped copies of these images are sent to OpenAI/u),
    ).toBeTruthy();
  });

  it("presents dedicated one-source SVG vectorization without a prompt", async () => {
    const vectorModel = {
      ...catalog.models[0]!,
      id: "recraft:recraftv4_1_pro_vector",
      providerId: "recraft",
      displayName: "Recraft V4.1 Pro Vector",
      family: "Recraft Vector",
      capabilities: [
        "text-to-svg",
        "image-to-svg",
        "svg-structure-evaluation",
        "render-verified",
      ] as const,
    };
    const vectorCatalog = { ...catalog, models: [vectorModel] };
    const vectorSettings: ImageRecipeSettings = {
      ...settings,
      prompt: "",
      modelId: vectorModel.id,
      outputCount: 1,
      outputFormat: "svg",
      svgMode: "vectorize",
      svgAutoCrop: true,
      svgTargetSize: 1024,
      svgCandidateCount: 1,
      svgCriticEnabled: false,
      referenceImages: [
        { assetId: "asset:base", role: "base", influence: 1 },
      ],
    };
    const vectorFlow = createImageRecipeFlow({
      id: "flow:vectorize",
      createdAt: "2026-07-15T12:00:00.000Z",
      settings: vectorSettings,
    });
    const vectorPlan = compileMediaFlow({
      flow: vectorFlow,
      models: vectorCatalog.models,
      compiledAt: "2026-07-15T12:01:00.000Z",
    });
    const previewReadSpy = vi
      .spyOn(mediaRuntime, "readMediaAssetReferencePreview")
      .mockResolvedValue(new Blob(["preview"], { type: "image/png" }));

    render(
      <MediaGenerateView
        settings={vectorSettings}
        plan={vectorPlan}
        catalog={vectorCatalog}
        directGenerationModelIds={[vectorModel.id]}
        directReferenceImageModelIds={[vectorModel.id]}
        referenceAssets={[referenceAssets[0]!]}
        referenceImportSupported
        referenceImportPending={false}
        generatedRun={null}
        persistenceError={null}
        onChange={vi.fn()}
        onOpenFlow={vi.fn()}
        onOpenModels={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onGenerate={vi.fn()}
        onAddReferenceImages={vi.fn()}
        generationPending={false}
        runtimeMode="native"
      />,
    );

    await waitFor(() => expect(previewReadSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Remove base reference" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Describe your image" })).toBeNull();
    const vectorizeButtons = screen.getAllByRole("button", { name: "Vectorize image" });
    expect((vectorizeButtons.at(-1) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByText("1 verified SVG")).toBeTruthy();
    expect(screen.getByText(/Recraft analyzes the prepared source/u)).toBeTruthy();
  });
});
