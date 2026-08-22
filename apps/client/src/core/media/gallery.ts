import type { MediaAssetKind } from "./contracts.js";

export type MediaGalleryDirection = -1 | 1;

export interface MediaItemPage<T> {
  items: readonly T[];
  page: number;
  pageCount: number;
  pageSize: number;
  totalItems: number;
  startIndex: number;
  endIndex: number;
  firstItemNumber: number;
  lastItemNumber: number;
}

export const isMediaGalleryAssetKind = (kind: MediaAssetKind): boolean =>
  kind === "image" || kind === "vector" || kind === "video";

export const paginateMediaItems = <T>(
  items: readonly T[],
  requestedPage: number,
  pageSize: number,
): MediaItemPage<T> => {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new RangeError("Media page size must be a positive safe integer.");
  }

  const totalItems = items.length;
  if (totalItems === 0) {
    return {
      items: [],
      page: 0,
      pageCount: 0,
      pageSize,
      totalItems,
      startIndex: 0,
      endIndex: 0,
      firstItemNumber: 0,
      lastItemNumber: 0,
    };
  }

  const pageCount = Math.ceil(totalItems / pageSize);
  const normalizedRequestedPage = Number.isFinite(requestedPage)
    ? Math.trunc(requestedPage)
    : 1;
  const page = Math.min(pageCount, Math.max(1, normalizedRequestedPage));
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(totalItems, startIndex + pageSize);

  return {
    items: items.slice(startIndex, endIndex),
    page,
    pageCount,
    pageSize,
    totalItems,
    startIndex,
    endIndex,
    firstItemNumber: startIndex + 1,
    lastItemNumber: endIndex,
  };
};

export const stepMediaGalleryAssetId = (
  assetIds: readonly string[],
  currentAssetId: string | null,
  direction: MediaGalleryDirection,
): string | null => {
  if (assetIds.length === 0) return null;

  const currentIndex = currentAssetId
    ? assetIds.indexOf(currentAssetId)
    : -1;
  if (currentIndex < 0) {
    return direction === 1 ? assetIds[0] ?? null : assetIds.at(-1) ?? null;
  }

  return (
    assetIds[
      (currentIndex + direction + assetIds.length) % assetIds.length
    ] ?? null
  );
};
