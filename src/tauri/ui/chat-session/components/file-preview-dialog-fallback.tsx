import { ExternalLink, Loader2, X } from "lucide-react";
import type { JSX } from "react";
import { Button } from "../../components/ui/button";
import type { FilePreview } from "./file-preview-dialog";

export interface FilePreviewDialogFallbackProps {
  preview: FilePreview;
  onOpenChange: (open: boolean) => void;
  onOpenExternal: () => void;
}

export const FilePreviewDialogFallback = ({
  preview,
  onOpenChange,
  onOpenExternal,
}: FilePreviewDialogFallbackProps): JSX.Element => {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${preview.title}`}
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
    >
      <div className="relative flex w-[min(720px,calc(100vw-32px))] items-start justify-between gap-4 rounded-xl border border-slate-800 bg-slate-950 p-5 pr-14 text-slate-100 shadow-2xl">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-white">
            {preview.title}
          </h2>
          <p className="truncate font-mono text-xs text-slate-500">
            {preview.path}
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span className="rounded-full border border-slate-800 bg-slate-900/80 px-2 py-0.5 text-slate-300">
              {preview.languageLabel}
            </span>
            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-300" />
            Loading preview...
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenExternal}
          className="h-8 shrink-0 rounded-full border-slate-800 bg-slate-900/80 px-3 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open externally
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close"
          onClick={() => onOpenChange(false)}
          className="absolute top-3 right-3 h-8 w-8 rounded-full text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
};
