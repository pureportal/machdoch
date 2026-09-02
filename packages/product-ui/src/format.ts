export function formatRelativeTime(timestamp: number | undefined): string {
  if (timestamp === undefined) return "";
  if (!getTimestampDate(timestamp)) return "—";
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function formatDuration(startedAt: number, updatedAt: number): string {
  const duration = Math.max(0, updatedAt - startedAt);
  const seconds = Math.floor(duration / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`;
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1_024 ** 3).toFixed(1)} GB`;
}

export function formatTimestamp(
  timestamp: number | string | null | undefined,
): string {
  const date = getTimestampDate(timestamp);
  if (!date) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatTimestampDateTime(
  timestamp: number | string | null | undefined,
): string | undefined {
  return getTimestampDate(timestamp)?.toISOString();
}

function getTimestampDate(
  timestamp: number | string | null | undefined,
): Date | undefined {
  if (timestamp === undefined || timestamp === null || timestamp === "") {
    return undefined;
  }
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
