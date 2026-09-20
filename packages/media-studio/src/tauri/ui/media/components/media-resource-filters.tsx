import { useMemo, useState } from "react";
import type {
  MediaAssetCategory,
  MediaGenerationAssetMetadata,
} from "../../../../core/media/contracts.js";
import {
  discoverMediaResources,
  listMediaResourceTags,
  type MediaLibraryResource,
  type MediaResourceFilters as ResourceFilters,
  type MediaResourceSort,
} from "../../../../core/media/resource-discovery.js";
import { SearchField } from "../../components/ui/search-field";

export const useMediaResourceDiscovery = <T extends MediaLibraryResource>(
  resources: readonly T[],
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>,
  categories: readonly MediaAssetCategory[],
  initialSort: MediaResourceSort = "name",
  controlledFilters?: readonly [
    ResourceFilters,
    (filters: ResourceFilters) => void,
  ],
) => {
  const [localFilters, setLocalFilters] = useState<ResourceFilters>({
    query: "",
    categoryId: "all",
    tag: "all",
    sort: initialSort,
  });
  const [filters, setFilters] = controlledFilters ?? [
    localFilters,
    setLocalFilters,
  ];
  const visibleResources = useMemo(
    () => discoverMediaResources(resources, metadata, categories, filters),
    [resources, metadata, categories, filters],
  );
  const tags = listMediaResourceTags(resources, metadata);
  return { visibleResources, filters, setFilters, tags };
};

export const MediaResourceFilters = ({
  label,
  filters,
  onChange,
  categories,
  tags,
  allowNewest = false,
  showSearch = true,
}: {
  label: string;
  filters: ResourceFilters;
  onChange: (filters: ResourceFilters) => void;
  categories: readonly MediaAssetCategory[];
  tags: readonly string[];
  allowNewest?: boolean;
  showSearch?: boolean;
}) => (
  <div className="flex flex-wrap gap-2">
    {showSearch ? (
      <SearchField
        aria-label={`Search ${label}`}
        placeholder={`Search ${label}`}
        value={filters.query}
        onChange={(event) =>
          onChange({ ...filters, query: event.target.value })
        }
        containerClassName="min-w-40 flex-1 basis-full"
        className="h-9 border-slate-700 bg-slate-950 text-xs text-slate-100"
      />
    ) : null}
    <select
      aria-label={`${label} category`}
      value={filters.categoryId}
      onChange={(event) =>
        onChange({ ...filters, categoryId: event.target.value })
      }
      className="h-9 min-w-0 flex-1 basis-[calc(50%-0.25rem)] rounded-lg sm:basis-0 border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
    >
      <option value="all">All categories</option>
      <option value="uncategorized">Uncategorised</option>
      {[...categories]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
    </select>
    <select
      aria-label={`${label} tag`}
      value={filters.tag}
      onChange={(event) => onChange({ ...filters, tag: event.target.value })}
      className="h-9 min-w-0 flex-1 basis-[calc(50%-0.25rem)] rounded-lg sm:basis-0 border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
    >
      <option value="all">All tags</option>
      {filters.tag !== "all" && !tags.includes(filters.tag) ? (
        <option value={filters.tag}>{filters.tag}</option>
      ) : null}
      {tags.map((tag) => (
        <option key={tag} value={tag}>
          {tag}
        </option>
      ))}
    </select>
    <select
      aria-label={`Sort ${label}`}
      value={filters.sort}
      onChange={(event) =>
        onChange({ ...filters, sort: event.target.value as MediaResourceSort })
      }
      className="h-9 min-w-0 flex-1 basis-[calc(50%-0.25rem)] rounded-lg sm:basis-0 border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
    >
      <option value="name">Name A–Z</option>
      <option value="name-desc">Name Z–A</option>
      {allowNewest ? <option value="newest">Newest first</option> : null}
    </select>
  </div>
);
