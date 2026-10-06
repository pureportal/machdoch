import type { ProductAttachment } from "@machdoch/fleet-protocol";
import type {
  AttachmentSelectionKind,
  ChatSessionContextAttachment,
} from "./model";

export interface RemoteAttachmentControls {
  select(kind: AttachmentSelectionKind, messageId?: string): Promise<void>;
  upload(files: File[], messageId?: string): Promise<void>;
  open(attachment: ChatSessionContextAttachment): void;
}

export function toContextAttachment(
  attachment: ProductAttachment,
): ChatSessionContextAttachment {
  if (attachment.source === "path") {
    if (
      attachment.kind !== "file" &&
      attachment.kind !== "directory" &&
      attachment.kind !== "image" &&
      attachment.kind !== "other"
    )
      throw new Error("The device returned an unknown attachment type.");
    return { ...attachment, kind: attachment.kind };
  }
  if (
    attachment.kind !== "prompt" &&
    attachment.kind !== "image" &&
    attachment.kind !== "video" &&
    attachment.kind !== "audio" &&
    attachment.kind !== "vector" &&
    attachment.kind !== "alpha-matte" &&
    attachment.kind !== "report" &&
    attachment.kind !== "collection"
  )
    throw new Error("The device returned an unknown media type.");
  return { ...attachment, kind: attachment.kind };
}
