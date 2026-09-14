import type { JSX, ReactNode } from "react";
import type { MediaAssetRecord } from "../../../../core/media/contracts.js";
import { mediaAssetLabel } from "../../../../core/media/asset-label.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { MediaAssetPreview } from "./media-visual-preview";
import { MediaSaveAssetButton } from "./media-save-asset-button";

export const MediaAssetDetailsDialog = ({
  asset,
  onClose,
  onEdit,
  onUseAsReference,
  onAnimate,
  onInspectSettings,
  onReuseSettings,
  children,
}: {
  asset: MediaAssetRecord;
  onClose: () => void;
  onEdit: (asset: MediaAssetRecord) => void;
  onUseAsReference: (asset: MediaAssetRecord) => void;
  onAnimate: (asset: MediaAssetRecord) => void;
  onInspectSettings: (runId: string) => void;
  onReuseSettings: (runId: string) => void;
  children: ReactNode;
}): JSX.Element => (
  <Dialog
    open
    onOpenChange={(open) => {
      if (!open) onClose();
    }}
  >
    <DialogContent
      aria-describedby={undefined}
      className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-6xl"
    >
      <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12">
        <DialogTitle>{mediaAssetLabel(asset)}</DialogTitle>
      </DialogHeader>
      <div className="grid min-h-0 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_300px]">
        <MediaAssetPreview
          key={asset.id}
          asset={asset}
          maxEdge={2048}
          controls={asset.kind === "video"}
          fit="contain"
          className="h-[min(65dvh,720px)] min-h-48 w-full bg-slate-950"
        />
        <div className="min-w-0 space-y-4 border-t border-slate-800 p-4 lg:border-l lg:border-t-0">
          <p className="text-xs text-slate-400">
            {asset.width} × {asset.height}
          </p>
          <MediaSaveAssetButton key={asset.id} asset={asset} />
          {asset.kind === "image" ? (
            <div className="grid gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onEdit(asset)}
              >
                Edit image
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onUseAsReference(asset)}
              >
                Use as reference
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onAnimate(asset)}
              >
                Animate image
              </Button>
            </div>
          ) : null}
          {asset.operation?.kind !== "local-import" ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onInspectSettings(asset.runId)}
              >
                View settings
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onReuseSettings(asset.runId)}
              >
                Reuse settings
              </Button>
            </div>
          ) : null}
          {children}
        </div>
      </div>
    </DialogContent>
  </Dialog>
);
