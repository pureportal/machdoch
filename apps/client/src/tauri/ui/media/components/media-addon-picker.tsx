import { Check, Search, SlidersHorizontal, X } from "lucide-react";
import { useState, type JSX } from "react";
import {
  inspectMediaModelAddonCompatibility,
  matchesMediaModelAddonQuery,
  reconcileMediaModelAddonSelections,
} from "../../../../core/media/model-addons.js";
import type {
  MediaAssetCategory,
  MediaAssetRecord,
  MediaGenerationAssetMetadata,
  MediaModelAddonDescriptor,
  MediaModelAddonSelection,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import { cn } from "../../lib/utils";
import { MediaLoraStrengthControl } from "./media-lora-strength-control";
import { MediaResourcePreview } from "./media-visual-preview";

type AddonTypeFilter = "all" | "lora" | "textual-inversion";

interface MediaAddonBrowserProps {
  model: MediaModelDescriptor;
  addons: readonly MediaModelAddonDescriptor[];
  selections: readonly MediaModelAddonSelection[];
  assets: readonly MediaAssetRecord[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  categories: readonly MediaAssetCategory[];
  onToggle: (addonId: string) => void;
  onChangeSelection: (selection: MediaModelAddonSelection) => void;
  onClear: () => void;
  className?: string;
}

const addonTypeLabel = (kind: MediaModelAddonDescriptor["kind"]): string =>
  kind === "lora" ? "LoRA" : "Embedding";

export const MediaAddonBrowser = ({
  model,
  addons,
  selections,
  assets,
  metadata,
  categories,
  onToggle,
  onChangeSelection,
  onClear,
  className,
}: MediaAddonBrowserProps): JSX.Element => {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("all");
  const [tag, setTag] = useState("all");
  const [type, setType] = useState<AddonTypeFilter>("all");
  const [openControlsId, setOpenControlsId] = useState<string | null>(null);
  const reconciledSelections = reconcileMediaModelAddonSelections(
    model,
    addons,
    selections,
  );
  const compatibleAddons = addons.filter(
    (addon) =>
      inspectMediaModelAddonCompatibility(model, addon).status === "compatible",
  );
  const availableTags = [
    ...new Set(
      compatibleAddons.flatMap((addon) => metadata[addon.id]?.tags ?? []),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const visibleAddons = compatibleAddons.filter((addon) => {
    const details = metadata[addon.id];
    const categoryNames = (details?.categoryIds ?? []).flatMap((id) => {
      const category = categories.find((candidate) => candidate.id === id);
      return category ? [category.name] : [];
    });
    const queryMatches =
      matchesMediaModelAddonQuery(addon, query) ||
      [details?.tags.join(" ") ?? "", categoryNames.join(" ")]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase());
    return (
      queryMatches &&
      (categoryId === "all" || details?.categoryIds.includes(categoryId)) &&
      (tag === "all" || details?.tags.includes(tag)) &&
      (type === "all" || addon.kind === type)
    );
  });

  return (
    <div className={cn("space-y-3", className)}>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <div className="relative sm:col-span-2 xl:col-span-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
          <input
            aria-label="Search add-ons"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search add-ons"
            className={cn(
              "h-9 w-full rounded-lg border border-slate-700 bg-slate-950 pl-8 text-xs text-slate-100 outline-none focus:border-sky-500",
              reconciledSelections.length > 0 ? "pr-24" : "pr-2",
            )}
          />
          {reconciledSelections.length > 0 ? (
            <div className="absolute inset-y-0 right-1.5 flex items-center gap-1.5 text-[10px] text-slate-400">
              <span>{reconciledSelections.length} selected</span>
              <button
                type="button"
                aria-label="Clear selected add-ons"
                onClick={onClear}
                className="rounded p-0.5 hover:bg-slate-800 hover:text-slate-100"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ) : null}
        </div>
        <select
          aria-label="Add-on category"
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
        >
          <option value="all">All categories</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Add-on tag"
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
        >
          <option value="all">All tags</option>
          {availableTags.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <select
          aria-label="Add-on type"
          value={type}
          onChange={(event) => setType(event.target.value as AddonTypeFilter)}
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
        >
          <option value="all">All types</option>
          <option value="lora">LoRA</option>
          <option value="textual-inversion">Embedding</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {visibleAddons.map((addon) => {
          const selection = reconciledSelections.find(
            (candidate) => candidate.addonId === addon.id,
          );
          const capability = model.addonCapabilities.find(
            (candidate) => candidate.kind === addon.kind,
          );
          const atCapacity =
            !selection &&
            capability !== undefined &&
            reconciledSelections.filter(
              (candidate) => candidate.enabled && candidate.kind === addon.kind,
            ).length >= capability.maxActive;
          return (
            <article
              key={addon.id}
              className={cn(
                "relative isolate overflow-hidden rounded-xl border transition-colors",
                atCapacity
                  ? "border-slate-800 opacity-45"
                  : "hover:border-slate-600",
                selection
                  ? "border-sky-400 bg-sky-500/10"
                  : "border-slate-800 bg-slate-900/60",
              )}
            >
              <button
                type="button"
                aria-label={addon.displayName}
                aria-pressed={selection !== undefined}
                disabled={atCapacity}
                title={
                  atCapacity
                    ? `${addonTypeLabel(addon.kind)} selection limit reached.`
                    : undefined
                }
                onClick={() => onToggle(addon.id)}
                className="block w-full overflow-hidden rounded-xl text-left"
              >
                <div className="aspect-[4/3] bg-slate-900">
                  <MediaResourcePreview
                    resourceId={addon.id}
                    metadata={metadata}
                    assets={assets}
                    className="h-full w-full"
                  />
                </div>
                <div className="flex items-center gap-2 p-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-slate-200">
                      {addon.displayName}
                    </span>
                    <span className="block text-[9px] text-slate-500">
                      {addonTypeLabel(addon.kind)}
                    </span>
                  </span>
                  {selection ? (
                    <Check className="h-4 w-4 text-sky-300" />
                  ) : null}
                </div>
              </button>

              {selection ? (
                <div className="absolute inset-x-2 top-2 z-10 max-h-[calc(100%-1rem)] overflow-y-auto rounded-lg border border-sky-300/30 bg-slate-950/90 p-2 shadow-xl backdrop-blur">
                  <div className="flex items-center gap-2">
                    {selection.kind === "lora" ? (
                      <>
                        <MediaLoraStrengthControl
                          label={addon.displayName}
                          value={selection.modelStrength}
                          onChange={(modelStrength) =>
                            onChangeSelection({
                              ...selection,
                              modelStrength,
                            })
                          }
                        />
                        <button
                          type="button"
                          aria-label={`Adjust ${addon.displayName}`}
                          aria-expanded={openControlsId === addon.id}
                          onClick={() =>
                            setOpenControlsId((current) =>
                              current === addon.id ? null : addon.id,
                            )
                          }
                          className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                        >
                          <SlidersHorizontal className="h-3.5 w-3.5" />
                        </button>
                      </>
                    ) : (
                      <select
                        aria-label={`${addon.displayName} placement`}
                        value={selection.placement}
                        onChange={(event) =>
                          onChangeSelection({
                            ...selection,
                            placement: event.target
                              .value as typeof selection.placement,
                          })
                        }
                        className="h-7 min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-1.5 text-[9px] text-slate-200"
                      >
                        <option value="positive">Positive</option>
                        <option value="negative">Negative</option>
                        <option value="both">Both</option>
                      </select>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${addon.displayName}`}
                      onClick={() => onToggle(addon.id)}
                      className="rounded-md p-1 text-slate-400 hover:bg-rose-400/10 hover:text-rose-200"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  {selection.kind === "lora" && openControlsId === addon.id ? (
                    <div className="mt-2 space-y-2 border-t border-slate-800 pt-2 text-[9px] text-slate-300">
                      {capability?.supportsSeparateComponentStrengths ? (
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selection.textEncoderStrength !== null}
                            onChange={(event) =>
                              onChangeSelection({
                                ...selection,
                                textEncoderStrength: event.target.checked
                                  ? selection.modelStrength
                                  : null,
                              })
                            }
                          />
                          Text strength
                        </label>
                      ) : null}
                      {selection.textEncoderStrength !== null ? (
                        <label className="block">
                          <span className="mb-1 flex justify-between">
                            <span>Text</span>
                            <span>
                              {selection.textEncoderStrength.toFixed(2)}
                            </span>
                          </span>
                          <input
                            type="range"
                            min={-2}
                            max={2}
                            step={0.05}
                            value={selection.textEncoderStrength}
                            onChange={(event) =>
                              onChangeSelection({
                                ...selection,
                                textEncoderStrength: Number(event.target.value),
                              })
                            }
                            className="block w-full accent-sky-400"
                          />
                        </label>
                      ) : null}
                      {capability?.supportsDenoisingSchedules ? (
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={selection.denoisingSchedule !== null}
                            onChange={(event) =>
                              onChangeSelection({
                                ...selection,
                                denoisingSchedule: event.target.checked
                                  ? { start: 0, end: 1 }
                                  : null,
                              })
                            }
                          />
                          Denoising window
                        </label>
                      ) : null}
                      {selection.denoisingSchedule ? (
                        <div className="grid grid-cols-2 gap-2">
                          {(["start", "end"] as const).map((key) => (
                            <label key={key}>
                              <span className="capitalize">{key}</span>
                              <input
                                type="number"
                                min={
                                  key === "start"
                                    ? 0
                                    : selection.denoisingSchedule!.start + 0.05
                                }
                                max={
                                  key === "start"
                                    ? selection.denoisingSchedule!.end - 0.05
                                    : 1
                                }
                                step={0.05}
                                value={selection.denoisingSchedule![key]}
                                onChange={(event) =>
                                  onChangeSelection({
                                    ...selection,
                                    denoisingSchedule: {
                                      ...selection.denoisingSchedule!,
                                      [key]: Number(event.target.value),
                                    },
                                  })
                                }
                                className="mt-1 h-7 w-full rounded border border-slate-700 bg-slate-950 px-1.5"
                              />
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      {visibleAddons.length === 0 ? (
        <p className="py-6 text-center text-xs text-slate-500">
          No compatible add-ons
        </p>
      ) : null}
    </div>
  );
};
