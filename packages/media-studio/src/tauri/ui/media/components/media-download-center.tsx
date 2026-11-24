import { useState, useSyncExternalStore, type JSX } from "react";
import {
  Box,
  CheckCircle2,
  Cpu,
  Download,
  ExternalLink,
  Layers,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
  X,
} from "lucide-react";
import type { MediaModelInstallJob } from "../../../../core/media/contracts.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ProgressBar } from "../../components/ui/progress-bar";
import { ControlTooltip } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import {
  isMediaModelInstallJobActive,
  mediaDownloadMonitor,
  mediaDownloadSourceLabel,
} from "../media-download-monitor";
import { mediaImportQueue, type MediaImportJob } from "../media-import-queue";
import { cancelMediaModelInstall } from "../media-runtime";
import {
  isMediaRuntimeSetupActive,
  mediaRuntimeSetupLabel,
  startMediaRuntimeSetup,
  type MediaRuntimeSetupStatus,
} from "../media-runtime-setup";
import { MediaExternalLink } from "./media-external-link";
import { MediaModelInstallDialog } from "./media-model-install-dialog";

type DownloadKind = "model" | "civitai" | "runtime";
type DownloadState = "queued" | "active" | "finishing" | "done" | "failed" | "canceled";

interface DownloadEntry {
  key: string;
  kind: DownloadKind;
  name: string;
  sourceUrl: string | null;
  state: DownloadState;
  status: string;
  received: number | null;
  total: number | null;
  bytesPerSecond: number | null;
  detail: string | null;
  error: string | null;
  canceling: boolean;
  onCancel?: () => void;
  onRetry?: () => void;
  onDismiss?: () => void;
}

const RUNTIME_SOURCE_URL = "https://pypi.org";
const dismissedKeys = new Set<string>();

