import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { ContextActionMenu } from "../../components/ui/context-action-menu";
import { MediaSaveAssetButton } from "./media-save-asset-button";
import { MediaAssetPreview } from "./media-visual-preview";

export function MediaUpscalePreview({
  asset,
  title,
  onUpscale,
}: {
  asset: MediaAssetRecord;
  title: string;
  onUpscale?: () => void;
}) {
  const preview = (
    <article className="min-w-0 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/50">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
        <h2 className="text-sm font-medium text-slate-200">{title}</h2>
        <span className="text-xs tabular-nums text-slate-400">
          {asset.width} × {asset.height}
        </span>
      </header>
      <MediaAssetPreview
        asset={asset}
        controls={asset.kind === "video"}
        fit="contain"
        className="aspect-[4/3] max-h-[28rem] w-full bg-slate-950"
      />
      {onUpscale ? (
        <footer className="border-t border-slate-800 p-3">
          <MediaSaveAssetButton asset={asset} />
        </footer>
      ) : null}
    </article>
  );
  return onUpscale ? (
    <ContextActionMenu
      label="Upscaled media actions"
      actions={[{ label: "Upscale", onSelect: onUpscale }]}
    >
      {preview}
    </ContextActionMenu>
  ) : (
    preview
  );
}
