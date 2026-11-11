export function formatTime(value: number | null): string {
  if (value === null) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1000));
}

export function formatRelativeTime(value: number | null): string {
  if (value === null) return "Never";
  const difference = value * 1000 - Date.now();
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const minutes = Math.round(difference / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(difference / 3_600_000);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(difference / 86_400_000), "day");
}

export function formatAge(value: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(value).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `${weeks}w ago`;
  return new Date(value).toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
