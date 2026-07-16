import { ImagePlus, Images, Loader2, TriangleAlert } from "lucide-react";
import type { JSX } from "react";
import {
  isMediaAssetContextAttachment,
  isPathContextAttachment,
  type ChatSessionContextAttachment,
  type ChatSessionMediaAssetAttachment,
  type ChatSessionPathContextAttachment,
} from "../../chat-session.model";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";

export interface AttachmentImagePreview {
  attachment: ChatSessionContextAttachment;
  source: string | null;
  loading: boolean;
  error: string | null;
}

export interface AttachmentImagePreviewDialogProps {
  preview: AttachmentImagePreview | null;
  onOpenChange: (open: boolean) => void;
  onEditMediaAsset?: (attachment: ChatSessionMediaAssetAttachment) => void;
  onSaveToMediaLibrary?: (
    attachment: ChatSessionPathContextAttachment,
  ) => void;
}

export const AttachmentImagePreviewDialog = ({
  preview,
  onOpenChange,
  onEditMediaAsset,
  onSaveToMediaLibrary,
}: AttachmentImagePreviewDialogProps): JSX.Element => {
  const mediaAttachment =
    preview && isMediaAssetContextAttachment(preview.attachment)
      ? preview.attachment
      : null;
  const pathImageAttachment =
    preview &&
    isPathContextAttachment(preview.attachment) &&
    preview.attachment.kind === "image"
      ? preview.attachment
      : null;
  return (
    <Dialog open={Boolean(preview)} onOpenChange={onOpenChange}>
      {preview ? (
        <DialogContent className="app-attachment-image-preview w-[min(960px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
          <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
            <DialogTitle className="truncate text-base font-semibold text-white">
              {preview.attachment.name}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-xs text-slate-500">
              {isMediaAssetContextAttachment(preview.attachment)
                ? `Media Studio asset · ${preview.attachment.assetId}`
                : preview.attachment.path}
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-[calc(100vh-168px)] min-h-72 place-items-center overflow-auto bg-slate-950 p-4">
            {preview.loading ? (
              <div
                role="status"
                className="flex items-center gap-2 text-sm text-slate-400"
              >
                <Loader2 className="h-4 w-4 animate-spin text-sky-300" />
                Loading preview...
              </div>
            ) : preview.error ? (
              <div
                role="alert"
                className="flex max-w-lg items-start gap-3 rounded-lg border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-100"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
                <span>{preview.error}</span>
              </div>
            ) : preview.source ? (
              <img
                src={preview.source}
                alt={`Preview of ${preview.attachment.name}`}
                className="max-h-[calc(100vh-200px)] max-w-full object-contain"
              />
            ) : null}
          </div>
          {mediaAttachment && onEditMediaAsset ? (
            <div className="flex items-center justify-between gap-3 border-t border-slate-800/80 bg-slate-950 px-5 py-3">
              <p className="text-xs text-slate-500">
                Crop, resize, convert, retag, or inspect lineage without changing the source.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => onEditMediaAsset(mediaAttachment)}
                className="h-8 shrink-0 border-orange-400/25 bg-orange-500/10 px-3 text-xs text-orange-100 hover:bg-orange-500/15"
              >
                <Images className="h-3.5 w-3.5" /> Edit in Media Studio
              </Button>
            </div>
          ) : pathImageAttachment && onSaveToMediaLibrary ? (
            <div className="flex items-center justify-between gap-3 border-t border-slate-800/80 bg-slate-950 px-5 py-3">
              <p className="text-xs text-slate-500">
                Validate and ingest immutable bytes before using Media Studio transforms or lineage.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => onSaveToMediaLibrary(pathImageAttachment)}
                className="h-8 shrink-0 border-orange-400/25 bg-orange-500/10 px-3 text-xs text-orange-100 hover:bg-orange-500/15"
              >
                <ImagePlus className="h-3.5 w-3.5" /> Save to Media Library
              </Button>
            </div>
          ) : null}
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
