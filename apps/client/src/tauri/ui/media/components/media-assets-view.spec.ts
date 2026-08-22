// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  onInspectModel: vi.fn(),
  onInspectAddon: vi.fn(),
  onInspectCivitai: vi.fn(),
  onImportMedia: vi.fn(async () => null),
  onImportModel: vi.fn(async () => false),
  onImportAddon: vi.fn(async () => false),
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
});
