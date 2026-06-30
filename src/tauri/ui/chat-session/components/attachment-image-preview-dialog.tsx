import { Loader2, TriangleAlert } from "lucide-react";
import type { JSX } from "react";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
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
}

export const AttachmentImagePreviewDialog = ({
  preview,
  onOpenChange,
}: AttachmentImagePreviewDialogProps): JSX.Element => {
  return (
    <Dialog open={Boolean(preview)} onOpenChange={onOpenChange}>
      {preview ? (
        <DialogContent className="app-attachment-image-preview w-[min(960px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
          <DialogHeader className="border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
            <DialogTitle className="truncate text-base font-semibold text-white">
              {preview.attachment.name}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-xs text-slate-500">
              {preview.attachment.path}
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
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