const formatBytes = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
};

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min left`;
};

const KIND_ICONS: Record<DownloadKind, typeof Box> = {
  model: Box,
  civitai: Layers,
  runtime: Cpu,
};

const installEntry = (
  job: MediaModelInstallJob,
  bytesPerSecond: number | undefined,
  onRetry: (job: MediaModelInstallJob) => void,
): DownloadEntry => {
  const active = isMediaModelInstallJobActive(job);
  const state: DownloadState =
    job.status === "queued"
      ? "queued"
      : job.status === "downloading"
        ? "active"
        : job.status === "verifying" || job.status === "activating" || job.status === "canceling"
          ? "finishing"
          : job.status === "installed"
            ? "done"
            : job.status === "failed"
              ? "failed"
              : "canceled";
  const status =
    job.status === "queued"
      ? "Queued"
      : job.status === "downloading"
        ? `File ${Math.min(job.filesTotal, job.filesCompleted + 1)} of ${job.filesTotal}`
        : job.status === "verifying"
          ? "Verifying files"
          : job.status === "activating"
            ? "Installing"
            : job.status === "canceling"
              ? "Canceling"
              : job.status === "installed"
                ? "Installed"
                : job.status === "failed"
                  ? "Failed"
                  : "Canceled";
  const key = `model:${job.id}`;
  return {
    key,
    kind: "model",
    name: job.displayName,
    sourceUrl: job.sourceUrl || null,
    state,
    status,
    received: job.bytesDownloaded,
    total: job.bytesTotal,
    bytesPerSecond: bytesPerSecond ?? null,
    detail: active ? job.currentFile : null,
    error: job.status === "failed" ? (job.failure?.message ?? job.error) : null,
    canceling: job.status === "canceling",
    ...(active
      ? {
          onCancel: () =>
            void cancelMediaModelInstall(job.id).finally(() => mediaDownloadMonitor.refresh()),
        }
      : { onDismiss: () => dismissedKeys.add(key) }),
    ...(job.status === "failed" || job.status === "canceled" ? { onRetry: () => onRetry(job) } : {}),
  };
};

const civitaiEntry = (job: MediaImportJob): DownloadEntry => {
  const verifying =
    job.status === "downloading" && Boolean(job.total) && (job.received ?? 0) >= (job.total ?? 0);
  const state: DownloadState =
    job.status === "queued"
      ? "queued"
      : job.status === "downloading"
        ? verifying
          ? "finishing"
          : "active"
        : job.status === "importing"
          ? "finishing"
          : job.status === "completed"
            ? "done"
            : job.status === "failed"
              ? "failed"
              : "canceled";
  const status =
    job.cancelling && job.status === "downloading"
      ? "Canceling"
      : job.status === "queued"
        ? "Queued"
        : job.status === "downloading"
          ? verifying
            ? "Verifying"
            : "Downloading"
          : job.status === "importing"
            ? "Adding to library"
            : job.status === "completed"
              ? "In library"
              : job.status === "failed"
                ? "Failed"
                : "Canceled";
  const active = ["queued", "downloading"].includes(job.status);
  return {
    key: `civitai:${job.id}`,
    kind: "civitai",
    name: job.label,
    sourceUrl: job.sourceUrl ?? null,
    state,
    status,
    received: job.received ?? null,
    total: job.total ?? null,
    bytesPerSecond: job.bytesPerSecond ?? null,
    detail: job.warning && !["completed", "cancelled"].includes(job.status) ? job.warning : null,
    error: job.error,
    canceling: job.cancelling === true,
    ...(active ? { onCancel: () => mediaImportQueue.cancel(job.id) } : {}),
    ...(job.status === "failed" ? { onRetry: () => mediaImportQueue.retry(job.id) } : {}),
    ...(!active && job.status !== "importing"
      ? { onDismiss: () => mediaImportQueue.dismiss(job.id) }
      : {}),
  };
};

const runtimeEntry = (status: MediaRuntimeSetupStatus): DownloadEntry | null => {
  const active = isMediaRuntimeSetupActive(status);
  if (!active && status.phase !== "failed") return null;
  const key = "runtime";
  return {
    key,
    kind: "runtime",
    name: "Media Studio runtime",
    sourceUrl: RUNTIME_SOURCE_URL,
    state: active ? (status.phase === "downloading" ? "active" : "finishing") : "failed",
    status: active ? mediaRuntimeSetupLabel(status) : "Failed",
    received: status.downloadPercent,
    total: status.downloadPercent === null ? null : 100,
    bytesPerSecond: null,
    detail: active ? status.message || null : null,
    error: status.phase === "failed" ? status.message || status.diagnostic : null,
    canceling: false,
    ...(active
      ? {}
      : {
          onRetry: () =>
            void startMediaRuntimeSetup().finally(() => mediaDownloadMonitor.refresh()),
          onDismiss: () => dismissedKeys.add(key),
        }),
  };
};

const DownloadRow = ({ entry }: { entry: DownloadEntry }): JSX.Element => {
  const Icon = KIND_ICONS[entry.kind];
  const running = entry.state === "active" || entry.state === "finishing";
  const bytes = entry.kind !== "runtime" && entry.total ? entry.total : null;
  const remaining =
    entry.state === "active" && bytes && entry.received !== null && entry.bytesPerSecond
      ? (bytes - entry.received) / entry.bytesPerSecond
      : null;
  const summary = [
    bytes && entry.received !== null
      ? entry.state === "done"
        ? formatBytes(bytes)
        : `${formatBytes(entry.received)} of ${formatBytes(bytes)}`
      : null,
    entry.state === "active" && entry.bytesPerSecond ? `${formatBytes(entry.bytesPerSecond)}/s` : null,
    remaining !== null && Number.isFinite(remaining) ? formatDuration(remaining) : null,
  ].filter(Boolean);
  return (
    <li
      data-download-kind={entry.kind}
      data-download-state={entry.state}
      className="flex gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4"
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-lg",
          entry.state === "failed"
            ? "bg-rose-500/10 text-rose-300"
            : entry.state === "done"
              ? "bg-emerald-500/10 text-emerald-300"
              : "bg-sky-500/10 text-sky-300",
        )}
      >
        <Icon className="size-5" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-slate-100">{entry.name}</p>
            {entry.sourceUrl ? (
              <MediaExternalLink
                href={entry.sourceUrl}
                className="inline-flex max-w-full items-center gap-1 truncate text-xs text-slate-400 hover:text-sky-300"
              >
                <span className="truncate">{mediaDownloadSourceLabel(entry.sourceUrl)}</span>
                <ExternalLink className="size-3 shrink-0" />
              </MediaExternalLink>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {entry.onRetry ? (
              <Button variant="outline" size="sm" onClick={entry.onRetry}>
                <RotateCcw className="size-3.5" />
                Retry
              </Button>
            ) : null}
            {entry.onCancel ? (
              <Button variant="outline" size="sm" disabled={entry.canceling} onClick={entry.onCancel}>
                Cancel
              </Button>
            ) : null}
            {entry.onDismiss ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${entry.name} from list`}
                tooltip="Remove from list"
                onClick={entry.onDismiss}
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>
        {running || entry.state === "queued" ? (
          <ProgressBar
            label={`${entry.name} progress`}
            value={entry.state === "active" && entry.total ? entry.received : null}
            max={entry.total ?? 0}
          />
        ) : null}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
          <span
            role="status"
            className={cn(
              "inline-flex items-center gap-1",
              entry.state === "done" && "text-emerald-300",
              entry.state === "failed" && "text-rose-300",
            )}
          >
            {running ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {entry.state === "done" ? <CheckCircle2 className="size-3" /> : null}
            {entry.state === "failed" ? <TriangleAlert className="size-3" /> : null}
            {entry.status}
          </span>
          {summary.map((part) => (
            <span key={part} className="tabular-nums">
              · {part}
            </span>
          ))}
        </p>
        {entry.detail ? <p className="truncate text-xs text-slate-500">{entry.detail}</p> : null}
        {entry.error ? (
          <p role="alert" className="text-xs text-rose-300">
            {entry.error}
          </p>
        ) : null}
      </div>
    </li>
  );
};

const STATE_ORDER: Record<DownloadState, number> = {
  active: 0,
  finishing: 1,
  queued: 2,
  failed: 3,
  done: 4,
  canceled: 5,
};

