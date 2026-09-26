// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../../core/media/catalog.js";
import type {
  MediaAssetDeletionImpact,
  MediaAssetRecord,
  MediaModelAddonDescriptor,
} from "../../../../core/media/contracts.js";
import { MediaAssetsView } from "./media-assets-view";
import { EMPTY_MEDIA_RUNTIME_SETUP } from "../media-runtime-setup";

vi.mock("./media-visual-preview", () => ({
  MediaAssetPreview: () => null,
  MediaResourcePreview: () => null,
}));

vi.mock("./media-asset-import-dialog", () => ({
  MediaAssetImportDialog: () => null,
}));

vi.mock("./media-asset-metadata-editor", () => ({
  MediaAssetMetadataEditor: () => null,
}));

vi.mock("./media-category-manager-dialog", () => ({
  MediaCategoryManagerDialog: () => null,
}));

vi.mock("./media-category-picker", () => ({
  MediaCategoryPicker: () => null,
}));

const asset: MediaAssetRecord = {
  id: "asset:portrait",
  runId: "run:import",
  digest: "d".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 4_096,
  width: 1_024,
  height: 1_024,
  createdAt: "2026-08-20T10:00:00.000Z",
  outputIndex: 0,
  fixture: false,
  operation: { kind: "local-import" },
  sourceAssetIds: [],
  tags: [],
};

const deletionImpact: MediaAssetDeletionImpact = {
  assetId: asset.id,
  digest: asset.digest,
  dependentAssetIds: ["asset:derived"],
  sharedBlobAssetIds: [],
  exportCount: 0,
  activeExportCount: 0,
  renditionCount: 0,
  originalByteSize: asset.byteSize,
  renditionByteSize: 0,
  reclaimableByteSize: asset.byteSize,
  retainedSharedByteSize: 0,
  warnings: [],
  confirmationToken: "confirm:portrait",
};

type Props = ComponentProps<typeof MediaAssetsView>;

const createProps = (overrides: Partial<Props> = {}): Props => ({
  discoveredFiles: [],
  assets: [asset],
  catalog: createMediaModelCatalogSnapshot({
    isOpenAiConfigured: false,
    isLocalFluxInstalled: false,
  }),
  categories: [],
  metadata: {},
  selectedModelId: null,
  importSupported: true,
  importLoading: false,
  importProgress: null,
  modelImportInspection: null,
  addonImportInspection: null,
  civitaiInspection: null,
  importError: null,
  persistenceError: null,
  onInspectModel: vi.fn(),
  onInspectAddon: vi.fn(),
  onInspectCivitai: vi.fn(),
  onImportMedia: vi.fn(async () => null),
  onImportModel: vi.fn(async () => false),
  onImportAddon: vi.fn(async () => false),
  onImportSampleUrl: vi.fn(async () => null),
  onRetryPersistence: vi.fn(),
  onDismissImport: vi.fn(),
  onUseModel: vi.fn(),
  onSetupRuntime: vi.fn(),
  onVerifyModel: vi.fn(),
  onRefreshModels: vi.fn(async () => undefined),
  onScanModels: vi.fn(),
  runtimeSetup: EMPTY_MEDIA_RUNTIME_SETUP,
  runtimeReady: false,
  verifyingModelId: null,
  onUseAddon: vi.fn(),
  onUseAsReference: vi.fn(),
  onUseAsPose: vi.fn(),
  onEditImage: vi.fn(),
  onAnimateImage: vi.fn(),
  onOpenVideoAsFlow: vi.fn(),
  onInspectSettings: vi.fn(),
  onReuseSettings: vi.fn(),
  onPlanAssetDeletion: vi.fn(async () => deletionImpact),
  onDeleteAsset: vi.fn(async () => undefined),
  onUpdateTags: vi.fn(),
  onSaveResource: vi.fn(async () => undefined),
  onUpdateMetadata: vi.fn(),
  onCategoryStateChange: vi.fn(),
  tagLoadingAssetId: null,
  ...overrides,
});

