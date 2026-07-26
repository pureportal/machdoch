import type {
  MediaAssetPage,
  MediaAssetRecord,
} from "./contracts.js";
import {
  collectRevisionedMediaPages,
  type RevisionedMediaLibrarySnapshot,
} from "./revisioned-library.js";

export interface MediaAssetPageRequest {
  offset: number;
  limit: number;
  knownRevision: string | null;
}

export type MediaAssetLibrarySnapshot =
  RevisionedMediaLibrarySnapshot<MediaAssetRecord>;

export type MediaAssetPageLoader = (
  request: MediaAssetPageRequest,
) => Promise<MediaAssetPage>;

const normalizeSearchValue = (value: string): string =>
  value.toLocaleLowerCase().replaceAll(/[-_:/.]+/g, " ");

export const matchesMediaAssetQuery = (
  asset: MediaAssetRecord,
  query: string,
): boolean => {
  const terms = normalizeSearchValue(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const operationAliases =
    asset.operation?.kind === "local-image-flow"
      ? [
          asset.operation.assetRole === "alpha-matte" ? "alpha matte" : "",
          asset.operation.assetRole === "cutout" ? "transparent cutout" : "",
          asset.operation.composite ? "composite" : "",
          asset.operation.contactSheet ? "contact sheet" : "",
        ]
      : asset.operation?.kind === "rasterize-svg"
        ? ["safe svg raster"]
        : [];
  const provenance =
    asset.kind === "report"
      ? "analysis technical quality report"
      : asset.operation?.kind === "remote-image-generation"
        ? "generated"
        : asset.operation?.kind === "remote-image-edit"
          ? "edited"
          : asset.operation
            ? "derived"
            : asset.fixture
              ? "fixture"
              : "imported";
  const haystack = normalizeSearchValue(
    [
      asset.id,
      asset.runId,
      asset.digest,
      asset.kind,
      asset.mimeType,
      asset.byteSize.toString(),
      `${asset.width} ${asset.height}`,
      asset.createdAt,
      `output ${asset.outputIndex + 1}`,
      asset.fixture ? "fixture" : "",
      provenance,
      JSON.stringify(asset.operation ?? {}),
      ...operationAliases,
      ...asset.sourceAssetIds,
      ...asset.tags.flatMap((tag) => [
        tag.value,
        tag.label,
        tag.source,
        tag.confidence?.toString() ?? "",
      ]),
    ].join(" "),
  );
  return terms.every((term) => haystack.includes(term));
};

interface CollectMediaAssetPagesOptions {
  loadPage: MediaAssetPageLoader;
  cached: MediaAssetLibrarySnapshot | null;
  pageSize?: number;
  maxRestarts?: number;
}

/**
 * Collects one coherent native asset snapshot without imposing a hidden
 * library-size cap. A revision change between page reads restarts collection;
 * an unchanged first page reuses the caller's complete cached snapshot.
 */
export const collectMediaAssetPages = async ({
  loadPage,
  cached,
  pageSize = 250,
  maxRestarts = 2,
}: CollectMediaAssetPagesOptions): Promise<MediaAssetLibrarySnapshot> =>
  collectRevisionedMediaPages({
    libraryLabel: "asset library",
    itemLabel: "Asset",
    loadPage,
    cached,
    pageSize,
    maxRestarts,
  });
