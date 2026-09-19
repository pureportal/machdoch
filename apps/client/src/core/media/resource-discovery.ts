import { mediaAssetCategoryNames } from "./asset-categories.js";
import { mediaAssetLabel } from "./asset-label.js";
import type {
  MediaAssetCategory,
  MediaAssetRecord,
  MediaGenerationAssetMetadata,
  MediaModelAddonDescriptor,
  MediaModelDescriptor,
} from "./contracts.js";

export type MediaLibraryResource =
  | MediaModelDescriptor
  | MediaModelAddonDescriptor
  | MediaAssetRecord;

export type MediaResourceSort =
  | "name"
  | "name-desc"
  | "newest"
  | "oldest"
  | "largest"
  | "smallest";

export interface MediaResourceFilters {
  query: string;
  categoryId: string;
  tag: string;
  sort: MediaResourceSort;
}

export const mediaResourceName = (resource: MediaLibraryResource): string =>
  "displayName" in resource ? resource.displayName : mediaAssetLabel(resource);

export const mediaResourceTags = (
  resource: MediaLibraryResource,
  metadata: MediaGenerationAssetMetadata | undefined,
): string[] => [
  ...new Map(
    [
      ...(metadata?.tags ?? []),
      ...("tags" in resource ? resource.tags.map((tag) => tag.label) : []),
    ].map((tag) => [tag.toLocaleLowerCase(), tag]),
  ).values(),
];

export const listMediaResourceTags = (
  resources: readonly MediaLibraryResource[],
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>,
): string[] =>
  [
    ...new Map(
      resources
        .flatMap((resource) =>
          mediaResourceTags(resource, metadata[resource.id]),
        )
        .map((tag) => [tag.toLocaleLowerCase(), tag]),
    ).values(),
  ].sort((left, right) => left.localeCompare(right));

export const matchesMediaResourceQuery = (
  resource: MediaLibraryResource,
  metadata: MediaGenerationAssetMetadata | undefined,
  categories: readonly MediaAssetCategory[],
  query: string,
): boolean => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const details =
    "providerId" in resource
      ? [resource.family, resource.architecture, resource.target, "model"]
      : "targetComponents" in resource
        ? [
            resource.architecture,
            resource.architectureConfidence,
            resource.baseModelHint,
            resource.kind === "lora" ? "LoRA" : "Embedding textual-inversion",
            ...resource.targetComponents,
            ...resource.triggerWords,
            resource.defaultToken,
            resource.digest,
            resource.relativePath,
            resource.sourceUrl,
            resource.license.name,
            resource.license.spdxId,
            resource.license.commercialUse,
          ]
        : [
            resource.kind,
            resource.kind === "vector" ? "svg" : "",
            resource.mimeType,
            resource.digest,
            `${resource.width}x${resource.height}`,
            resource.createdAt,
          ];
  const text = [
    resource.id,
    mediaResourceName(resource),
    ...details,
    ...mediaResourceTags(resource, metadata),
    ...mediaAssetCategoryNames(metadata?.categoryIds ?? [], categories),
    metadata?.triggerWords,
    metadata?.sourceUrl,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  return terms.every((term) => text.includes(term));
};

export const discoverMediaResources = <T extends MediaLibraryResource>(
  resources: readonly T[],
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>,
  categories: readonly MediaAssetCategory[],
  filters: MediaResourceFilters,
): T[] =>
  resources
    .filter((resource) => {
      const details = metadata[resource.id];
      const categoryIds = details?.categoryIds ?? [];
      return (
        matchesMediaResourceQuery(
          resource,
          details,
          categories,
          filters.query,
        ) &&
        (filters.categoryId === "all" ||
          (filters.categoryId === "uncategorized"
            ? categoryIds.length === 0
            : categoryIds.includes(filters.categoryId))) &&
        (filters.tag === "all" ||
          mediaResourceTags(resource, details).some(
            (tag) =>
              tag.toLocaleLowerCase() === filters.tag.toLocaleLowerCase(),
          ))
      );
    })
    .sort((left, right) => {
      if (filters.sort === "newest" || filters.sort === "oldest") {
        const date = (resource: MediaLibraryResource): number => {
          const value =
            "createdAt" in resource
              ? resource.createdAt
              : "importedAt" in resource
                ? resource.importedAt
                : "";
          return Date.parse(value);
        };
        const leftDate = date(left);
        const rightDate = date(right);
        if (Number.isFinite(leftDate) !== Number.isFinite(rightDate)) {
          return Number.isFinite(leftDate) ? -1 : 1;
        }
        const byDate = leftDate - rightDate;
        if (byDate) return filters.sort === "newest" ? -byDate : byDate;
      }
      if (filters.sort === "largest" || filters.sort === "smallest") {
        const bySize =
          ("byteSize" in left ? left.byteSize : 0) -
          ("byteSize" in right ? right.byteSize : 0);
        if (bySize) return filters.sort === "largest" ? -bySize : bySize;
      }
      const byName = mediaResourceName(left).localeCompare(
        mediaResourceName(right),
        undefined,
        { numeric: true, sensitivity: "base" },
      );
      return (
        (filters.sort === "name-desc" ? -byName : byName) ||
        left.id.localeCompare(right.id)
      );
    });
