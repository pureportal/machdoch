import { randomUUID } from "node:crypto";

export const normalizeRalphWatchId = (value: string | undefined): string => {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);

  return normalized || `watch-${randomUUID()}`;
};
