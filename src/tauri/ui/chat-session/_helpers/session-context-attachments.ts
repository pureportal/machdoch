import {
  getImageInputMediaTypeForPath,
} from "../../../../core/model-capabilities.js";
import {
  type ChatSessionContextAttachment,
  type ChatSessionContextAttachmentKind,
  type ChatSessionRecord,
} from "../../chat-session.model";
import type { DroppedPathEntry } from "../../runtime";

export type FileDropTarget = "active-session" | "quick-task";

export type AttachmentSelectionKind = "files" | "folders" | "images";

export type DialogSelection = string | string[] | null;

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
  attachment: Pick<ChatSessionContextAttachment, "kind">,
): string => {
  switch (attachment.kind) {
    case "directory":
      return "folder";
    case "file":
      return "file";
    case "image":
      return "image";
    case "other":
    default:
      return "path";
  }
};

export const createContextAttachment = (
  entry: DroppedPathEntry,
): ChatSessionContextAttachment => {
  const parent = entry.parent?.trim();

  return {
    id: crypto.randomUUID(),
    path: entry.path,
    kind: normalizeDroppedPathKind(entry),
    name: entry.name,
    ...(parent ? { parent } : {}),
  };
};

export const mergeContextAttachments = (
  existing: ChatSessionContextAttachment[],
  incoming: ChatSessionContextAttachment[],
): ChatSessionContextAttachment[] => {
  const seenPaths = new Set(
    existing.map((attachment) => attachment.path.toLowerCase()),
  );
  const merged = [...existing];

  for (const attachment of incoming) {
    const dedupeKey = attachment.path.toLowerCase();

    if (seenPaths.has(dedupeKey)) {
      continue;
    }

    seenPaths.add(dedupeKey);
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

    return `Use this ${formatContextAttachmentKind(attachment)}: "${attachment.path}"`;
  }

  return [
    "Use these paths:",
    ...attachments.map(
      (attachment) =>
        `- ${formatContextAttachmentKind(attachment)}: "${attachment.path}"`,
    ),
  ].join("\n");
};

export const appendContextAttachmentsToTask = (
  task: string,
  attachments: ChatSessionContextAttachment[],
): string => {
  return appendDraftBlock(task, createContextAttachmentsTaskBlock(attachments));
};

export const getImageAttachmentPaths = (
  attachments: ChatSessionContextAttachment[],
): string[] => {
  return attachments
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => attachment.path);
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
      attachment.path === otherAttachment.path &&
      attachment.kind === otherAttachment.kind
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
