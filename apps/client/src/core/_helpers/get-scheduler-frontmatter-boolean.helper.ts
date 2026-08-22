import type { FrontmatterValue } from "../types.js";

export const getSchedulerFrontmatterBoolean = (
  attributes: Record<string, FrontmatterValue | null | undefined>,
  key: string,
): boolean | undefined => {
  const value = attributes[key];

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();

  if (["true", "yes", "on", "1"].includes(normalized)) {
    return true;
  }

  if (["false", "no", "off", "0"].includes(normalized)) {
    return false;
  }

  return undefined;
};
