import { useEffect, useMemo, type JSX } from "react";
import type {
  MediaAssetCategory,
  MediaAssetRecord,
  MediaGenerationAssetMetadata,
  MediaModelAddonDescriptor,
  MediaModelAddonSelection,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import {
  mediaModelAddonSelectionsEqual,
  reconcileMediaModelAddonSelections,
} from "../../../../core/media/model-addons.js";
import { MediaAddonDialog } from "./media-addon-dialog";
import { readModelAddonSelections } from "../../../../core/media/compiler.js";

export const MediaNodeAddonField = ({
  controlId,
  model,
  addons,
  assets,
  metadata,
  categories,
  value,
  disabled,
  describedBy,
  onChange,
}: {
  controlId: string;
  model: MediaModelDescriptor | null;
  addons: readonly MediaModelAddonDescriptor[];
  assets: readonly MediaAssetRecord[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  categories: readonly MediaAssetCategory[];
  value: unknown;
  disabled: boolean;
  describedBy: string;
  onChange: (value: MediaModelAddonSelection[]) => void;
}): JSX.Element => {
  const rawSelections = useMemo(
    () => readModelAddonSelections(value) ?? [],
    [value],
  );
  const selections = useMemo(
    () => reconcileMediaModelAddonSelections(model, addons, rawSelections),
    [addons, model, rawSelections],
  );
  useEffect(() => {
    if (mediaModelAddonSelectionsEqual(rawSelections, selections)) return;
    onChange(selections);
  }, [onChange, rawSelections, selections]);

  return (
    <div
      id={controlId}
      aria-describedby={describedBy}
      className="mt-2 space-y-3"
    >
      {model ? (
        <MediaAddonDialog
          model={model}
          addons={addons}
          assets={assets}
          metadata={metadata}
          categories={categories}
          selections={selections}
          onChange={onChange}
          disabled={disabled}
        />
      ) : (
        <p className="text-xs text-slate-500">Choose a model first</p>
      )}
    </div>
  );
};
