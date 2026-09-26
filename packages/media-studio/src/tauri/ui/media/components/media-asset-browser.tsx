import { useState } from "react";
import { Check } from "lucide-react";
import type {
  MediaAssetCategory,
  MediaAssetRecord,
  MediaGenerationAssetMetadata,
} from "../../../../core/media/contracts.js";
import { mediaAssetLabel } from "../../../../core/media/asset-label.js";
import { cn } from "../../lib/utils";
import { MediaAssetPreview } from "./media-visual-preview";
import { MediaPagination } from "./media-pagination";
import {
  MediaResourceFilters,
  useMediaResourceDiscovery,
} from "./media-resource-filters";

const PAGE_SIZE = 24;
const createdAtFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

export const MediaAssetBrowser = ({
  assets,
  metadata,
  categories,
  selectedIds,
  onSelect,
  disabledReason,
  label = "images",
  compact = false,
}: {
  assets: readonly MediaAssetRecord[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  categories: readonly MediaAssetCategory[];
  selectedIds: readonly string[];
  onSelect: (asset: MediaAssetRecord) => void;
  disabledReason?: (asset: MediaAssetRecord) => string | undefined;
  label?: string;
  compact?: boolean;
}) => {
  const discovery = useMediaResourceDiscovery(
    assets,
    metadata,
    categories,
    "newest",
  );
  const [page, setPage] = useState(1);
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const matching = discovery.visibleResources.filter(
    (asset) => (!selectedOnly || selectedIds.includes(asset.id)) &&
      (!compact || mediaAssetLabel(asset).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  );
  const pageCount = Math.ceil(matching.length / PAGE_SIZE);
  const currentPage = Math.min(page, Math.max(1, pageCount));
  const offset = (currentPage - 1) * PAGE_SIZE;
  return (
    <div className="space-y-3">
      {compact ? <input type="search" aria-label={`Search ${label}`} placeholder={`Search ${label}`} value={query}
        onChange={(event) => { setQuery(event.target.value); setPage(1); }}
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100" /> : <MediaResourceFilters
        label={label}
        filters={discovery.filters}
        onChange={(filters) => {
          discovery.setFilters(filters);
          setPage(1);
        }}
        categories={categories}
        tags={discovery.tags}
        allowNewest
      />}
      {!compact && selectedIds.length > 0 ? <label className="flex items-center gap-2 text-xs text-slate-300">
        <input
          type="checkbox"
          checked={selectedOnly}
          onChange={(event) => {
            setSelectedOnly(event.target.checked);
            setPage(1);
          }}
        />
        Selected only
      </label> : null}
      <div className="grid max-h-96 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
        {matching.slice(offset, offset + PAGE_SIZE).map((asset) => {
          const selected = selectedIds.includes(asset.id);
          const reason = disabledReason?.(asset);
          const name = mediaAssetLabel(asset);
          return (
            <button
              key={asset.id}
              type="button"
              aria-label={name}
              aria-pressed={selected}
              disabled={Boolean(reason)}
              title={reason}
              onClick={() => onSelect(asset)}
              className={cn(
                "min-w-0 overflow-hidden rounded-lg border bg-slate-900 text-left disabled:opacity-40",
                selected
                  ? "border-sky-400 ring-1 ring-sky-400"
                  : "border-slate-700 hover:border-slate-500",
              )}
            >
              <span className="relative block aspect-[4/3]">
                <MediaAssetPreview asset={asset} className="h-full w-full" />
                {selected ? (
                  <Check className="absolute right-1 top-1 h-5 w-5 rounded-full bg-sky-500 p-0.5 text-white" />
                ) : null}
              </span>
              <span className="block truncate px-2 pt-2 text-xs text-slate-200">
                {name}
              </span>
              <span className="block px-2 pb-2 text-[10px] text-slate-400">
                {asset.width} × {asset.height}
                <time dateTime={asset.createdAt} className="block truncate">
                  {createdAtFormatter.format(new Date(asset.createdAt))}
                </time>
              </span>
            </button>
          );
        })}
      </div>
      {matching.length === 0 ? (
        <p role="status" className="py-4 text-center text-xs text-slate-500">
          No matching {label}
        </p>
      ) : null}
      {(!compact || pageCount > 1) ? <MediaPagination
        page={currentPage}
        pageCount={pageCount}
        firstItemNumber={offset + 1}
        lastItemNumber={Math.min(offset + PAGE_SIZE, matching.length)}
        totalItems={matching.length}
        itemLabel={label}
        onPageChange={setPage}
      /> : null}
    </div>
  );
};
