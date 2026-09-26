import type { MediaAssetFilters } from "../../../../core/media/asset-discovery.js";

export type MediaAssetTypeFilter =
  | "all"
  | "model"
  | "lora"
  | "embedding"
  | "image"
  | "openpose"
  | "video"
  | "svg";

export interface MediaLibraryModelFilters {
  target: "all" | "local" | "remote";
  readiness: "all" | "ready" | "needs-attention";
}

export const EMPTY_MEDIA_LIBRARY_MODEL_FILTERS: MediaLibraryModelFilters = {
  target: "all",
  readiness: "all",
};

const controlClassName =
  "h-9 min-w-0 max-w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200";

export const MediaAssetsFilters = ({
  type,
  media,
  onMediaChange,
  models,
  onModelsChange,
  formats,
  architecture,
  onArchitectureChange,
  architectures,
  activeCount,
  onClear,
}: {
  type: MediaAssetTypeFilter;
  media: MediaAssetFilters;
  onMediaChange: (filters: MediaAssetFilters) => void;
  models: MediaLibraryModelFilters;
  onModelsChange: (filters: MediaLibraryModelFilters) => void;
  formats: readonly string[];
  architecture: string;
  onArchitectureChange: (value: string) => void;
  architectures: readonly { id: string; label: string }[];
  activeCount: number;
  onClear: () => void;
}) => {
  const resourcesOnly = ["model", "lora", "embedding"].includes(type);
  return (
    <details className="border-b border-slate-800 px-5 py-2">
      <summary className="cursor-pointer text-xs text-slate-300">
        Filters{activeCount > 0 ? ` (${activeCount})` : ""}
      </summary>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {resourcesOnly ? (
          <select
            aria-label="Base model family"
            value={architecture}
            onChange={(event) => onArchitectureChange(event.target.value)}
            className={controlClassName}
          >
            <option value="all">All model families</option>
            {architecture !== "all" &&
            !architectures.some((item) => item.id === architecture) ? (
              <option value={architecture}>{architecture}</option>
            ) : null}
            {architectures.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        ) : (
          <>
            <select
              aria-label="Media source"
              value={media.origin}
              onChange={(event) =>
                onMediaChange({
                  ...media,
                  origin: event.target.value as MediaAssetFilters["origin"],
                })
              }
              className={controlClassName}
            >
              <option value="all">All sources</option>
              <option value="generated">Generations</option>
              <option value="added">Uploads and imports</option>
            </select>
            <select
              aria-label="Media orientation"
              value={media.orientation}
              onChange={(event) =>
                onMediaChange({
                  ...media,
                  orientation: event.target
                    .value as MediaAssetFilters["orientation"],
                })
              }
              className={controlClassName}
            >
              <option value="all">All orientations</option>
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
              <option value="square">Square</option>
            </select>
            <select
              aria-label="Media format"
              value={media.format}
              onChange={(event) =>
                onMediaChange({ ...media, format: event.target.value })
              }
              className={controlClassName}
            >
              <option value="all">All formats</option>
              {media.format !== "all" && !formats.includes(media.format) ? (
                <option value={media.format}>{media.format}</option>
              ) : null}
              {formats.map((format) => (
                <option key={format} value={format}>
                  {format}
                </option>
              ))}
            </select>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              From
              <input
                type="date"
                aria-label="Media date from"
                value={media.dateFrom}
                max={media.dateTo || undefined}
                onChange={(event) =>
                  onMediaChange({ ...media, dateFrom: event.target.value })
                }
                className={controlClassName}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              To
              <input
                type="date"
                aria-label="Media date to"
                value={media.dateTo}
                min={media.dateFrom || undefined}
                onChange={(event) =>
                  onMediaChange({ ...media, dateTo: event.target.value })
                }
                className={controlClassName}
              />
            </label>
          </>
        )}
        {type === "model" ? (
          <>
            <select
              aria-label="Model location"
              value={models.target}
              onChange={(event) =>
                onModelsChange({
                  ...models,
                  target: event.target
                    .value as MediaLibraryModelFilters["target"],
                })
              }
              className={controlClassName}
            >
              <option value="all">All locations</option>
              <option value="local">Local</option>
              <option value="remote">Remote</option>
            </select>
            <select
              aria-label="Model readiness"
              value={models.readiness}
              onChange={(event) =>
                onModelsChange({
                  ...models,
                  readiness: event.target
                    .value as MediaLibraryModelFilters["readiness"],
                })
              }
              className={controlClassName}
            >
              <option value="all">All readiness states</option>
              <option value="ready">Ready to use</option>
              <option value="needs-attention">Needs attention</option>
            </select>
          </>
        ) : null}
        {activeCount > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="h-9 px-2 text-xs text-slate-300 hover:text-white"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </details>
  );
};
