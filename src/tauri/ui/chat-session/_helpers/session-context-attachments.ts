import {
  getImageInputMediaTypeForPath,
} from "../../../../core/model-capabilities.js";
import {
  isMediaAssetContextAttachment,
  isPathContextAttachment,
  type ChatSessionContextAttachment,
  type ChatSessionContextAttachmentKind,
  type ChatSessionRecord,
} from "../../chat-session.model";
import type { MediaAssetReference } from "../../../../core/media/contracts.js";
import type { DroppedPathEntry } from "../../runtime";

export type FileDropTarget = "active-session" | "quick-task";

export type AttachmentSelectionKind = "files" | "folders" | "images";

export type DialogSelection = string | string[] | null;

const LINK_ATTACHMENT_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "ftp:",
]);

export const appendTranscriptToDraft = (
  draft: string,
  transcript: string,
): string => {
  const normalizedTranscript = transcript.trim();

  if (!normalizedTranscript) {
    return draft;
  }

  if (!draft.trim()) {
    return normalizedTranscript;
  }

  return /\s$/u.test(draft)
    ? `${draft}${normalizedTranscript}`
    : `${draft}\n${normalizedTranscript}`;
};

export const clampQuickVoiceMessageLimit = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 50;
  }

  return Math.min(200, Math.max(10, Math.round(value)));
};

export const appendDraftBlock = (draft: string, block: string): string => {
  const normalizedBlock = block.trim();

  if (!normalizedBlock) {
    return draft;
  }

  const normalizedDraft = draft.trimEnd();

  return normalizedDraft ? `${normalizedDraft}\n\n${normalizedBlock}` : normalizedBlock;
};

const normalizeDroppedPathKind = (
  entry: DroppedPathEntry,
): ChatSessionContextAttachmentKind => {
  switch (entry.kind) {
    case "directory":
      return "directory";
    case "file":
      return getImageInputMediaTypeForPath(entry.path) ? "image" : "file";
    case "other":
    default:
      return "other";
  }
};

const formatContextAttachmentKind = (
  attachment: ChatSessionContextAttachment,
): string => {
  if (isMediaAssetContextAttachment(attachment)) {
    return `Media Studio ${attachment.kind}`;
  }
  switch (attachment.kind) {
    case "directory":
      return "folder";
    case "file":
      return "file";
    case "image":
      return "image";
    case "other":
    default:
      return isLinkContextAttachment(attachment) ? "link" : "path";
  }
};

export const isLinkContextAttachment = (
  attachment: ChatSessionContextAttachment,
): boolean => {
  if (!isPathContextAttachment(attachment) || attachment.kind !== "other") {
    return false;
  }

  try {
    return LINK_ATTACHMENT_PROTOCOLS.has(new URL(attachment.path).protocol);
  } catch {
    return false;
  }
};

const getLinkAttachmentName = (value: string): string => {
  try {
    const url = new URL(value);
    const path = url.pathname === "/" ? "" : url.pathname;
    const label = `${url.hostname}${path}`.trim();

    return label || url.protocol.replace(/:$/u, "") || value;
  } catch {
    return value.split(/\s+/u).filter(Boolean).at(0) ?? value;
  }
};

export const createContextAttachment = (
  entry: DroppedPathEntry,
): ChatSessionContextAttachment => {
  const parent = entry.parent?.trim();

  return {
    id: crypto.randomUUID(),
    source: "path",
    path: entry.path,
    kind: normalizeDroppedPathKind(entry),
    name: entry.name,
    ...(parent ? { parent } : {}),
  };
};

export const createContextAttachmentFromReference = (
  value: string,
): ChatSessionContextAttachment | null => {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return null;
  }

  return {
    id: crypto.randomUUID(),
    source: "path",
    path: normalizedValue,
    kind: "other",
    name: getLinkAttachmentName(normalizedValue),
  };
};

export const createContextAttachmentFromMediaAsset = (
  reference: MediaAssetReference,
): ChatSessionContextAttachment => ({
  ...reference,
  id: crypto.randomUUID(),
  name:
    reference.displayName?.trim() ||
    `Media asset ${reference.assetId.slice(0, 12)}`,
  rendition: reference.rendition ?? "original",
});

