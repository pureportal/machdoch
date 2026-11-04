const RELATIVE_UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

export const formatWorkspaceGitTime = (
  value: string,
  now = Date.now(),
): string => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.round((timestamp - now) / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) {
      return relativeFormatter.format(Math.round(seconds / size), unit);
    }
  }
  return relativeFormatter.format(0, "minute");
};
