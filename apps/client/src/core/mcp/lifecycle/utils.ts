import { normalizeOptionalString } from "../../../helpers/normalize-optional-string.helper.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const optionalString = (value: unknown): string | undefined => {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
};

export const optionalNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const normalizeIsoTimestamp = (
  value: string | undefined,
  fallback: string,
): string => {
  if (!value) {
    return fallback;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
};

export const normalizeOptionalIsoTimestamp = (
  value: unknown,
  fallback: string,
): string | undefined => {
  const normalized = optionalString(value);
  return normalized ? normalizeIsoTimestamp(normalized, fallback) : undefined;
};

export const latestIso = (
  values: Array<string | undefined>,
): string | undefined => {
  let latest: string | undefined;
  let latestTime = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (!value) {
      continue;
    }

    const time = Date.parse(value);

    if (Number.isFinite(time) && time > latestTime) {
      latest = new Date(time).toISOString();
      latestTime = time;
    }
  }

  return latest;
};

export const ageDays = (now: Date, timestamp: string): number => {
  const parsed = Date.parse(timestamp);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.floor((now.getTime() - parsed) / MS_PER_DAY));
};

export const getDateOrNow = (value: Date | string | undefined): Date => {
  if (value instanceof Date) {
    return value;
  }

  if (value) {
    const parsed = Date.parse(value);

    if (Number.isFinite(parsed)) {
      return new Date(parsed);
    }
  }

  return new Date();
};
