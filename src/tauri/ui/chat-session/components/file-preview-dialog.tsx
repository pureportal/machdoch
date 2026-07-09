import {
  ExternalLink,
  FileText,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { useMemo, type JSX } from "react";
import type { FilePreviewLanguage } from "../_helpers/file-preview-language";
import { highlightFilePreviewContent } from "../_helpers/file-preview-highlight";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { cn } from "../../lib/utils";

export type FilePreviewMode = "image" | "pdf" | "text";

export interface FilePreview {
  title: string;
  path: string;
  mode: FilePreviewMode;
  loading: boolean;
  error: string | null;
  source: string | null;
  content: string | null;
  language: FilePreviewLanguage | null;
  languageLabel: string;
  truncated: boolean;
  lossy: boolean;
}

export interface FilePreviewDialogProps {
  preview: FilePreview | null;
  onOpenChange: (open: boolean) => void;
  onOpenExternal: () => void;
}

const FilePreviewStatus = ({
  preview,
}: {
  preview: FilePreview;
}): JSX.Element | null => {
  if (preview.mode !== "text" || preview.loading || preview.error) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-slate-500">
      <span className="rounded-full border border-slate-800 bg-slate-900/80 px-2 py-0.5 text-slate-300">
        {preview.languageLabel}
      </span>
      {preview.truncated ? <span>Preview truncated</span> : null}
      {preview.lossy ? <span>Encoding normalized</span> : null}
    </div>
  );
};

const TextPreviewContent = ({
  preview,
}: {
  preview: FilePreview;
}): JSX.Element => {
  const highlightedContent = useMemo(
    () =>
      preview.content === null
        ? null
        : highlightFilePreviewContent(preview.content, preview.language),
    [preview.content, preview.language],
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-slate-950">
      <pre
        aria-label={`Contents of ${preview.title}`}
        className={cn(
          "app-file-preview-code m-0 min-h-full w-max min-w-full select-text overflow-visible p-4 font-mono text-xs leading-5 text-slate-200",
          "whitespace-pre [tab-size:2]",
        )}
      >
        {highlightedContent ? (
          <code
            className={`language-${preview.language ?? "plaintext"}`}
            dangerouslySetInnerHTML={{ __html: highlightedContent }}
          />
        ) : (
          <code>{preview.content ?? ""}</code>
        )}
      </pre>
    </div>
  );
};

const PreviewBody = ({ preview }: { preview: FilePreview }): JSX.Element => {
  if (preview.loading) {
    return (
      <div
        role="status"
        className="flex min-h-72 items-center justify-center gap-2 text-sm text-slate-400"
      >
        <Loader2 className="h-4 w-4 animate-spin text-sky-300" />
        Loading preview...
      </div>
    );
  }

  if (preview.error) {
    return (
      <div className="grid min-h-72 place-items-center bg-slate-950 p-4">
        <div
          role="alert"
          className="flex max-w-lg items-start gap-3 rounded-lg border border-rose-500/25 bg-rose-500/10 p-4 text-sm text-rose-100"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
          <span>{preview.error}</span>
        </div>
      </div>
    );
  }

  if (preview.mode === "image" && preview.source) {
    return (
      <div className="grid min-h-72 place-items-center overflow-auto bg-slate-950 p-4">
        <img
          src={preview.source}
          alt={`Preview of ${preview.title}`}
          className="max-h-[calc(100vh-224px)] max-w-full object-contain"
        />
      </div>
    );
  }

  if (preview.mode === "pdf" && preview.source) {
    return (
      <iframe
        src={preview.source}
        title={`Preview of ${preview.title}`}
        className="min-h-[min(720px,calc(100vh-220px))] w-full flex-1 border-0 bg-slate-950"
      />
    );
  }

  if (preview.mode === "text") {
    return <TextPreviewContent preview={preview} />;
  }

  return (
    <div className="grid min-h-72 place-items-center bg-slate-950 p-4">
      <div className="flex max-w-lg items-start gap-3 rounded-lg border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
        <span>No in-app preview is available for this file.</span>
      </div>
    </div>
  );
};

export const FilePreviewDialog = ({
  preview,
  onOpenChange,
  onOpenExternal,
}: FilePreviewDialogProps): JSX.Element => {
  return (
    <Dialog open={Boolean(preview)} onOpenChange={onOpenChange}>
      {preview ? (
        <DialogContent className="app-file-preview-dialog flex h-[min(860px,calc(100vh-32px))] w-[min(1120px,calc(100vw-32px))] max-w-none flex-col gap-0 overflow-hidden rounded-xl border-slate-800 bg-slate-950 p-0 text-slate-100 shadow-2xl sm:max-w-none">
          <DialogHeader className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-4 border-b border-slate-800/80 px-5 py-4 pr-12 text-left">
            <div className="min-w-0">
              <DialogTitle className="truncate text-base font-semibold text-white">
                {preview.title}
              </DialogTitle>
              <DialogDescription className="truncate font-mono text-xs text-slate-500">
                {preview.path}
              </DialogDescription>
              <FilePreviewStatus preview={preview} />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenExternal}
              className="h-8 rounded-full border-slate-800 bg-slate-900/80 px-3 text-xs text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open externally
            </Button>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <PreviewBody preview={preview} />
          </div>
        </DialogContent>
      ) : null}
    </Dialog>
  );
};
