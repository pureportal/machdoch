export const normalizeSchedulerText = (
  value: string | undefined,
): string | undefined => {
  const normalized = value?.replace(/\s+/gu, " ").trim();

  return normalized ? normalized : undefined;
};

export const normalizeSchedulerTrimmedText = (
  value: string | undefined,
): string | undefined => {
  const normalized = value?.trim();

  return normalized ? normalized : undefined;
};

export const normalizeSchedulerMultilineText = (
  value: string | undefined,
): string => {
  return value?.trim() ?? "";
};

export const normalizeSchedulerPositiveInteger = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return Math.max(1, Math.trunc(value));
};

export const normalizeSchedulerPositiveNumber = (
  value: number | undefined,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }

  return value;
};

export const normalizeSchedulerOptionalPositiveInteger = (
  value: number | undefined,
): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }

  return Math.max(1, Math.trunc(value));
};
