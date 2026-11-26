import { useEffect, useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import { Download, LoaderCircle, RotateCcw } from "lucide-react";
import type {
  MediaModelDescriptor,
  MediaModelInstallJob,
} from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import { ProgressBar } from "../../components/ui/progress-bar";
import { cn } from "../../lib/utils";
import {
  cancelMediaModelInstall,
  planMediaModelInstall,
  startMediaModelInstall,
} from "../media-runtime";
import {
  isMediaModelInstallJobActive,
  mediaDownloadMonitor,
} from "../media-download-monitor";
import { MediaExternalLink } from "./media-external-link";

const gigabytes = (bytes: number): string => `${(bytes / 1e9).toFixed(1)} GB`;

const progressLabel = (job: MediaModelInstallJob | undefined): string => {
  switch (job?.status) {
    case "queued":
      return "Queued";
    case "downloading":
      return job.bytesTotal > 0
        ? `${gigabytes(job.bytesDownloaded)} / ${gigabytes(job.bytesTotal)} · ${Math.floor(job.progress * 100)}%`
        : "Downloading…";
    case "verifying":
      return "Verifying…";
    case "activating":
      return "Installing…";
    case "canceling":
      return "Cancelling…";
    default:
      return "Starting…";
  }
};

const message = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

export const MediaModelDownload = ({
  model,
  onInstalled,
  children,
  size,
  variant,
  className,
}: {
  model: Pick<MediaModelDescriptor, "id" | "displayName" | "license">;
  onInstalled: () => Promise<void>;
  children: ReactNode;
  size?: "sm";
  variant?: "outline";
  className?: string;
}): JSX.Element => {
  const monitor = useSyncExternalStore(
    mediaDownloadMonitor.subscribe,
    mediaDownloadMonitor.getSnapshot,
  );
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishedJobId = useRef<string | null>(null);
  const runningJob = monitor.installJobs.find(
    (job) => job.modelId === model.id && isMediaModelInstallJobActive(job),
  );
  const trackedJob = jobId
    ? monitor.installJobs.find((job) => job.id === jobId)
    : undefined;
  const job = trackedJob ?? runningJob;
  const waiting = starting || (jobId !== null && trackedJob === undefined);
  const active = waiting || (job !== undefined && isMediaModelInstallJobActive(job));
  const installedJobId = job?.status === "installed" ? job.id : null;

  useEffect(() => {
    if (runningJob) setJobId(runningJob.id);
  }, [runningJob?.id]);

  useEffect(() => {
    if (!installedJobId || finishedJobId.current === installedJobId) return;
    finishedJobId.current = installedJobId;
    void onInstalled().catch(() =>
      setError("Could not refresh the model list. Reopen Media Studio."),
    );
  }, [installedJobId, onInstalled]);

  const start = async (): Promise<void> => {
    setStarting(true);
    setError(null);
    try {
      const plan = await planMediaModelInstall(model.id);
      if (plan.alreadyInstalled) {
        await onInstalled();
        return;
      }
      if (plan.hasSufficientSpace === false)
        throw new Error(
          `Free up ${gigabytes(plan.requiredWorkingBytes)} on the model drive, then retry.`,
        );
      const started =
        plan.activeJob ??
        (await startMediaModelInstall({
          modelId: model.id,
          reviewToken: plan.reviewToken,
          manifestDigest: plan.manifestDigest,
          licenseDigest: plan.licenseDigest,
          acceptLicense: true,
        }));
      setJobId(started.id);
      mediaDownloadMonitor.refresh();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!job) return;
    try {
      await cancelMediaModelInstall(job.id);
      mediaDownloadMonitor.refresh();
    } catch (failure) {
      setError(message(failure));
    }
  };

  if (active) {
    return (
      <div className={cn("flex min-w-0 items-center gap-3", className)}>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2 text-sm text-slate-200">
            <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-sky-300" />
            <span role="status" className="truncate tabular-nums">
              {model.displayName} · {progressLabel(waiting ? undefined : job)}
            </span>
          </div>
          <ProgressBar
            label="Download progress"
            value={job?.status === "downloading" && job.bytesTotal > 0 ? job.bytesDownloaded : null}
            max={job?.bytesTotal ?? 0}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={waiting || job?.status === "canceling"}
          onClick={() => void cancel()}
        >
          Cancel
        </Button>
      </div>
    );
  }

  const failed = job?.status === "failed" && job.id === jobId;
  const problem = error ?? (failed ? (job.error ?? "The download failed.") : null);
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      {problem ? (
        <p role="alert" className="text-sm text-rose-300">
          {problem}
        </p>
      ) : null}
      <Button
        type="button"
        variant={variant}
        size={size}
        className={size ? undefined : "w-full"}
        onClick={() => void start()}
      >
        {problem ? <RotateCcw className="h-4 w-4" /> : <Download className="h-4 w-4" />}
        {problem ? "Retry download" : children}
      </Button>
      {model.license.requiresAcceptance ? (
        <p className="text-xs text-slate-400">
          By downloading, you accept the{" "}
          <MediaExternalLink href={model.license.sourceUrl} className="text-sky-300 underline">
            {model.license.name}
          </MediaExternalLink>
          .
        </p>
      ) : null}
    </div>
  );
};
