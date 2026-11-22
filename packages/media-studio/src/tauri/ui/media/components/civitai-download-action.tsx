import { Check, Download, LoaderCircle, RotateCcw } from "lucide-react";
import {
  civitaiFileSize,
  type CivitaiInspection,
  type CivitaiStorage,
} from "../../../../core/media/civitai.js";
import { Button } from "../../components/ui/button";
import { ProgressBar } from "../../components/ui/progress-bar";
import { mediaImportQueue, type MediaImportJob } from "../media-import-queue";

const needsConnection = (message: string | null | undefined): boolean =>
  /API key|access|401|403/i.test(message ?? "");

function JobProgress({ job }: { job: MediaImportJob }) {
  const received = job.received ?? 0;
  const total = job.total ?? 0;
  const verifying = total > 0 && received >= total;
  const label =
    job.status === "queued"
      ? "Queued"
      : job.status === "importing"
        ? "Importing…"
        : job.cancelling
          ? "Cancelling…"
          : verifying
            ? "Verifying…"
            : total > 0
              ? `${civitaiFileSize(received)} / ${civitaiFileSize(total)} · ${Math.floor((received / total) * 100)}%`
              : "Starting…";
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center gap-2 text-sm text-slate-200">
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-sky-300" />
          <span role="status" className="truncate tabular-nums">
            {label}
          </span>
        </div>
        <ProgressBar
          label="Download progress"
          value={job.status === "downloading" && total > 0 ? received : null}
          max={total}
        />
      </div>
      {["queued", "downloading"].includes(job.status) && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={job.cancelling}
          onClick={() => mediaImportQueue.cancel(job.id)}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

export function CivitaiDownloadAction({
  fileSize,
  installed,
  inspecting,
  inspection,
  storage,
  error,
  job,
  onDownload,
  onRetry,
  onOpenSettings,
}: {
  fileSize: number | null;
  installed: boolean;
  inspecting: boolean;
  inspection: CivitaiInspection | null;
  storage: CivitaiStorage | null;
  error: string | null;
  job: MediaImportJob | undefined;
  onDownload: () => void;
  onRetry: () => void;
  onOpenSettings: () => void;
}) {
  const active =
    job && ["queued", "downloading", "importing"].includes(job.status);
  const done = installed || job?.status === "completed";
  const blockingReason = inspection?.canDownload
    ? storage?.blockingReason
    : inspection?.blockingReason;
  const failed = job?.status === "failed";
  const problem =
    failed
      ? (job.error ?? "The download failed.")
      : (error ?? blockingReason);
  return (
    <div className="sticky -bottom-4 -mx-4 space-y-3 border-t border-slate-800 bg-slate-950 px-4 py-3 sm:-bottom-5 sm:-mx-5 sm:px-5">
      {!done && !active && problem && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-rose-200"
        >
          <p className="min-w-0 flex-1">{problem}</p>
          {needsConnection(problem) && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenSettings}
            >
              Add API key
            </Button>
          )}
          {!failed && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              Check again
            </Button>
          )}
        </div>
      )}
      {!done && !active && !problem && storage?.warning && (
        <p role="status" className="text-sm text-amber-200">
          {storage.warning}
        </p>
      )}
      {active ? (
        <JobProgress job={job} />
      ) : failed ? (
        <Button className="w-full" onClick={() => mediaImportQueue.retry(job.id)}>
          <RotateCcw className="h-4 w-4" />
          Retry download
        </Button>
      ) : (
        <Button
          className="w-full"
          disabled={
            done ||
            inspecting ||
            !inspection?.canDownload ||
            !storage ||
            Boolean(storage.blockingReason)
          }
          onClick={onDownload}
        >
          {done ? (
            <Check className="h-4 w-4" />
          ) : inspecting ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {done
            ? "In library"
            : inspecting
              ? "Checking file…"
              : `Download${fileSize ? ` · ${civitaiFileSize(fileSize)}` : ""}`}
        </Button>
      )}
    </div>
  );
}
