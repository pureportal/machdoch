import type { RalphAttachmentReference } from "../ralph.js";

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const coerceRalphAttachmentKind = (
  value: unknown,
): RalphAttachmentReference["kind"] | undefined => {
  return value === "file" ||
    value === "directory" ||
    value === "image" ||
    value === "other"
    ? value
    : undefined;
};

export const coerceRalphAttachmentReferences = (
  value: unknown,
): RalphAttachmentReference[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): RalphAttachmentReference[] => {
    if (!isRecord(entry)) {
      return [];
    }

    const source = entry.source === "variable" ? "variable" : "path";
    const rawValue = typeof entry.value === "string" ? entry.value : "";
    const kind = coerceRalphAttachmentKind(entry.kind);

    if (!rawValue.trim()) {
      return [];
    }

    return [
      {
        source,
        value: rawValue,
        ...(typeof entry.id === "string" ? { id: entry.id } : {}),
        ...(kind ? { kind } : {}),
        ...(typeof entry.mediaType === "string"
          ? { mediaType: entry.mediaType }
          : {}),
      },
    ];
  });
};
