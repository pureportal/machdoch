import type { MediaAssetRecord } from "./contracts.js";

export type MediaAssetOrigin = "generated" | "added";

export interface MediaAssetFilters {
  origin: "all" | MediaAssetOrigin;
  orientation: "all" | "landscape" | "portrait" | "square";
  format: string;
  dateFrom: string;
  dateTo: string;
}

export const EMPTY_MEDIA_ASSET_FILTERS: MediaAssetFilters = {
  origin: "all",
  orientation: "all",
  format: "all",
  dateFrom: "",
  dateTo: "",
};

export const mediaAssetOrigin = (asset: MediaAssetRecord): MediaAssetOrigin =>
  asset.operation && asset.operation.kind !== "local-import"
    ? "generated"
    : "added";

export const matchesMediaAssetFilters = (
  asset: MediaAssetRecord,
  filters: MediaAssetFilters,
): boolean => {
  if (filters.origin !== "all" && mediaAssetOrigin(asset) !== filters.origin)
    return false;
  if (filters.format !== "all" && asset.mimeType !== filters.format)
    return false;
  if (filters.orientation !== "all") {
    if (asset.width <= 0 || asset.height <= 0) return false;
    const orientation =
      asset.width === asset.height
        ? "square"
        : asset.width > asset.height
          ? "landscape"
          : "portrait";
    if (orientation !== filters.orientation) return false;
  }
  if (filters.dateFrom || filters.dateTo) {
    const createdAt = new Date(asset.createdAt).getTime();
    if (!Number.isFinite(createdAt)) return false;
    if (
      filters.dateFrom &&
      createdAt < new Date(`${filters.dateFrom}T00:00:00`).getTime()
    )
      return false;
    if (filters.dateTo) {
      const end = new Date(`${filters.dateTo}T00:00:00`);
      end.setDate(end.getDate() + 1);
      if (createdAt >= end.getTime()) return false;
    }
  }
  return true;
};
