import type { FrontmatterValue } from "../types.js";
import { normalizeSchedulerTrimmedText } from "./normalize-scheduler-value.helper.js";

export const getSchedulerFrontmatterString = (
  attributes: Record<string, FrontmatterValue>,
  key: string,
): string | undefined => {
  const value = attributes[key];

  return typeof value === "string" ? normalizeSchedulerTrimmedText(value) : undefined;
};
