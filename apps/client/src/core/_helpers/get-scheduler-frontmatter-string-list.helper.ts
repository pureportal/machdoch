import { normalizeStringList } from "../../helpers/normalize-string-list.helper.js";
import type { FrontmatterValue } from "../types.js";

export const getSchedulerFrontmatterStringList = (
  attributes: Record<string, FrontmatterValue | null | undefined>,
  key: string,
): string[] => {
  const value = attributes[key];

  if (Array.isArray(value)) {
    return normalizeStringList(value);
  }

  if (typeof value === "string") {
    return normalizeStringList(value.split(","));
  }

  return [];
};
