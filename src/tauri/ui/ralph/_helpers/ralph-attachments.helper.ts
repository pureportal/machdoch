import { getImageInputMediaTypeForPath } from "../../../../core/model-capabilities.js";
import type { RalphAttachmentReference } from "../../../../core/ralph.js";
import type { ChatSessionContextAttachment } from "../../chat-session.model";
import type { DroppedPathEntry } from "../../runtime";

export interface RalphVariableAttachmentItem {
  attachment: RalphAttachmentReference;
  key: string;
}

export const getRalphPathName = (path: string): string => {
  const name = path.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1);

  return name?.trim() || path;
};

export const getRalphPathParent = (path: string): string | undefined => {
  const lastSeparatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  if (lastSeparatorIndex <= 0) {
    return undefined;
  }

  return path.slice(0, lastSeparatorIndex);
};

export const normalizeRalphAttachmentKind = (
  value: DroppedPathEntry["kind"] | RalphAttachmentReference["kind"] | undefined,
  path: string,
): NonNullable<RalphAttachmentReference["kind"]> => {
  if (value === "directory" || value === "file" || value === "image") {
    return value;
  }

  if (getImageInputMediaTypeForPath(path)) {
    return "image";
  }

  return value === "other" ? "other" : "file";
};

export const createRalphPathAttachment = (
  entry: DroppedPathEntry,
): RalphAttachmentReference => {
  const kind = normalizeRalphAttachmentKind(entry.kind, entry.path);
  const mediaType = getImageInputMediaTypeForPath(entry.path);

  return {
    id: crypto.randomUUID(),
    source: "path",
    value: entry.path,
    kind,
    ...(mediaType ? { mediaType } : {}),
  };
};

export const createRalphPathAttachmentPreview = (
  attachment: RalphAttachmentReference,
  index: number,
): ChatSessionContextAttachment => {
  const kind = normalizeRalphAttachmentKind(attachment.kind, attachment.value);
  const parent = getRalphPathParent(attachment.value);

  return {
    id: attachment.id ?? `ralph-path-${index}`,
    path: attachment.value,
    kind,
    name: getRalphPathName(attachment.value),
    ...(parent ? { parent } : {}),
  };
};

export const getRalphPathAttachmentPreviews = (
  attachments: RalphAttachmentReference[] | undefined,
): ChatSessionContextAttachment[] => {
  return (attachments ?? [])
    .filter((attachment) => attachment.source === "path")
    .map(createRalphPathAttachmentPreview);
};

export const getRalphVariableAttachmentItems = (
  attachments: RalphAttachmentReference[] | undefined,
): RalphVariableAttachmentItem[] => {
  return (attachments ?? []).flatMap((attachment, index) =>
    attachment.source === "variable"
      ? [
          {
            attachment,
            key: attachment.id ?? `ralph-variable-${index}`,
          },
        ]
      : [],
  );
};

export const mergeRalphAttachments = (
  existing: RalphAttachmentReference[],
  incoming: RalphAttachmentReference[],
): RalphAttachmentReference[] => {
  const seen = new Set(
    existing.map((attachment) =>
      `${attachment.source}:${attachment.value.trim().toLowerCase()}`,
    ),
  );
  const merged = [...existing];

  for (const attachment of incoming) {
    const key = `${attachment.source}:${attachment.value.trim().toLowerCase()}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(attachment);
  }

  return merged;
};