export const getContextAttachmentIdentity = (
  attachment: ChatSessionContextAttachment,
): string =>
  isMediaAssetContextAttachment(attachment)
    ? `media:${attachment.workspaceRoot.toLowerCase()}:${attachment.assetId}`
    : `path:${attachment.path.toLowerCase()}`;

export const mergeContextAttachments = (
  existing: ChatSessionContextAttachment[],
  incoming: ChatSessionContextAttachment[],
): ChatSessionContextAttachment[] => {
  const seenAttachments = new Set(
    existing.map(getContextAttachmentIdentity),
  );
  const merged = [...existing];

  for (const attachment of incoming) {
    const dedupeKey = getContextAttachmentIdentity(attachment);

    if (seenAttachments.has(dedupeKey)) {
      continue;
    }

    seenAttachments.add(dedupeKey);
    merged.push(attachment);
  }

  return merged;
};

const createContextAttachmentsTaskBlock = (
  attachments: ChatSessionContextAttachment[],
): string => {
  if (attachments.length === 0) {
    return "";
  }

  if (attachments.length === 1) {
    const [attachment] = attachments;

    if (!attachment) {
      return "";
    }

    return isMediaAssetContextAttachment(attachment)
      ? `Use this Media Studio ${attachment.kind} asset: "${attachment.assetId}"`
      : `Use this ${formatContextAttachmentKind(attachment)}: "${attachment.path}"`;
  }

  const containsMediaAsset = attachments.some(isMediaAssetContextAttachment);
  return [
    containsMediaAsset ? "Use these attachments:" : "Use these paths:",
    ...attachments.map(
      (attachment) => isMediaAssetContextAttachment(attachment)
        ? `- Media Studio ${attachment.kind} asset: "${attachment.assetId}"`
        : `- ${formatContextAttachmentKind(attachment)}: "${attachment.path}"`,
    ),
  ].join("\n");
};

const CONTEXT_ATTACHMENTS_TASK_BLOCK_PATTERN =
  /(?:\r?\n){2,}(?:Use this (?:file|image|folder|path|link): "[^"\r\n]+"|Use this Media Studio (?:prompt|image|alpha-matte|report|collection) asset: "[^"\r\n]+"|Use these paths:(?:\r?\n- (?:file|image|folder|path|link): "[^"\r\n]+")+|Use these attachments:(?:\r?\n- (?:(?:file|image|folder|path|link): "[^"\r\n]+"|Media Studio (?:prompt|image|alpha-matte|report|collection) asset: "[^"\r\n]+"))+)\s*$/u;
const CONTEXT_ATTACHMENTS_TASK_BLOCK_CAPTURE_PATTERN =
  /(?:\r?\n){2,}(Use this (?:file|image|folder|path|link): "[^"\r\n]+"|Use these paths:(?:\r?\n- (?:file|image|folder|path|link): "[^"\r\n]+")+)\s*$/u;
const SINGLE_CONTEXT_ATTACHMENT_LINE_PATTERN =
  /^Use this (file|image|folder|path|link): "([^"\r\n]+)"$/u;
const MULTI_CONTEXT_ATTACHMENT_LINE_PATTERN =
  /^- (file|image|folder|path|link): "([^"\r\n]+)"$/u;

export const appendContextAttachmentsToTask = (
  task: string,
  attachments: ChatSessionContextAttachment[],
): string => {
  return appendDraftBlock(task, createContextAttachmentsTaskBlock(attachments));
};

export const stripContextAttachmentsTaskBlock = (task: string): string => {
  return task.replace(CONTEXT_ATTACHMENTS_TASK_BLOCK_PATTERN, "").trimEnd();
};

const getAttachmentKindFromTaskLabel = (
  label: string,
): ChatSessionContextAttachmentKind => {
  switch (label) {
    case "file":
      return "file";
    case "image":
      return "image";
    case "folder":
      return "directory";
    case "link":
    case "path":
    default:
      return "other";
  }
};

const getAttachmentNameFromPath = (path: string): string => {
  const name = path.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1);

  return name?.trim() || path;
};

const getAttachmentParentFromPath = (path: string): string | undefined => {
  const lastSeparatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  if (lastSeparatorIndex <= 0) {
    return undefined;
  }

  return path.slice(0, lastSeparatorIndex);
};

