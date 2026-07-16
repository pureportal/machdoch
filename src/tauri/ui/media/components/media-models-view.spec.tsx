import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import type {
  MediaCivitaiModelAddonInspection,
  MediaLocalDiffusersRuntimeStatus,
  MediaLocalModelImportInspection,
  MediaModelAddonImportInspection,
  MediaModelAddonRemovalPlan,
} from "../../../../core/media/contracts.js";
import { MediaModelsView } from "./media-models-view";

const catalog = createMediaModelCatalogSnapshot({ isOpenAiConfigured: true });

const inspection: MediaLocalModelImportInspection = {
  schemaVersion: 1,
  canImport: true,
  blockingReason: null,
  sourcePath: "C:\\Models\\community-xl.safetensors",
  sourceFileName: "community-xl.safetensors",
  byteSize: 6_442_450_944,
  tensorCount: 1_684,
  headerDigest: "a".repeat(64),
  reviewToken: "b".repeat(64),
  suggestedDisplayName: "Community XL",
  detectedArchitecture: "stable-diffusion-xl",
  architectureConfidence: "high",
  metadataSummary: [
    "modelspec.architecture: stable-diffusion-xl-v1-base",
  ],
  warnings: ["No model code was executed."],
};

const addonInspection: MediaModelAddonImportInspection = {
  schemaVersion: 1,
  canImport: true,
  blockingReason: null,
  sourcePath: "C:\\Models\\civitai\\addon.safetensors",
  sourceFileName: "addon.safetensors",
  byteSize: 2_097_152,
  tensorCount: 96,
  headerDigest: "c".repeat(64),
  reviewToken: "d".repeat(64),
  suggestedDisplayName: "Addon",
  detectedKind: "lora",
  detectedArchitecture: null,
  architectureConfidence: "unknown",
  targetComponents: ["denoiser"],
  embeddingVectors: [],
  loraProfile: {
    algorithm: "locon",
    dialect: "kohya",
    rankMinimum: 8,
    rankMaximum: 16,
    heterogeneousRanks: true,
    targetModuleCount: 12,
    convolutionTargetCount: 4,
    magnitudeVectorCount: 0,
    networkAlphaCount: 0,
  },
  baseModelHint: null,
  suggestedTriggerWords: [],
  suggestedToken: null,
  metadataSummary: [],
  warnings: ["No model code was executed."],
};

const civitaiInspection: MediaCivitaiModelAddonInspection = {
  schemaVersion: 1,
  canDownload: true,
  blockingReason: null,
  reviewToken: "e".repeat(64),
  observedAt: "2026-07-15T00:00:00Z",
  sourceUrl: "https://civitai.com/models/122359?modelVersionId=135867",
  air: "urn:air:sdxl:lora:civitai:122359@135867",
  modelId: 122_359,
  versionId: 135_867,
  modelName: "Detail Tweaker XL",
  versionName: "Detail Tweaker XL",
  kind: "lora",
  baseModel: "SDXL 1.0",
  suggestedArchitecture: "stable-diffusion-xl",
  trainedWords: ["add_detail"],
  creator: "publisher",
  nsfw: false,
  poi: false,
  availability: "Public",
  status: "Published",
  file: {
    id: 135_867,
    name: "add-detail-xl.safetensors",
    byteSize: 228_452_344,
    sha256: "f".repeat(64),
    pickleScanResult: "Success",
    virusScanResult: "Success",
    scannedAt: "2026-07-15T00:00:00Z",
  },
  licenseClaims: {
    allowNoCredit: false,
    allowCommercialUse: ["Image"],
    allowDerivatives: true,
    allowDifferentLicense: false,
  },
  warnings: ["External claims are verified again."],
};

const addonRemovalPlan: MediaModelAddonRemovalPlan = {
  schemaVersion: 1,
  addonId: "local-addon:sha256:" + "a".repeat(64),
  displayName: "Detail Tweaker XL",
  kind: "lora",
  digest: "a".repeat(64),
  installedBytes: 228_452_344,
  targetLabel: "models/addons/sha256/" + "a".repeat(64),
  confirmationToken: "b".repeat(64),
  canRemove: true,
  blockingRunCount: 0,
  blockingRunIds: [],
  savedFlowCount: 2,
  savedFlowIds: ["flow-1", "flow-2"],
  historicalRunCount: 4,
  warnings: ["Saved flows will require this exact digest."],
};

