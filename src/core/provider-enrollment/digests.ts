import { createHash } from "node:crypto";

export const sha256 = (value: string | NodeJS.ArrayBufferView): string => {
  return createHash("sha256").update(value).digest("hex");
};

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  );
};

export const stableJson = (value: unknown): string => {
  return JSON.stringify(sortValue(value));
};

export const digestJson = (value: unknown): string => {
  return sha256(stableJson(value));
};
