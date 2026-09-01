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
} from "../../../../core/media/contracts.js";
import { MediaAssetsView } from "./media-assets-view";

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
  onRefreshLocalRuntime: vi.fn(),
  onVerifyModel: vi.fn(),
  localRuntimeRefreshing: false,
  verifyingModelId: null,
  onUseAddon: vi.fn(),
  onUseAsReference: vi.fn(),
  onOpenVideoAsFlow: vi.fn(),
  onInspectSettings: vi.fn(),
  onReuseSettings: vi.fn(),
  onPlanAssetDeletion: vi.fn(async () => deletionImpact),
  onDeleteAsset: vi.fn(async () => undefined),
  onUpdateTags: vi.fn(),
  onUpdateMetadata: vi.fn(),
  onCategoryStateChange: vi.fn(),
  tagLoadingAssetId: null,
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MediaAssetsView asset actions", () => {
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
      .getByRole("button", { name: "View image output 1" })
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
      (model) => model.id === "openai:gpt-image-2",
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
    const onRefreshLocalRuntime = vi.fn();
    const onVerifyModel = vi.fn();

    render(
      createElement(
        MediaAssetsView,
        createProps({
          assets: [],
          catalog,
          onUseModel,
          onRefreshLocalRuntime,
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
      screen.getByText(
        "Start or repair the required runtime, then probe again.",
      ),
    ).toBeTruthy();

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
        name: "Refresh runtime",
      }),
    );
    expect(onRefreshLocalRuntime).toHaveBeenCalledOnce();

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