const renderModelsView = (
  modelImportInspection: MediaLocalModelImportInspection | null,
  onChooseModelImport = vi.fn(),
  onImportModel = vi.fn(),
  onChooseAddonImport = vi.fn(),
  options: {
    catalog?: ReturnType<typeof createMediaModelCatalogSnapshot>;
    localDiffusers?: MediaLocalDiffusersRuntimeStatus | null;
    onProbeModel?: (modelId: string) => void;
    onInspectCivitaiAddon?: (source: string) => void;
    onDownloadCivitaiAddon?: (request: {
      source: string;
      reviewToken: string;
    }) => void;
    addonImportInspection?: MediaModelAddonImportInspection | null;
    addonImportCivitaiSource?: MediaCivitaiModelAddonInspection | null;
    civitaiAddonInspection?: MediaCivitaiModelAddonInspection | null;
    addonRemovalPlan?: MediaModelAddonRemovalPlan | null;
    onConfirmAddonRemoval?: (request: {
      addonId: string;
      confirmationToken: string;
      confirmRemoval: boolean;
    }) => void;
  } = {},
) =>
  render(
    <MediaModelsView
      catalog={options.catalog ?? catalog}
      catalogLoading={false}
      catalogError={null}
      hardware={null}
      hardwareLoading={false}
      hardwareError={null}
      installPlan={null}
      installJob={null}
      installLoading={false}
      installError={null}
      removalPlan={null}
      removalResult={null}
      removalLoading={false}
      removalError={null}
      modelImportInspection={modelImportInspection}
      modelImportResult={null}
      modelImportSupported
      modelImportLoading={false}
      modelImportError={null}
      modelProbeSupported
      modelProbeLoadingId={null}
      modelProbeError={null}
      addonImportInspection={options.addonImportInspection ?? null}
      addonImportResult={null}
      addonImportSupported
      addonImportLoading={false}
      addonImportError={null}
      civitaiAddonInspection={options.civitaiAddonInspection ?? null}
      addonImportCivitaiSource={options.addonImportCivitaiSource ?? null}
      civitaiAddonLoading={false}
      civitaiAddonError={null}
      addonRemovalPlan={options.addonRemovalPlan ?? null}
      addonRemovalResult={null}
      addonRemovalLoading={false}
      addonRemovalError={null}
      localDiffusers={options.localDiffusers ?? null}
      onRefreshHardware={vi.fn()}
      onRefreshCatalog={vi.fn()}
      onReviewInstall={vi.fn()}
      onStartInstall={vi.fn()}
      onCancelInstall={vi.fn()}
      onDismissInstall={vi.fn()}
      onReviewRemoval={vi.fn()}
      onConfirmRemoval={vi.fn()}
      onDismissRemoval={vi.fn()}
      onChooseModelImport={onChooseModelImport}
      onImportModel={onImportModel}
      onDismissModelImport={vi.fn()}
      onProbeModel={options.onProbeModel ?? vi.fn()}
      onChooseAddonImport={onChooseAddonImport}
      onInspectCivitaiAddon={options.onInspectCivitaiAddon ?? vi.fn()}
      onDownloadCivitaiAddon={options.onDownloadCivitaiAddon ?? vi.fn()}
      onDismissCivitaiAddon={vi.fn()}
      onReviewAddonRemoval={vi.fn()}
      onConfirmAddonRemoval={options.onConfirmAddonRemoval ?? vi.fn()}
      onDismissAddonRemoval={vi.fn()}
      onImportAddon={vi.fn()}
      onDismissAddonImport={vi.fn()}
      onOpenProviderSettings={vi.fn()}
    />,
  );

