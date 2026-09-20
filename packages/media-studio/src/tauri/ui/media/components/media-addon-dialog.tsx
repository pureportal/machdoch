import { useState } from "react";
import { Plus, SlidersHorizontal, X } from "lucide-react";
import type {
  MediaAssetCategory,
  MediaAssetRecord,
  MediaGenerationAssetMetadata,
  MediaModelAddonDescriptor,
  MediaModelAddonSelection,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import {
  createMediaModelAddonSelection,
  reconcileMediaModelAddonSelections,
} from "../../../../core/media/model-addons.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { MediaLoraStrengthControl } from "./media-lora-strength-control";
import { MediaAddonBrowser } from "./media-addon-picker";

export const MediaAddonDialog = ({
  model,
  addons,
  selections,
  assets,
  metadata,
  categories,
  onChange,
  disabled = false,
}: {
  model: MediaModelDescriptor;
  addons: readonly MediaModelAddonDescriptor[];
  selections: readonly MediaModelAddonSelection[];
  assets: readonly MediaAssetRecord[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  categories: readonly MediaAssetCategory[];
  onChange: (selections: MediaModelAddonSelection[]) => void;
  disabled?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const title = model.addonCapabilities.some(
    (capability) => capability.kind === "textual-inversion",
  )
    ? "LoRAs and embeddings"
    : "LoRAs";
  const selected = reconcileMediaModelAddonSelections(
    model,
    addons,
    selections,
  );
  const toggle = (addonId: string) => {
    const existing = selected.some(
      (selection) => selection.addonId === addonId,
    );
    const addon = addons.find((candidate) => candidate.id === addonId);
    if (!addon || disabled) return;
    onChange(
      reconcileMediaModelAddonSelections(
        model,
        addons,
        existing
          ? selected.filter((selection) => selection.addonId !== addonId)
          : [...selected, createMediaModelAddonSelection(addon)],
      ),
    );
  };
  return (
    <div className="space-y-2">
      <Dialog open={open && !disabled} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={`Choose ${title}`}
          >
            <Plus className="h-4 w-4" />
            Add {title}
          </Button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          className="flex h-[min(48rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-3xl"
        >
          <DialogHeader className="border-b border-slate-800 px-5 py-4">
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            <MediaAddonBrowser
              model={model}
              addons={addons}
              selections={selected}
              assets={assets}
              metadata={metadata}
              categories={categories}
              onToggle={toggle}
              onChangeSelection={(selection) =>
                onChange(
                  selected.map((candidate) =>
                    candidate.addonId === selection.addonId
                      ? selection
                      : candidate,
                  ),
                )
              }
              onClear={() => onChange([])}
            />
          </div>
          <div className="flex justify-end border-t border-slate-800 px-5 py-3">
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {selected.length ? (
        <ul className="space-y-2">
          {selected.map((selection) => {
            const addon = addons.find(
              (candidate) => candidate.id === selection.addonId,
            )!;
            return (
              <li
                key={selection.addonId}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-700/70 bg-slate-900/60 p-3"
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setOpen(true)}
                  aria-label={`Edit ${addon.displayName}`}
                  className="flex min-w-0 flex-1 basis-28 items-center gap-2 text-left text-sm font-medium text-slate-200 hover:text-sky-300"
                >
                  <SlidersHorizontal className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="break-words">{addon.displayName}</span>
                </button>
                {selection.kind === "lora" ? (
                  <div className="w-36 max-w-full shrink-0">
                    <MediaLoraStrengthControl
                      label={addon.displayName}
                      value={selection.modelStrength}
                      disabled={disabled}
                      onChange={(modelStrength) =>
                        onChange(
                          selected.map((candidate) =>
                            candidate.addonId === selection.addonId
                              ? { ...selection, modelStrength }
                              : candidate,
                          ),
                        )
                      }
                    />
                  </div>
                ) : (
                  <span className="text-xs capitalize text-slate-400">
                    {selection.placement}
                  </span>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${addon.displayName}`}
                  onClick={() => toggle(addon.id)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-400/10 hover:text-rose-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};
