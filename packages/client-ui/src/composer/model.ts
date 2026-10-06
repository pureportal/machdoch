import type { MediaAssetReference } from "@machdoch/media-studio/core/media/contracts.js";

export type ChatSessionContextAttachmentKind =
  | "file"
  | "directory"
  | "image"
  | "other";

export interface ChatSessionPathContextAttachment {
  id: string;
  source: "path";
  path: string;
  kind: ChatSessionContextAttachmentKind;
  name: string;
  parent?: string;
}

export interface ChatSessionMediaAssetAttachment extends MediaAssetReference {
  id: string;
  name: string;
}

export type ChatSessionContextAttachment =
  | ChatSessionPathContextAttachment
  | ChatSessionMediaAssetAttachment;

export const isPathContextAttachment = (
  attachment: ChatSessionContextAttachment,
): attachment is ChatSessionPathContextAttachment =>
  attachment.source === "path";

export const isMediaAssetContextAttachment = (
  attachment: ChatSessionContextAttachment,
): attachment is ChatSessionMediaAssetAttachment =>
  attachment.source === "media-asset";

export interface ChatSessionRequestIteration {
  groupId: string;
  index: number;
  total: number;
  mode?: "repeat-prompt" | "continue" | "repeat-prompt-and-continue";
}

export const MAX_REQUEST_ITERATIONS = 20;

export type AttachmentSelectionKind = "files" | "folders" | "images";
export type RunningTaskMessageAction = "queue" | "steer" | "stop-and-send";
export type RequestIterationMode = NonNullable<
  ChatSessionRequestIteration["mode"]
>;
export const DEFAULT_REQUEST_ITERATION_MODE = "continue" as const;

export const isLinkContextAttachment = (
  attachment: ChatSessionContextAttachment,
): boolean => {
  if (!isPathContextAttachment(attachment) || attachment.kind !== "other")
    return false;
  try {
    return ["http:", "https:", "mailto:", "ftp:"].includes(
      new URL(attachment.path).protocol,
    );
  } catch {
    return false;
  }
};
