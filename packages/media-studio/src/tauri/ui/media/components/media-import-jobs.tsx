import { Download, LoaderCircle, X } from "lucide-react";
import { useState, useSyncExternalStore, type JSX } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { mediaImportQueue } from "../media-import-queue";
import { Button } from "../../components/ui/button";
import { civitaiFileSize } from "../../../../core/media/civitai.js";

export const MediaImportJobs = ({
  onOpen,
  downloadsOnly = false,
}: {
  onOpen?: (resourceId: string) => void;
  downloadsOnly?: boolean;
}): JSX.Element | null => {
  const [open, setOpen] = useState(false);
  const jobs = useSyncExternalStore(
    mediaImportQueue.subscribe,
    mediaImportQueue.getSnapshot,
  );
  const visibleJobs = downloadsOnly
    ? jobs.filter((job) => job.downloadKey)
    : jobs;
  const activeCount = visibleJobs.filter((job) => ["queued", "downloading", "importing"].includes(job.status)).length;
  const failedCount = visibleJobs.filter((job) => job.status === "failed").length;
  return (
    <Popover open={open && visibleJobs.length > 0} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={!visibleJobs.length} aria-label={`Downloads and imports, ${activeCount} active${failedCount ? `, ${failedCount} failed` : ""}`}>
          {activeCount ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Downloads
          <span className={failedCount ? "text-rose-300 tabular-nums" : "tabular-nums"}>{activeCount || failedCount || visibleJobs.length}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 max-h-[min(28rem,var(--radix-popover-content-available-height))] border-slate-700 bg-slate-950 p-4 text-slate-100">
      <section aria-label="Downloads and imports">
      <h3 className="py-1 text-xs font-medium text-slate-300">
        {downloadsOnly ? "Downloads" : "Downloads and imports"}
      </h3>
      {visibleJobs.map((job) => (
        <div
          key={job.id}
          className="flex flex-wrap items-center gap-3 py-2 text-xs"
        >
          {["downloading", "importing"].includes(job.status) ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-sky-300" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-slate-200">
            {job.label}
          </span>
          <span role="status" className="capitalize text-slate-400">
            {job.cancelling && job.status === "downloading"
              ? "Cancelling…"
              : job.status === "completed"
                ? "Imported"
                : job.status === "downloading" &&
                    job.total &&
                    (job.received ?? 0) >= job.total
                  ? "Verifying…"
                  : job.status}
          </span>
          {job.resourceId && onOpen ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setOpen(false); onOpen(job.resourceId!); }}
            >
              View
            </Button>
          ) : null}
          {job.status === "failed" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => mediaImportQueue.retry(job.id)}
            >
              Retry
            </Button>
          ) : null}
          {job.status === "downloading" || job.status === "queued" ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={job.cancelling}
              onClick={() => mediaImportQueue.cancel(job.id)}
            >
              Cancel
            </Button>
          ) : job.status !== "importing" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Dismiss ${job.label}`}
              onClick={() => mediaImportQueue.dismiss(job.id)}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
          {job.status === "downloading" && Boolean(job.total) ? (
            <div className="w-full space-y-1">
              <progress
                aria-label={`Download ${job.label}`}
                value={job.received ?? 0}
                max={job.total}
                className="h-1.5 w-full accent-sky-400"
              />
              <span className="text-slate-400">
                {civitaiFileSize(job.received ?? 0)} /{" "}
                {civitaiFileSize(job.total!)}
              </span>
            </div>
          ) : null}
          {job.warning && !["completed", "cancelled"].includes(job.status) ? (
            <p role="status" className="w-full text-amber-200">
              {job.warning}
            </p>
          ) : null}
          {job.error ? (
            <p role="alert" className="w-full text-rose-300">
              {job.error}
            </p>
          ) : null}
        </div>
      ))}
    </section>
      </PopoverContent>
    </Popover>
  );
};