describe("MediaAssetsView discovery", () => {
  it("filters OpenPose assets and opens one as the pose map", () => {
    const pose = {
      ...asset,
      id: "asset:pose",
      tags: [{ value: "openpose", label: "OpenPose", source: "technical" as const, confidence: 1, createdAt: asset.createdAt }],
    };
    const onUseAsPose = vi.fn();
    render(createElement(MediaAssetsView, createProps({ assets: [asset, pose], onUseAsPose })));
    fireEvent.click(screen.getByRole("button", { name: "OpenPose" }));
    expect(screen.getAllByRole("button", { name: /^View / })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Use as pose" }));
    expect(onUseAsPose).toHaveBeenCalledWith(pose);
  });
  const catalog = createMediaModelCatalogSnapshot({
    isOpenAiConfigured: true,
    isLocalFluxInstalled: true,
  });
  const localModel = catalog.models.find(
    (model) => model.id === "local:flux-2-klein-4b",
  )!;
  const remoteModel = catalog.models.find(
    (model) => model.id === "openai:gpt-image-2.5-sunburst",
  )!;
  const media: MediaAssetRecord[] = [
    {
      ...asset,
      id: "added:old",
      operation: { kind: "local-import" as const, sourceFileName: "Apple.png" },
      createdAt: "2026-09-01T12:00:00",
      byteSize: 100,
    },
    {
      ...asset,
      id: "generated:old",
      operation: {
        kind: "workflow" as const,
        sourceNodeId: "image",
        iteration: 0,
        details: {},
      },
      createdAt: "2026-09-01T12:00:00",
      outputIndex: 0,
    },
    {
      ...asset,
      id: "added:new",
      operation: { kind: "local-import" as const, sourceFileName: "Zebra.jpg" },
      createdAt: "2026-09-19T12:00:00",
      width: 1920,
      height: 1080,
      mimeType: "image/jpeg",
      byteSize: 200,
    },
    {
      ...asset,
      id: "generated:new",
      operation: {
        kind: "workflow" as const,
        sourceNodeId: "image",
        iteration: 0,
        details: {},
      },
      createdAt: "2026-09-19T12:00:00",
      outputIndex: 1,
    },
  ];
  const visibleNames = () =>
    screen
      .getAllByRole("button", { name: /^View / })
      .map((button) => button.getAttribute("aria-label"));
  const change = (label: string, value: string) =>
    fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it("uses name order for models and newest order within separate media groups", () => {
    render(
      createElement(
        MediaAssetsView,
        createProps({
          assets: media,
          catalog: {
            ...catalog,
            models: [
              { ...localModel, id: "z", displayName: "Zebra model" },
              { ...localModel, id: "a", displayName: "Alpha model" },
            ],
          },
        }),
      ),
    );
    expect(visibleNames()).toEqual([
      "View Alpha model",
      "View Zebra model",
      "View Image 2",
      "View Image 1",
      "View Zebra.jpg",
      "View Apple.png",
    ]);
    expect(screen.getByRole("heading", { name: "Generations" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "Uploads and imports" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Images" }));
    expect(visibleNames()).toEqual([
      "View Image 2",
      "View Image 1",
      "View Zebra.jpg",
      "View Apple.png",
    ]);
    change("Sort assets", "oldest");
    expect(visibleNames()).toEqual([
      "View Image 1",
      "View Image 2",
      "View Apple.png",
      "View Zebra.jpg",
    ]);
    change("Sort assets", "name");
    expect(visibleNames()).toEqual([
      "View Image 1",
      "View Image 2",
      "View Apple.png",
      "View Zebra.jpg",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    expect(visibleNames()).toEqual(["View Alpha model", "View Zebra model"]);
    change("Sort assets", "name-desc");
    expect(visibleNames()).toEqual(["View Zebra model", "View Alpha model"]);
  });

  it("combines media filters and clears them without leaving hidden model results", () => {
    render(
      createElement(
        MediaAssetsView,
        createProps({
          assets: media,
          catalog: { ...catalog, models: [localModel] },
        }),
      ),
    );
    fireEvent.click(screen.getByText("Filters", { selector: "summary" }));
    change("Media source", "added");
    change("Media orientation", "landscape");
    change("Media format", "image/jpeg");
    change("Media date from", "2026-09-19");
    change("Media date to", "2026-09-19");
    expect(visibleNames()).toEqual(["View Zebra.jpg"]);
    expect(screen.queryByRole("heading", { name: "Generations" })).toBeNull();
    change("Media orientation", "portrait");
    expect(screen.getByText("No matching assets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(visibleNames()).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it.each([
    ["Videos", "video", "video/webm"],
    ["SVGs", "vector", "image/svg+xml"],
  ] as const)(
    "sorts %s by add date and resets media filters when changing types",
    (label, kind, mimeType) => {
      const assets: MediaAssetRecord[] = [
        {
          ...asset,
          id: "old",
          kind,
          mimeType,
          createdAt: "2026-09-01T12:00:00",
          operation: { kind: "local-import", sourceFileName: "Alpha" },
        },
        {
          ...asset,
          id: "new",
          kind,
          mimeType,
          createdAt: "2026-09-19T12:00:00",
          operation: { kind: "local-import", sourceFileName: "Zebra" },
        },
      ];
      render(createElement(MediaAssetsView, createProps({ assets })));
      fireEvent.click(screen.getByText("Filters", { selector: "summary" }));
      change("Media source", "generated");
      expect(screen.getByText("No matching assets")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(visibleNames()).toEqual(["View Zebra", "View Alpha"]);
      change("Sort assets", "oldest");
      expect(visibleNames()).toEqual(["View Alpha", "View Zebra"]);
    },
  );

  it("filters models by location and readiness and excludes removed catalog entries", () => {
    render(
      createElement(
        MediaAssetsView,
        createProps({
          assets: [],
          catalog: {
            ...catalog,
            models: [
              localModel,
              remoteModel,
              {
                ...remoteModel,
                id: "removed",
                displayName: "GPT Image 2",
                lifecycle: "removed",
              },
              {
                ...localModel,
                id: "unverified",
                displayName: "Unverified import",
                userImported: true,
                runtimeReadiness: "unverified",
              },
            ],
          },
        }),
      ),
    );
    expect(screen.queryByText("GPT Image 2")).toBeNull();
    expect(screen.queryByText("Choose an active compatible model.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Models" }));
    fireEvent.click(screen.getByText("Filters", { selector: "summary" }));
    change("Model location", "local");
    change("Model readiness", "needs-attention");
    expect(visibleNames()).toEqual(["View Unverified import"]);
    change("Model readiness", "ready");
    expect(visibleNames()).toEqual([`View ${localModel.displayName}`]);
    change("Model location", "remote");
    expect(visibleNames()).toEqual([`View ${remoteModel.displayName}`]);
  });

  it("defaults LoRAs and embeddings to names and offers import-date and file-size sorting", () => {
    const addon: MediaModelAddonDescriptor = {
      id: "lora:z",
      kind: "lora",
      displayName: "Zebra",
      architecture: "flux-2",
      architectureConfidence: "high",
      format: "safetensors",
      targetComponents: ["denoiser"],
      embeddingVectors: [],
      loraProfile: null,
      baseModelHint: null,
      triggerWords: [],
      defaultToken: null,
      digest: "a".repeat(64),
      headerDigest: "b".repeat(64),
      byteSize: 200,
      relativePath: "zebra.safetensors",
      sourceUrl: null,
      license: localModel.license,
      importedAt: "2026-09-19T12:00:00Z",
    };
    render(
      createElement(
        MediaAssetsView,
        createProps({
          assets: [],
          catalog: {
            ...catalog,
            models: [],
            addons: [
              addon,
              {
                ...addon,
                id: "lora:a",
                displayName: "Alpha",
                byteSize: 100,
                importedAt: "2026-09-01T12:00:00Z",
              },
              {
                ...addon,
                id: "embedding:z",
                kind: "textual-inversion",
                displayName: "Zebra embedding",
              },
              {
                ...addon,
                id: "embedding:a",
                kind: "textual-inversion",
                displayName: "Alpha embedding",
              },
            ],
          },
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "LoRAs" }));
    expect(visibleNames()).toEqual(["View Alpha", "View Zebra"]);
    change("Sort assets", "newest");
    expect(visibleNames()).toEqual(["View Zebra", "View Alpha"]);
    change("Sort assets", "smallest");
    expect(visibleNames()).toEqual(["View Alpha", "View Zebra"]);
    fireEvent.click(screen.getByRole("button", { name: "Embeddings" }));
    expect(visibleNames()).toEqual([
      "View Alpha embedding",
      "View Zebra embedding",
    ]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("MediaAssetsView asset actions", () => {
  it("opens a full model edit dialog from the context menu and persists edits", async () => {
    const catalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    });
    const model = {
      ...catalog.models.find((entry) => entry.id === "local:flux-2-klein-4b")!,
      id: "local:user:edit",
      displayName: "Editable checkpoint",
      userImported: true,
    };
    const props = createProps({ catalog: { ...catalog, models: [model] } });
    render(createElement(MediaAssetsView, props));
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "View Editable checkpoint" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit model" });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Updated checkpoint" },
    });
    fireEvent.change(within(dialog).getByLabelText("Model type"), {
      target: { value: "stable-diffusion-xl" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(props.onSaveResource).toHaveBeenCalledWith(
        model.id,
        expect.objectContaining({
          displayName: "Updated checkpoint",
          architecture: "stable-diffusion-xl",
        }),
        expect.any(Object),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Edit model" })).toBeNull(),
    );
  });

  it("opens asset inspection as a dialog with edit, reference, animation, and save actions", () => {
    const props = createProps();
    render(createElement(MediaAssetsView, props));
    fireEvent.click(screen.getByRole("button", { name: "View Image 1" }));
    const dialog = screen.getByRole("dialog", { name: "Image 1" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit image" }));
    expect(props.onEditImage).toHaveBeenCalledWith(asset);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Use as reference" }),
    );
    expect(props.onUseAsReference).toHaveBeenCalledWith(asset);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Animate image" }),
    );
    expect(props.onAnimateImage).toHaveBeenCalledWith(asset);
    expect(
      within(dialog).getByRole("button", { name: "Save image" }),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("plans destructive deletion and confirms its dependency impact", async () => {
    const onPlanAssetDeletion = vi.fn(async () => deletionImpact);
    const onDeleteAsset = vi.fn(async () => undefined);
    render(
      createElement(
        MediaAssetsView,
        createProps({ onPlanAssetDeletion, onDeleteAsset }),
      ),
    );

    const assetCard = screen
      .getByRole("button", { name: "View Image 1" })
      .closest("article");
    expect(assetCard).not.toBeNull();
    fireEvent.contextMenu(assetCard!);
    fireEvent.click(await screen.findByText("Delete asset"));

    await waitFor(() =>
      expect(onPlanAssetDeletion).toHaveBeenCalledWith(asset.id),
    );
    expect(
      await screen.findByText(
        "This removes the asset from Media Studio. 1 dependent asset will show a missing source.",
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Delete asset" }));
    await waitFor(() =>
      expect(onDeleteAsset).toHaveBeenCalledWith(deletionImpact),
    );
  });

  it("keeps imported models visible while limiting use to ready models", () => {
    const baseCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: true,
      isLocalFluxInstalled: true,
    });
    const providerReady = baseCatalog.models.find(
      (model) => model.id === "openai:gpt-image-2.5-sunburst",
    )!;
    const localModel = baseCatalog.models.find(
      (model) => model.id === "local:flux-2-klein-4b",
    )!;
    const importedReady = {
      ...localModel,
      id: "user:imported-ready",
      displayName: "Imported Ready",
      userImported: true,
      management: {
        acquisition: "file-import" as const,
        verification: "model-probe" as const,
      },
      runtimeReadiness: "ready" as const,
    };
    const providerUnavailable = {
      ...providerReady,
      id: "remote:provider-unavailable",
      displayName: "Provider Unavailable",
      configured: false,
    };
    const runtimeUnavailable = {
      ...importedReady,
      id: "user:runtime-unavailable",
      displayName: "Runtime Unavailable",
      runtimeReadiness: "runtime-unavailable" as const,
      runtimeReadinessDiagnostic: "The required runtime is unavailable.",
    };
    const unverified = {
      ...importedReady,
      id: "user:unverified",
      displayName: "Imported Unverified",
      runtimeReadiness: "unverified" as const,
    };
    const catalog = {
      ...baseCatalog,
      models: [
        providerReady,
        importedReady,
        providerUnavailable,
        runtimeUnavailable,
        unverified,
      ],
    };
    const onUseModel = vi.fn();
    const onSetupRuntime = vi.fn();
    const onVerifyModel = vi.fn();

    render(
      createElement(
        MediaAssetsView,
        createProps({
          assets: [],
          catalog,
          onUseModel,
          onSetupRuntime,
          onVerifyModel,
        }),
      ),
    );

    expect(screen.getByText(providerReady.displayName)).toBeTruthy();
    expect(screen.getByText(importedReady.displayName)).toBeTruthy();
    expect(screen.queryByText(providerUnavailable.displayName)).toBeNull();
    expect(screen.getByText(runtimeUnavailable.displayName)).toBeTruthy();
    expect(screen.getByText(unverified.displayName)).toBeTruthy();
    expect(
      screen.queryByText(
        "Configure its provider in Settings, then refresh model readiness.",
      ),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Start or repair the required runtime, then probe again.",
      ),
    ).toBeNull();

    const providerCard = screen
      .getByRole("button", { name: `View ${providerReady.displayName}` })
      .closest("article");
    expect(providerCard).not.toBeNull();
    fireEvent.click(
      within(providerCard!).getByRole("button", { name: "Use model" }),
    );
    expect(onUseModel).toHaveBeenCalledWith(providerReady);

    const importedCard = screen
      .getByRole("button", { name: `View ${importedReady.displayName}` })
      .closest("article");
    expect(importedCard).not.toBeNull();
    fireEvent.click(
      within(importedCard!).getByRole("button", { name: "Use model" }),
    );
    expect(onUseModel).toHaveBeenLastCalledWith(importedReady);

    const unavailableCard = screen
      .getByRole("button", { name: `View ${runtimeUnavailable.displayName}` })
      .closest("article");
    expect(unavailableCard).not.toBeNull();
    expect(
      within(unavailableCard!).queryByRole("button", { name: "Use model" }),
    ).toBeNull();
    fireEvent.click(
      within(unavailableCard!).getByRole("button", {
        name: "Set up Media Studio",
      }),
    );
    expect(onSetupRuntime).toHaveBeenCalledOnce();

    const unverifiedCard = screen
      .getByRole("button", { name: `View ${unverified.displayName}` })
      .closest("article");
    expect(unverifiedCard).not.toBeNull();
    fireEvent.click(
      within(unverifiedCard!).getByRole("button", { name: "Verify model" }),
    );
    expect(onVerifyModel).toHaveBeenCalledWith(unverified);
  });

  it("opens a newly imported resource after the catalog refreshes", async () => {
    const baseCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    });
    const importedModel = {
      ...baseCatalog.models.find(
        (model) => model.id === "local:flux-2-klein-4b",
      )!,
      id: "local:user:imported",
      displayName: "Imported Model",
      userImported: true,
    };
    const onOpenResourceHandled = vi.fn();

    render(
      createElement(
        MediaAssetsView,
        createProps({
          assets: [],
          catalog: { ...baseCatalog, models: [importedModel] },
          openResourceId: importedModel.id,
          onOpenResourceHandled,
        }),
      ),
    );

    await waitFor(() => expect(onOpenResourceHandled).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("button", { name: "Close asset details" }),
    ).toBeTruthy();
    expect(screen.getAllByText(importedModel.displayName)).toHaveLength(2);
  });

  it("offers a direct retry when library metadata cannot be saved", () => {
    const onRetryPersistence = vi.fn();
    render(
      createElement(
        MediaAssetsView,
        createProps({
          persistenceError: "Imported metadata could not be saved.",
          onRetryPersistence,
        }),
      ),
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "Imported metadata could not be saved.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    expect(onRetryPersistence).toHaveBeenCalledOnce();
  });
});

describe("asset copy actions", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("copies the imported name and ID without opening the asset", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const namedAsset: MediaAssetRecord = {
      ...asset,
      operation: {
        kind: "local-import",
        sourceFileName: "Full asset name.png",
      },
    };
    render(
      createElement(MediaAssetsView, createProps({ assets: [namedAsset] })),
    );
    const preview = screen.getByRole("button", {
      name: "View Full asset name.png",
    });
    fireEvent.contextMenu(preview);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy name" }));
    expect(writeText).toHaveBeenCalledWith("Full asset name.png");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    preview.focus();
    fireEvent.keyDown(preview, { key: "F10", shiftKey: true });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Copy asset ID" }),
    );
    expect(writeText).toHaveBeenLastCalledWith(asset.id);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
