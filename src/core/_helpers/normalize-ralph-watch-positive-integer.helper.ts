export const normalizeRalphWatchPositiveInteger = (
  value: number | undefined,
  fallback: number,
): number => {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? Math.trunc(value)
    : fallback;
};
