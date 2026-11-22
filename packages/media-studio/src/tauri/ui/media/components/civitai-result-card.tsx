import { Check, Download, ImageOff, ThumbsUp } from "lucide-react";
import {
  civitaiTypeLabel,
  civitaiVisibleImages,
  type CivitaiModel,
} from "../../../../core/media/civitai.js";

const numberFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export function CivitaiResultCard({
  model,
  mature,
  installedHashes,
  onOpen,
}: {
  model: CivitaiModel;
  mature: boolean;
  installedHashes: ReadonlySet<string>;
  onOpen: () => void;
}) {
  const version = model.modelVersions[0];
  const preview = civitaiVisibleImages(model, version, mature)[0];
  const installed = model.modelVersions.some((candidate) =>
    candidate.files.some(
      (file) =>
        file.hashes?.SHA256 &&
        installedHashes.has(file.hashes.SHA256.toLowerCase()),
    ),
  );
  const baseModels = [
    ...new Set(
      model.modelVersions
        .map((candidate) => candidate.baseModel)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  return (
    <button
      type="button"
      onClick={onOpen}
      data-model-id={model.id}
      aria-label={`View ${model.name}`}
      className="group flex w-full flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50 text-left transition hover:border-sky-400/60 focus-visible:outline-2 focus-visible:outline-sky-400"
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden bg-slate-900">
        {preview ? (
          <img
            src={preview.url}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
          />
        ) : (
          <ImageOff className="h-8 w-8 text-slate-600" />
        )}
        <span className="absolute left-2 top-2 rounded-md bg-slate-950/85 px-2 py-0.5 text-[11px] font-medium text-slate-200">
          {civitaiTypeLabel(model.type)}
        </span>
        {installed && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-emerald-950/90 px-2 py-0.5 text-[11px] text-emerald-300">
            <Check className="h-3 w-3" /> In library
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <p className="line-clamp-2 text-sm font-medium text-slate-100">
          {model.name}
        </p>
        <p className="truncate text-xs text-slate-400">
          {[baseModels.slice(0, 2).join(", "), model.creator?.username]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="mt-auto flex items-center gap-3 pt-1 text-[11px] text-slate-400">
          {model.stats?.downloadCount != null && (
            <span className="flex items-center gap-1">
              <Download className="h-3 w-3" />
              {numberFormat.format(model.stats.downloadCount)}
            </span>
          )}
          {model.stats?.thumbsUpCount != null && (
            <span className="flex items-center gap-1">
              <ThumbsUp className="h-3 w-3" />
              {numberFormat.format(model.stats.thumbsUpCount)}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

export function CivitaiResultSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50"
    >
      <div className="aspect-square animate-pulse bg-slate-800/60" />
      <div className="space-y-2 p-3">
        <div className="h-3.5 w-4/5 animate-pulse rounded bg-slate-800" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-slate-800/70" />
      </div>
    </div>
  );
}
