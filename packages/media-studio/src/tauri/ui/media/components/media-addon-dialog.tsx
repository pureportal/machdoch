import { useState } from "react";
import { X } from "lucide-react";
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
            Choose add-ons{selected.length ? ` (${selected.length})` : ""}
          </Button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden border-slate-700 bg-slate-950 text-slate-100 sm:max-w-4xl"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto">
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
          <div className="flex justify-end border-t border-slate-800 pt-3">
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {selected.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((selection) => {
            const addon = addons.find(
              (candidate) => candidate.id === selection.addonId,
            )!;
            return (
              <li
                key={selection.addonId}
                className="flex max-w-full items-center gap-1 rounded-lg border border-sky-400/30 bg-sky-400/10 py-1 pl-2 pr-1 text-xs text-sky-100"
              >
                <span className="min-w-0 truncate">
                  {addon.displayName} ·{" "}
                  {selection.kind === "lora"
                    ? selection.modelStrength
                    : selection.placement}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${addon.displayName}`}
                  onClick={() => toggle(addon.id)}
                  className="rounded p-1 hover:bg-slate-800"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};
