import type { JSX } from "react";
import { ImagePlus, X } from "lucide-react";
import type {
  ImageRecipeSettings,
  MediaAssetRecord,
  MediaAssetCategory,
  MediaGenerationAssetMetadata,
} from "../../../../core/media/contracts.js";
import { MediaAssetBrowser } from "./media-asset-browser";
import { ControlTooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { MediaAssetPreview } from "./media-visual-preview";
import { MediaImageMaskEditor } from "./media-image-mask-editor";

export const MediaBasicBaseImage = ({
  settings,
  visualReferenceAssets,
  metadata,
  categories,
  baseImageSupported,
  maskSupported,
  referenceImportSupported,
  referenceImportPending,
  assetPickerOpen,
  onAssetPickerChange,
  onAddBaseImage,
  onChange,
  onMaskContentChange,
}: {
  settings: ImageRecipeSettings;
  visualReferenceAssets: readonly MediaAssetRecord[];
  metadata: Readonly<Record<string, MediaGenerationAssetMetadata>>;
  categories: readonly MediaAssetCategory[];
  baseImageSupported: boolean;
  maskSupported: boolean;
  referenceImportSupported: boolean;
  referenceImportPending: boolean;
  assetPickerOpen: boolean;
  onAssetPickerChange: (open: boolean) => void;
  onAddBaseImage: () => void;
  onChange: (settings: ImageRecipeSettings) => void;
  onMaskContentChange: (hasContent: boolean) => void;
}): JSX.Element => {
  const baseImageAsset =
    visualReferenceAssets.find(
      (asset) => asset.id === settings.baseImageAssetId,
    ) ?? null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-slate-200">Base image</h2>
        {visualReferenceAssets.some((asset) => asset.kind === "image") ? (
          <button
            type="button"
            aria-expanded={assetPickerOpen}
            disabled={!baseImageSupported}
            onClick={() => onAssetPickerChange(!assetPickerOpen)}
            className="shrink-0 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-sky-300 hover:bg-slate-800 hover:text-sky-200 disabled:opacity-40"
          >
            {assetPickerOpen ? "Close" : "Choose from Assets"}
          </button>
        ) : null}
      </div>
      <div className="flex min-h-11 gap-2">
        {settings.baseImageAssetId ? (
          <div className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-xl border border-slate-700">
            {baseImageAsset ? (
              <MediaAssetPreview
                asset={baseImageAsset}
                className="h-full w-full"
              />
            ) : (
              <span className="text-xs text-slate-400">Image unavailable</span>
            )}
            <ControlTooltip content="Remove base image">
              <button
                type="button"
                aria-label="Remove base image"
                onClick={() =>
                  onChange({
                    ...settings,
                    baseImageAssetId: null,
                    editMask: null,
                  })
                }
                className="absolute top-1 right-1 rounded-md bg-slate-950/85 p-1.5 text-slate-200"
              >
                <X className="h-4 w-4" />
              </button>
            </ControlTooltip>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Add base image"
            onClick={onAddBaseImage}
            disabled={
              !baseImageSupported ||
              !referenceImportSupported ||
              referenceImportPending
            }
            className="flex h-24 w-24 shrink-0 flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-slate-700 text-slate-400 hover:border-sky-500 hover:text-sky-300 disabled:opacity-40"
          >
            <ImagePlus className="h-5 w-5" />
            <span className="text-xs">Add image</span>
          </button>
        )}
      </div>
      {settings.baseImageAssetId && baseImageSupported ? (
        <button
          type="button"
          disabled={referenceImportPending || !referenceImportSupported}
          onClick={onAddBaseImage}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-sky-300 hover:bg-slate-800"
        >
          Replace base image
        </button>
      ) : null}
      {assetPickerOpen ? (
        <MediaAssetBrowser
          assets={visualReferenceAssets}
          metadata={metadata}
          categories={categories}
          selectedIds={
            settings.baseImageAssetId ? [settings.baseImageAssetId] : []
          }
          onSelect={(asset) => {
            onChange({
              ...settings,
              baseImageAssetId: asset.id,
              poseImageAssetId:
                settings.poseImageAssetId === asset.id
                  ? null
                  : settings.poseImageAssetId,
              referenceImages: settings.referenceImages.filter(
                (reference) => reference.assetId !== asset.id,
              ),
              editMask: null,
            });
            onAssetPickerChange(false);
          }}
        />
      ) : null}
      {baseImageAsset ? (
        <>
          <div className="grid grid-cols-2 rounded-xl border border-slate-800 bg-slate-900/70 p-1">
            <button
              type="button"
              aria-pressed={settings.editMask === null}
              onClick={() => onChange({ ...settings, editMask: null })}
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-medium",
                settings.editMask === null
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:text-slate-100",
              )}
            >
              Full image
            </button>
            <button
              type="button"
              aria-pressed={settings.editMask !== null}
              disabled={!maskSupported || settings.transparentBackground}
              title={
                !maskSupported
                  ? "This model does not support masks"
                  : settings.transparentBackground
                    ? "Turn off transparency to edit a masked area"
                    : undefined
              }
              onClick={() =>
                onChange({
                  ...settings,
                  editMask:
                    settings.editMask ??
                    ({
                      schemaVersion: 2,
                      sourceAssetId: baseImageAsset.id,
                      inverted: false,
                      strokes: [],
                    } as const),
                  editStrength: settings.editMask ? settings.editStrength : 1,
                  outputFormat: "png",
                })
              }
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-medium",
                settings.editMask !== null
                  ? "bg-slate-700 text-white"
                  : "text-slate-400 hover:text-slate-100",
              )}
            >
              Mask area
            </button>
          </div>
          {settings.editMask ? (
            <MediaImageMaskEditor
              asset={baseImageAsset}
              value={settings.editMask}
              onSelectionContentChange={onMaskContentChange}
              onChange={(editMask) => onChange({ ...settings, editMask })}
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
};
