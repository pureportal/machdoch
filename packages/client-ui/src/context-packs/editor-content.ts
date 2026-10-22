import {
  isPathContextAttachment,
  isMediaAssetContextAttachment,
  type ChatSessionContextAttachment,
} from "../composer/model";
import type { SmartContextPackVariable } from "./model";
import { createContextAttachmentFromReference } from "../composer/attachment-reference";

export const formatListInputValue = (values: string[]): string =>
  values.join(", ");

export const formatVariableInputValue = (
  variables: SmartContextPackVariable[],
): string => {
  return variables
    .map((variable) =>
      variable.defaultValue
        ? `${variable.name}=${variable.defaultValue}`
        : variable.name,
    )
    .join(", ");
};

export const formatAttachmentPathInputValue = (
  attachments: ChatSessionContextAttachment[],
): string =>
  attachments
    .flatMap((attachment) =>
      isPathContextAttachment(attachment) ? [attachment.path] : [],
    )
    .join("\n");

const getAttachmentPathKey = (path: string): string => {
  return path.replace(/\\/gu, "/").trim().toLowerCase();
};

export const createContextAttachmentsFromPathInput = (
  value: string,
  sourceAttachments: ChatSessionContextAttachment[],
): ChatSessionContextAttachment[] => {
  const sourceByPath = new Map(
    sourceAttachments.flatMap((attachment) =>
      isPathContextAttachment(attachment)
        ? [[getAttachmentPathKey(attachment.path), attachment] as const]
        : [],
    ),
  );
  const attachments: ChatSessionContextAttachment[] = sourceAttachments.filter(
    isMediaAssetContextAttachment,
  );
  const seenPaths = new Set<string>();

  for (const line of value.split(/\r?\n/u)) {
    const path = line.trim();
    const key = getAttachmentPathKey(path);

    if (!path || seenPaths.has(key)) {
      continue;
    }

    seenPaths.add(key);

    const existingAttachment = sourceByPath.get(key);

    if (existingAttachment) {
      attachments.push(existingAttachment);
      continue;
    }

    const attachment = createContextAttachmentFromReference(path);

    if (attachment) {
      attachments.push(attachment);
    }
  }

  return attachments;
};