export const createContextAttachmentsFromTaskBlock = (
  task: string,
  idPrefix = "context-attachment",
): ChatSessionContextAttachment[] => {
  const block = task.match(CONTEXT_ATTACHMENTS_TASK_BLOCK_CAPTURE_PATTERN)?.[1];

  if (!block) {
    return [];
  }

  const lines = block
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "Use these paths:");
  const attachments: ChatSessionContextAttachment[] = [];

  for (const line of lines) {
    const match =
      line.match(SINGLE_CONTEXT_ATTACHMENT_LINE_PATTERN) ??
      line.match(MULTI_CONTEXT_ATTACHMENT_LINE_PATTERN);
    const label = match?.[1];
    const path = match?.[2]?.trim();

    if (!label || !path) {
      continue;
    }

    const parent = getAttachmentParentFromPath(path);
    const kind = getAttachmentKindFromTaskLabel(label);

    attachments.push({
      id: `${idPrefix}-${attachments.length}`,
      source: "path",
      path,
      kind,
      name: label === "link" ? getLinkAttachmentName(path) : getAttachmentNameFromPath(path),
      ...(parent ? { parent } : {}),
    });
  }

  return attachments;
};

export const getImageAttachmentPaths = (
  attachments: ChatSessionContextAttachment[],
): string[] =>
  attachments.flatMap((attachment) =>
    isPathContextAttachment(attachment) && attachment.kind === "image"
      ? [attachment.path]
      : [],
  );

export const getImageAttachmentMediaReferences = (
  attachments: ChatSessionContextAttachment[],
): MediaAssetReference[] =>
  attachments.flatMap((attachment) =>
    isMediaAssetContextAttachment(attachment) && attachment.kind === "image"
      ? [
          {
            source: "media-asset",
            workspaceRoot: attachment.workspaceRoot,
            assetId: attachment.assetId,
            kind: attachment.kind,
            ...(attachment.displayName
              ? { displayName: attachment.displayName }
              : {}),
            ...(attachment.rendition
              ? { rendition: attachment.rendition }
              : {}),
          } satisfies MediaAssetReference,
        ]
      : [],
  );

export const areContextAttachmentRecordsEqual = (
  attachment: ChatSessionContextAttachment,
  otherAttachment: ChatSessionContextAttachment,
): boolean => {
  if (
    attachment.id !== otherAttachment.id ||
    attachment.name !== otherAttachment.name ||
    attachment.kind !== otherAttachment.kind ||
    getContextAttachmentIdentity(attachment) !==
      getContextAttachmentIdentity(otherAttachment)
  ) {
    return false;
  }
  if (
    isMediaAssetContextAttachment(attachment) &&
    isMediaAssetContextAttachment(otherAttachment)
  ) {
    return (
      attachment.displayName === otherAttachment.displayName &&
      attachment.rendition === otherAttachment.rendition
    );
  }
  return (
    isPathContextAttachment(attachment) &&
    isPathContextAttachment(otherAttachment) &&
    attachment.parent === otherAttachment.parent
  );
};

const areContextAttachmentsEqual = (
  left: ChatSessionContextAttachment[],
  right: ChatSessionContextAttachment[],
): boolean => {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((attachment, index) => {
    const otherAttachment = right[index];

    return (
      otherAttachment !== undefined &&
      areContextAttachmentRecordsEqual(attachment, otherAttachment)
    );
  });
};

export const createPromptHistoryUpdate = (
  session: Pick<ChatSessionRecord, "promptHistory" | "promptContextHistory">,
  task: string,
  attachments: ChatSessionContextAttachment[],
): Pick<ChatSessionRecord, "promptHistory" | "promptContextHistory"> => {
  const alignedPromptContextHistory = session.promptHistory.map(
    (_entry, index) => session.promptContextHistory[index] ?? [],
  );
  const latestTask = session.promptHistory.at(-1);
  const latestAttachments = alignedPromptContextHistory.at(-1) ?? [];

  if (
    latestTask === task &&
    areContextAttachmentsEqual(latestAttachments, attachments)
  ) {
    return {
      promptHistory: session.promptHistory,
      promptContextHistory: alignedPromptContextHistory,
    };
  }

  return {
    promptHistory: [...session.promptHistory, task].slice(-40),
    promptContextHistory: [
      ...alignedPromptContextHistory,
      attachments,
    ].slice(-40),
  };
};

export const normalizeDialogSelection = (
  selection: DialogSelection,
): string[] => {
  if (!selection) {
    return [];
  }

  return Array.isArray(selection) ? selection : [selection];
};
