import { CheckCircle2, Clock3, Loader2, XCircle } from "lucide-react";
import { type JSX } from "react";

import type {
  SchedulerRunStatus,
  SchedulerScheduleSummary,
} from "@machdoch/fleet-protocol/scheduler-contract";

export const formatTimestamp = (
  timestamp: number | null | undefined,
): string => {
  if (!timestamp) {
    return "none";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
};

export const formatDuration = (
  milliseconds: number | null | undefined,
): string => {
  if (!milliseconds) {
    return "default";
  }

  if (milliseconds < 60_000) {
    return `${Math.round(milliseconds / 1_000)}s`;
  }

  if (milliseconds < 3_600_000) {
    return `${Math.round(milliseconds / 60_000)}m`;
  }

  return `${Math.round(milliseconds / 3_600_000)}h`;
};

export const formatSchedule = (
  schedule: SchedulerScheduleSummary | null,
  triggerLabel?: string,
): string => {
  if (!schedule) {
    return triggerLabel || "Event triggered";
  }

  switch (schedule.type) {
    case "cron":
      return `${schedule.expression} | ${schedule.timezone}`;
    case "interval":
      return `every ${formatDuration(schedule.intervalMs)}`;
    case "delay":
      return `at ${formatTimestamp(schedule.runAt)}`;
  }
};

export const getStatusBadgeClassName = (status: string): string => {
  switch (status) {
    case "active":
    case "succeeded":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
    case "paused":
    case "queued":
      return "border-amber-500/30 bg-amber-500/10 text-amber-100";
    case "running":
      return "border-sky-500/30 bg-sky-500/10 text-sky-100";
    case "failed":
    case "timed_out":
    case "expired":
      return "border-rose-500/30 bg-rose-500/10 text-rose-100";
    case "cancelled":
    case "deleted":
      return "border-slate-600 bg-slate-800 text-slate-300";
    default:
      return "border-slate-700 bg-slate-900 text-slate-300";
  }
};

export const getRunIcon = (status: SchedulerRunStatus): JSX.Element => {
  switch (status) {
    case "succeeded":
      return <CheckCircle2 className="h-4 w-4 text-emerald-300" />;
    case "failed":
    case "timed_out":
    case "expired":
      return <XCircle className="h-4 w-4 text-rose-300" />;
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-sky-300" />;
    default:
      return <Clock3 className="h-4 w-4 text-slate-400" />;
  }
};