describe("MediaModelsView local checkpoint import", () => {
  it("moves missing Local Diffusers requirements into highlighted system details", () => {
    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      localDiffusers: {
        status: "unavailable",
        ready: false,
        workerVersion: "media-diffusers-worker/1.3.0",
        pythonVersion: "3.12.0",
        packages: {
          torch: null,
          diffusers: null,
          pillow: "12.1.1",
        },
        device: null,
        deviceLabel: null,
        deviceMemoryBytes: null,
        architectures: ["flux-2"],
        capabilities: ["lora"],
        diagnostic:
          "Pinned Python runtime is not ready: missing torch, diffusers; version mismatch pillow=12.1.1 (expected 12.3.0)",
      },
    });

    expect(screen.queryByText("Local Diffusers not ready")).toBeNull();
    const summary = screen.getByText("System details").closest("summary");
    if (!summary) throw new Error("Expected the System details summary.");
    expect(summary.textContent).toContain("Action required");

    fireEvent.click(summary);
    expect(
      screen.getByRole("heading", { name: "Local Diffusers requirements" }),
    ).toBeTruthy();
    expect(screen.getByText("Required 2.13.0")).toBeTruthy();
    expect(screen.getByText("Installed 12.1.1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Install guide" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "Install Local Diffusers requirements",
      }),
    ).toBeTruthy();
    expect(
      within(dialog)
        .getByRole("link", { name: /official Python downloads/u })
        .getAttribute("href"),
    ).toBe("https://www.python.org/downloads/");
    expect(
      within(dialog)
        .getByRole("link", { name: /PyTorch install options/u })
        .getAttribute("href"),
    ).toBe(
      "https://pytorch.org/get-started/previous-versions/",
    );
  });

  it("groups models by purpose instead of execution target", () => {
    const purposeCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: true,
    });
    const rasterModel = purposeCatalog.models.find(
      (model) => model.id === "openai:gpt-image-2",
    );
    if (!rasterModel) throw new Error("Expected the GPT Image catalog fixture.");

    purposeCatalog.models = [
      ...purposeCatalog.models,
      {
        ...rasterModel,
        id: "quiver:arrow-test",
        providerId: "quiver",
        displayName: "Arrow Test",
        family: "Quiver Arrow",
        capabilities: ["text-to-svg", "image-to-svg"],
      },
    ];

    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      catalog: purposeCatalog,
    });

    const imageGeneration = screen.getByRole("region", {
      name: "Image generation",
    });
    expect(within(imageGeneration).getByText("GPT Image 2")).toBeTruthy();
    expect(within(imageGeneration).getByText("FLUX.2 klein 4B")).toBeTruthy();
    expect(
      within(
        screen.getByRole("region", { name: "Vector graphics" }),
      ).getByText("Arrow Test"),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Background removal" }),
    ).toBeTruthy();
    expect(screen.getByRole("region", { name: "Image analysis" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Remote models" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Local models" })).toBeNull();
  });

  it("requires an installed local checkpoint to pass runtime verification", () => {
    const onProbeModel = vi.fn();
    const installedCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: true,
      isLocalFluxInstalled: true,
    });
    installedCatalog.models = installedCatalog.models.map((model) =>
      model.providerId === "local-diffusers"
        ? {
            ...model,
            runtimeReadiness: "unverified" as const,
            runtimeReadinessDiagnostic: "Run Verify model once.",
          }
        : model,
    );

    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      catalog: installedCatalog,
      localDiffusers: {
        status: "ready",
        ready: true,
        workerVersion: "test-worker",
        pythonVersion: "3.12",
        packages: {},
        device: "cpu",
        deviceLabel: "CPU",
        deviceMemoryBytes: null,
        architectures: ["flux-2"],
        capabilities: ["lora", "multi-lora"],
        diagnostic: "Ready for clean-load verification.",
      },
      onProbeModel,
    });

    expect(screen.getByText("Needs verification")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Verify model" }));
    expect(onProbeModel).toHaveBeenCalledWith("local:flux-2-klein-4b");
  });

  it("opens the native LoRA and embedding picker from Models", () => {
    const onChooseAddonImport = vi.fn();
    renderModelsView(null, vi.fn(), vi.fn(), onChooseAddonImport);

    fireEvent.click(
      screen.getByRole("button", { name: "Import LoRA / embedding" }),
    );
    expect(onChooseAddonImport).toHaveBeenCalledTimes(1);
  });

  it("reviews a pasted Civitai URL before downloading model bytes", () => {
    const onInspectCivitaiAddon = vi.fn();
    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      onInspectCivitaiAddon,
    });

    fireEvent.click(screen.getByRole("button", { name: "Import from Civitai" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Civitai URL or AIR" }), {
      target: {
        value:
          "https://civitai.com/models/122359/detail?modelVersionId=135867",
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review Civitai add-on" }),
    );

    expect(onInspectCivitaiAddon).toHaveBeenCalledWith(
      "https://civitai.com/models/122359/detail?modelVersionId=135867",
    );
  });

  it("freezes the reviewed Civitai version before requesting a download", () => {
    const onDownloadCivitaiAddon = vi.fn();
    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      civitaiAddonInspection: civitaiInspection,
      onDownloadCivitaiAddon,
    });

    fireEvent.click(screen.getByRole("button", { name: "Import from Civitai" }));
    expect(screen.getByText("add-detail-xl.safetensors", { exact: false })).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Download and inspect safetensors" }),
    );

    expect(onDownloadCivitaiAddon).toHaveBeenCalledWith({
      source: civitaiInspection.sourceUrl,
      reviewToken: civitaiInspection.reviewToken,
    });
  });

  it("prefills the power-user review from Civitai without skipping rights confirmation", () => {
    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      addonImportInspection: addonInspection,
      addonImportCivitaiSource: civitaiInspection,
    });

    expect(
      (screen.getByRole("textbox", { name: "Display name" }) as HTMLInputElement)
        .value,
    ).toBe("Detail Tweaker XL");
    expect(
      (screen.getByRole("combobox", {
        name: "Base architecture",
      }) as HTMLSelectElement).value,
    ).toBe("stable-diffusion-xl");
    expect(
      (screen.getByRole("textbox", {
        name: /Trigger words/u,
      }) as HTMLInputElement).value,
    ).toBe("add_detail");
    expect(
      (screen.getByRole("textbox", { name: /Publisher page/u }) as HTMLInputElement)
        .value,
    ).toBe(civitaiInspection.sourceUrl);
    expect(
      (
        screen.getByRole("button", {
          name: "Copy and verify add-on",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("shows the inspected multi-vector layout before importing an embedding", () => {
    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      addonImportInspection: {
        ...addonInspection,
        detectedKind: "textual-inversion",
        detectedArchitecture: "stable-diffusion-xl",
        targetComponents: ["text-encoder", "text-encoder-2"],
        embeddingVectors: [
          {
            component: "text-encoder",
            tensorKey: "clip_l",
            vectorCount: 4,
            dimension: 768,
          },
          {
            component: "text-encoder-2",
            tensorKey: "clip_g",
            vectorCount: 4,
            dimension: 1_280,
          },
        ],
        loraProfile: null,
        suggestedToken: "<concept>",
      },
    });

    expect(screen.getByText("Verified embedding layout")).toBeTruthy();
    expect(screen.getByText("text encoder · 4 vectors × 768")).toBeTruthy();
    expect(screen.getByText("text encoder 2 · 4 vectors × 1280")).toBeTruthy();
  });

  it("shows the inspected LoCon dialect, rank range, and advanced tensors", () => {
    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      addonImportInspection: addonInspection,
    });

    expect(screen.getByText("Verified LoRA tensor profile")).toBeTruthy();
    expect(screen.getByText("LoCon · kohya")).toBeTruthy();
    expect(screen.getByText("8–16 · 12 modules")).toBeTruthy();
    expect(screen.getByText("4 convolution · 0 magnitude · 0 alpha")).toBeTruthy();
  });

  it("requires reviewed dependency impact confirmation before removing an add-on", () => {
    const onConfirmAddonRemoval = vi.fn();
    renderModelsView(null, vi.fn(), vi.fn(), vi.fn(), {
      addonRemovalPlan,
      onConfirmAddonRemoval,
    });

    expect(within(screen.getByRole("dialog")).getByText("2")).toBeTruthy();
    const remove = screen.getByRole("button", {
      name: "Remove add-on",
    }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /saved flows keep this exact add-on reference/u,
      }),
    );
    expect(remove.disabled).toBe(false);
    fireEvent.click(remove);
    expect(onConfirmAddonRemoval).toHaveBeenCalledWith({
      addonId: addonRemovalPlan.addonId,
      confirmationToken: addonRemovalPlan.confirmationToken,
      confirmRemoval: true,
    });
  });

  it("opens the native checkpoint picker from Models", () => {
    const onChooseModelImport = vi.fn();
    renderModelsView(null, onChooseModelImport);

    fireEvent.click(screen.getByRole("button", { name: "Import checkpoint" }));
    expect(onChooseModelImport).toHaveBeenCalledTimes(1);
  });

  it("requires license review and submits confirmed architecture metadata", () => {
    const onImportModel = vi.fn();
    renderModelsView(inspection, vi.fn(), onImportModel);

    expect(
      (screen.getByRole("combobox", {
        name: "Base architecture",
      }) as HTMLSelectElement).value,
    ).toBe("stable-diffusion-xl");
    const submit = screen.getByRole("button", {
      name: "Copy and verify checkpoint",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /I reviewed the publisher's license/u,
      }),
    );
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(onImportModel).toHaveBeenCalledWith({
      sourcePath: inspection.sourcePath,
      reviewToken: inspection.reviewToken,
      displayName: "Community XL",
      architecture: "stable-diffusion-xl",
      sourceUrl: null,
      licenseName: "Custom / community model terms",
      commercialUse: "review-required",
      confirmRights: true,
    });
  });
});
