import type { FrontmatterValue } from "../types.js";

export const getSchedulerFrontmatterNumber = (
  attributes: Record<string, FrontmatterValue>,
  key: string,
): number | undefined => {
  const value = attributes[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const parsed = Number(value.trim());

  return Number.isFinite(parsed) ? parsed : undefined;
};
