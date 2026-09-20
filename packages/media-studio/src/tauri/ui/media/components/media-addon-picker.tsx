import { useMediaViewPreference } from "../use-media-view-preference";
import { Check, SlidersHorizontal, X } from "lucide-react";
import { useState, type JSX } from "react";
import {
  inspectMediaModelAddonCompatibility,
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
import { ControlTooltip } from "../../components/ui/tooltip";
import { MediaLoraStrengthControl } from "./media-lora-strength-control";
import { MediaResourcePreview } from "./media-visual-preview";

import {
  MediaResourceFilters,
  useMediaResourceDiscovery,
} from "./media-resource-filters";

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
  const [selectedOnly, setSelectedOnly] = useMediaViewPreference(
    "addonSelectedOnly",
    false,
  );
  const [type, setType] = useMediaViewPreference("addonType", "all");
  const showTypeFilter = model.addonCapabilities.length > 1;
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
  const addonFilters = useMediaViewPreference("addonFilters", {
    query: "",
    categoryId: "all",
    tag: "all",
    sort: "name",
  });
  const discovery = useMediaResourceDiscovery(
    compatibleAddons,
    metadata,
    categories,
    "name",
    addonFilters,
  );
  const visibleAddons = discovery.visibleResources.filter(
    (addon) =>
      (!showTypeFilter || type === "all" || addon.kind === type) &&
      (!selectedOnly ||
        reconciledSelections.some(
          (selection) => selection.addonId === addon.id,
        )),
  );

  return (
    <div className={cn("space-y-3", className)}>
      <MediaResourceFilters
        label="add-ons"
        filters={discovery.filters}
        onChange={discovery.setFilters}
        categories={categories}
        tags={discovery.tags}
        allowNewest
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={selectedOnly}
            onChange={(event) => setSelectedOnly(event.target.checked)}
          />
          Selected only
        </label>
        <span className="text-xs text-slate-400" aria-live="polite">
          {reconciledSelections.length} selected
        </span>
        {discovery.filters.query ||
        discovery.filters.categoryId !== "all" ||
        discovery.filters.tag !== "all" ||
        selectedOnly ||
        type !== "all" ? (
          <button
            type="button"
            className="text-xs text-slate-300 hover:text-white"
            onClick={() => {
              discovery.setFilters({
                ...discovery.filters,
                query: "",
                categoryId: "all",
                tag: "all",
              });
              setSelectedOnly(false);
              setType("all");
            }}
          >
            Reset filters
          </button>
        ) : null}
        {reconciledSelections.length > 0 ? (
          <button
            type="button"
            aria-label="Clear selected add-ons"
            onClick={onClear}
            className="text-xs text-sky-300"
          >
            Clear
          </button>
        ) : null}
        {showTypeFilter ? (
          <select
            aria-label="Add-on type"
            value={type}
            onChange={(event) => setType(event.target.value as AddonTypeFilter)}
            className="ml-auto h-9 rounded-lg border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
          >
            <option value="all">All types</option>
            <option value="lora">LoRA</option>
            <option value="textual-inversion">Embedding</option>
          </select>
        ) : null}
      </div>

      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
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
          const addonButton = (
            <button
              type="button"
              aria-label={addon.displayName}
              aria-pressed={selection !== undefined}
              disabled={atCapacity}
              onClick={() => onToggle(addon.id)}
              className="flex w-full items-center gap-3 overflow-hidden rounded-xl p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
            >
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-800">
                <MediaResourcePreview
                  resourceId={addon.id}
                  metadata={metadata}
                  assets={assets}
                  className="h-full w-full"
                />
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium leading-5 text-slate-200">
                    {addon.displayName}
                  </span>
                  <span className="mt-1 block text-xs text-slate-400">
                    {[
                      addonTypeLabel(addon.kind),
                      ...(metadata[addon.id]?.tags ?? []).slice(0, 2),
                    ].join(" · ")}
                  </span>
                </span>
                {selection ? <Check className="h-4 w-4 text-sky-300" /> : null}
              </div>
            </button>
          );
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
              {atCapacity ? (
                <ControlTooltip
                  content={`${addonTypeLabel(addon.kind)} selection limit reached`}
                >
                  <span className="block">{addonButton}</span>
                </ControlTooltip>
              ) : (
                addonButton
              )}

              {selection ? (
                <div className="border-t border-slate-800 bg-slate-950/60 p-3">
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
                        <ControlTooltip content={`Adjust ${addon.displayName}`}>
                          <button
                            type="button"
                            aria-label={`Adjust ${addon.displayName}`}
                            aria-expanded={openControlsId === addon.id}
                            onClick={() =>
                              setOpenControlsId((current) =>
                                current === addon.id ? null : addon.id,
                              )
                            }
                            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                          >
                            <SlidersHorizontal className="h-4 w-4" />
                          </button>
                        </ControlTooltip>
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
                        className="h-9 min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-1.5 text-xs text-slate-200"
                      >
                        <option value="positive">Positive</option>
                        <option value="negative">Negative</option>
                        <option value="both">Both</option>
                      </select>
                    )}
                    <ControlTooltip content={`Remove ${addon.displayName}`}>
                      <button
                        type="button"
                        aria-label={`Remove ${addon.displayName}`}
                        onClick={() => onToggle(addon.id)}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-400/10 hover:text-rose-200"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </ControlTooltip>
                  </div>
                  {selection.kind === "textual-inversion" ? (
                    <input
                      aria-label={`${addon.displayName} token`}
                      value={selection.token}
                      onChange={(event) =>
                        onChangeSelection({
                          ...selection,
                          token: event.target.value,
                        })
                      }
                      className="mt-2 h-8 w-full rounded border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
                    />
                  ) : null}
                  {selection.kind === "lora" && openControlsId === addon.id ? (
                    <div className="mt-3 space-y-3 border-t border-slate-800 pt-2 text-xs text-slate-300">
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
                                className="mt-1 h-9 w-full rounded border border-slate-700 bg-slate-950 px-1.5"
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
          {compatibleAddons.length === 0
            ? "No compatible add-ons"
            : "No matching add-ons"}
        </p>
      ) : null}
    </div>
  );
};
