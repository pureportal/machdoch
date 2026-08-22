import type { RalphRunRecord } from "../../../../core/ralph.js";

export const formatDurationMs = (durationMs: number): string => {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }

  if (durationMs < 1_000) {
    return `${Math.round(durationMs)}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${hours}h ${remainingMinutes}m`;
};

export const getTimestampMs = (
  timestamp: string | null | undefined,
): number | null => {
  if (!timestamp) {
    return null;
  }

  const time = Date.parse(timestamp);

  return Number.isFinite(time) ? time : null;
};

export const formatRunRecordDuration = (
  record: Pick<RalphRunRecord, "createdAt" | "finishedAt">,
): string | null => {
  const startedAt = getTimestampMs(record.createdAt);
  const finishedAt = getTimestampMs(record.finishedAt);

  return startedAt !== null && finishedAt !== null
    ? formatDurationMs(finishedAt - startedAt)
    : null;
};