export const MediaDownloadCenter = (): JSX.Element | null => {
  const [open, setOpen] = useState(false);
  const [, setDismissals] = useState(0);
  const [retryJob, setRetryJob] = useState<MediaModelInstallJob | null>(null);
  const monitor = useSyncExternalStore(mediaDownloadMonitor.subscribe, mediaDownloadMonitor.getSnapshot);
  const importJobs = useSyncExternalStore(mediaImportQueue.subscribe, mediaImportQueue.getSnapshot);
  const runtime = runtimeEntry(monitor.runtimeSetup);
  const entries = [
    ...monitor.installJobs
      .filter((job, index, jobs) => jobs.findIndex((other) => other.modelId === job.modelId) === index)
      .map((job) => installEntry(job, monitor.bytesPerSecond[job.id], setRetryJob)),
    ...importJobs.filter((job) => job.downloadKey).map(civitaiEntry),
    ...(runtime ? [runtime] : []),
  ]
    .filter((entry) => !dismissedKeys.has(entry.key))
    .map((entry) =>
      entry.onDismiss
        ? {
            ...entry,
            onDismiss: () => {
              entry.onDismiss?.();
              setDismissals((count) => count + 1);
            },
          }
        : entry,
    )
    .sort((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state]);
  if (entries.length === 0 && !retryJob) return null;
  const activeEntries = entries.filter((entry) => ["active", "finishing", "queued"].includes(entry.state));
  const failedCount = entries.filter((entry) => entry.state === "failed").length;
  const measured = activeEntries.filter((entry) => entry.kind !== "runtime" && entry.total);
  const totalBytes = measured.reduce((sum, entry) => sum + (entry.total ?? 0), 0);
  const receivedBytes = measured.reduce((sum, entry) => sum + (entry.received ?? 0), 0);
  const overall = totalBytes > 0 ? receivedBytes / totalBytes : null;
  const finished = entries.filter((entry) => entry.onDismiss && !entry.onCancel);
  return (
    <>
      <ControlTooltip
        side="bottom"
        content={
          activeEntries.length
            ? `${activeEntries.length} downloading${overall === null ? "" : ` · ${Math.round(overall * 100)}%`}`
            : "Downloads"
        }
      >
        <button
          type="button"
          aria-label={`Downloads, ${activeEntries.length} active${failedCount ? `, ${failedCount} failed` : ""}`}
          onClick={() => setOpen(true)}
          className="pointer-events-auto relative inline-flex h-7 w-7 items-center justify-center rounded-lg text-slate-300 transition-colors hover:bg-slate-800 hover:text-slate-100"
          data-tauri-no-drag
        >
          {activeEntries.length ? (
            <svg aria-hidden="true" viewBox="0 0 28 28" className="absolute inset-0 size-7 -rotate-90">
              <circle cx="14" cy="14" r="11" fill="none" strokeWidth="2" className="stroke-slate-800" />
              <circle
                cx="14"
                cy="14"
                r="11"
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                pathLength={100}
                strokeDasharray={`${Math.max(4, (overall ?? 0.25) * 100)} 100`}
                className={cn("stroke-sky-400 transition-[stroke-dasharray] duration-500", overall === null && "animate-spin origin-center")}
              />
            </svg>
          ) : null}
          <Download className="relative size-3.5" />
          {failedCount ? (
            <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-rose-400" />
          ) : activeEntries.length > 1 ? (
            <span className="absolute -top-1 -right-1 min-w-4 rounded-full bg-sky-500 px-1 text-[9px] font-semibold leading-4 text-white tabular-nums">
              {activeEntries.length}
            </span>
          ) : null}
        </button>
      </ControlTooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className="flex max-h-[min(760px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden border-slate-700 bg-slate-950 p-0 text-slate-100 sm:max-w-2xl"
        >
          <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12">
            <DialogTitle>Downloads</DialogTitle>
            {totalBytes > 0 ? (
              <div className="space-y-1.5 pt-2">
                <ProgressBar label="All downloads" value={receivedBytes} max={totalBytes} />
                <p className="text-xs tabular-nums text-slate-400">
                  {formatBytes(receivedBytes)} of {formatBytes(totalBytes)}
                </p>
              </div>
            ) : null}
          </DialogHeader>
          <ul aria-label="Downloads" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
            {entries.map((entry) => (
              <DownloadRow key={entry.key} entry={entry} />
            ))}
          </ul>
          {finished.length > 1 ? (
            <div className="flex justify-end border-t border-slate-800 px-5 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  for (const entry of finished) entry.onDismiss?.();
                }}
              >
                Clear finished
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      {retryJob ? (
        <MediaModelInstallDialog
          key={retryJob.id}
          model={{ id: retryJob.modelId, displayName: retryJob.displayName }}
          onClose={() => {
            setRetryJob(null);
            mediaDownloadMonitor.refresh();
          }}
          onInstalled={async () => mediaDownloadMonitor.refresh()}
        />
      ) : null}
    </>
  );
};
