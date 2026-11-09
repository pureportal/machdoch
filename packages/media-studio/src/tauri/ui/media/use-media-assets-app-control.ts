import type {
  MediaAssetRecord,
  MediaModelAddonDescriptor,
  MediaModelDescriptor,
} from "../../../core/media/contracts.js";
import { mediaAssetLabel } from "../../../core/media/asset-label.js";
import { mediaAssetOrigin } from "../../../core/media/asset-discovery.js";
import {
  APP_CONTROL_LEVEL,
  useAppControlView,
} from "../app-control/use-app-control";

const LISTED_ITEMS = 40;

type MediaLibraryResource = MediaModelDescriptor | MediaModelAddonDescriptor;

const describeResource = (resource: MediaLibraryResource) => ({
  name: resource.displayName,
  type:
    "kind" in resource
      ? resource.kind === "lora"
        ? "LoRA"
        : "embedding"
      : "model",
});

const describeAsset = (asset: MediaAssetRecord) => ({
  name: mediaAssetLabel(asset),
  type: asset.kind,
  origin: mediaAssetOrigin(asset),
  createdAt: asset.createdAt,
});

export interface MediaAssetsAppControlOptions {
  filterLabel: string | null;
  query: string;
  activeFilterCount: number;
  resources: readonly MediaLibraryResource[];
  media: readonly MediaAssetRecord[];
  unconfiguredFileCount: number;
  openAsset: MediaAssetRecord | null;
  openResource: MediaLibraryResource | null;
}

export function useMediaAssetsAppControl({
  filterLabel,
  query,
  activeFilterCount,
  resources,
  media,
  unconfiguredFileCount,
  openAsset,
  openResource,
}: MediaAssetsAppControlOptions): void {
  const open = openAsset
    ? describeAsset(openAsset)
    : openResource
      ? describeResource(openResource)
      : null;
  useAppControlView("media-assets", APP_CONTROL_LEVEL.detail, {
    location: [
      ...(filterLabel ? [filterLabel] : []),
      ...(open ? [open.name] : []),
    ],
    state: () => {
      const items = [
        ...resources.map(describeResource),
        ...media.map(describeAsset),
      ];
      return {
        ...(open ? { open } : {}),
        ...(query.trim() ? { search: query.trim() } : {}),
        ...(activeFilterCount > 0 ? { activeFilters: activeFilterCount } : {}),
        shownCount: items.length + unconfiguredFileCount,
        ...(unconfiguredFileCount > 0
          ? { unconfiguredFiles: unconfiguredFileCount }
          : {}),
        items: items.slice(0, LISTED_ITEMS),
      };
    },
  });
}
