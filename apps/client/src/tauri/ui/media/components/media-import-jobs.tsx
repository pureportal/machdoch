import { LoaderCircle, X } from "lucide-react";
import { useSyncExternalStore, type JSX } from "react";
import { mediaImportQueue } from "../media-import-queue";
import { Button } from "../../components/ui/button";

export const MediaImportJobs = ({
  onOpen,
}: {
  onOpen: (resourceId: string) => void;
}): JSX.Element | null => {
  const jobs = useSyncExternalStore(
    mediaImportQueue.subscribe,
    mediaImportQueue.getSnapshot,
  );
  if (!jobs.length) return null;
  return (
    <section
      aria-label="Imports"
      className="max-h-48 shrink-0 overflow-y-auto border-b border-slate-800 px-5 py-2"
    >
      {jobs.map((job) => (
        <div
          key={job.id}
          className="flex flex-wrap items-center gap-3 py-2 text-xs"
        >
          {job.status === "importing" ? (
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-sky-300" />
          ) : null}
          <span className="min-w-0 flex-1 truncate text-slate-200">
            {job.label}
          </span>
          <span role="status" className="capitalize text-slate-400">
            {job.status === "completed" ? "Imported" : job.status}
          </span>
          {job.resourceId ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpen(job.resourceId!)}
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
              Retry import
            </Button>
          ) : null}
          {job.status !== "importing" ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${job.status === "queued" ? "Cancel" : "Dismiss"} import ${job.label}`}
              onClick={() => mediaImportQueue.dismiss(job.id)}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
          {job.error ? (
            <p role="alert" className="w-full text-rose-300">
              {job.error}
            </p>
          ) : null}
        </div>
      ))}
    </section>
  );
};
