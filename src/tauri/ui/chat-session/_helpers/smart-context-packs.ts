import type { RunMode } from "../../../../core/types.js";
import type {
  ChatSessionContextAttachment,
  SmartContextPack,
} from "../../chat-session.model";
import { getProviderLabel } from "../../model-catalog";
import { mergeContextAttachments } from "./session-context-attachments";

export interface SaveSmartContextPackInput {
  name: string;
  instructions: string;
  includePrompt: boolean;
  includeAttachments: boolean;
  includeModel: boolean;
  includeMode: boolean;
}

export interface SmartContextPackComposerApplication {
  draft: string;
  contextAttachments: ChatSessionContextAttachment[];
}

export const getSmartContextPackSortTimestamp = (
  pack: Pick<SmartContextPack, "createdAt" | "lastUsedAt" | "updatedAt">,
): number => {
  return Math.max(pack.lastUsedAt ?? 0, pack.updatedAt, pack.createdAt);
};

const getWorkspaceComparisonKey = (workspace: string | null): string => {
  const normalized = workspace?.replace(/\\/gu, "/").replace(/\/+$/u, "").trim();

  if (!normalized) {
    return "";
  }

  return /^[A-Za-z]:\//u.test(normalized) ? normalized.toLowerCase() : normalized;
};

export const areSmartContextPackWorkspacesEqual = (
  left: string | null,
  right: string | null,
): boolean => {
  return getWorkspaceComparisonKey(left) === getWorkspaceComparisonKey(right);
};

const cloneContextAttachment = (
  attachment: ChatSessionContextAttachment,
): ChatSessionContextAttachment => {
  return {
    ...attachment,
    id: crypto.randomUUID(),
  };
};

export const cloneContextAttachmentsForPack = (
  attachments: ChatSessionContextAttachment[],
): ChatSessionContextAttachment[] => attachments.map(cloneContextAttachment);

export const getSmartContextPacksForWorkspace = (
  packs: SmartContextPack[],
  workspace: string | null,
): SmartContextPack[] => {
  return packs.filter((pack) =>
    areSmartContextPackWorkspacesEqual(pack.workspace, workspace),
  );
};

export const getContextPackModeLabel = (mode: RunMode): string => {
  return mode === "ask" ? "Ask mode" : "Machdoch";
};

export const createSmartContextPackDraftBlock = (
  pack: SmartContextPack,
): string => {
  const sections = [`## Context Pack: ${pack.name}`];
  const instructions = pack.instructions.trim();
  const prompt = pack.prompt.trim();

  if (instructions) {
    sections.push(`### Instructions\n${instructions}`);
  }

  if (prompt) {
    sections.push(`### Prompt\n${prompt}`);
  }

  return sections.length > 1 ? sections.join("\n\n") : "";
};

const applySmartContextPackToDraft = (
  draft: string,
  packDraftBlock: string,
): string => {
  if (!packDraftBlock) {
    return draft;
  }

  const normalizedDraft = draft.trim();

  if (!normalizedDraft) {
    return packDraftBlock;
  }

  return `${packDraftBlock}\n\n## Current Task\n${normalizedDraft}`;
};

export const applySmartContextPackToComposer = (
  draft: string,
  contextAttachments: ChatSessionContextAttachment[],
  pack: SmartContextPack,
): SmartContextPackComposerApplication => {
  const packDraftBlock = createSmartContextPackDraftBlock(pack);
  const clonedAttachments = cloneContextAttachmentsForPack(
    pack.contextAttachments,
  );

  return {
    draft: applySmartContextPackToDraft(draft, packDraftBlock),
    contextAttachments: mergeContextAttachments(
      contextAttachments,
      clonedAttachments,
    ),
  };
};

export const createContextPackSummary = (
  pack: Pick<
    SmartContextPack,
    "contextAttachments" | "instructions" | "mode" | "prompt" | "provider" | "model"
  >,
): string[] => {
  const summary: string[] = [];
  const attachmentCounts = {
    files: 0,
    folders: 0,
    images: 0,
    other: 0,
  };

  if (pack.prompt.trim()) {
    summary.push("prompt");
  }

  if (pack.instructions.trim()) {
    summary.push("instructions");
  }

  for (const attachment of pack.contextAttachments) {
    switch (attachment.kind) {
      case "file":
        attachmentCounts.files += 1;
        break;
      case "directory":
        attachmentCounts.folders += 1;
        break;
      case "image":
        attachmentCounts.images += 1;
        break;
      case "other":
      default:
        attachmentCounts.other += 1;
        break;
    }
  }

  if (attachmentCounts.files > 0) {
    summary.push(
      `${attachmentCounts.files} file${attachmentCounts.files === 1 ? "" : "s"}`,
    );
  }

  if (attachmentCounts.folders > 0) {
    summary.push(
      `${attachmentCounts.folders} folder${attachmentCounts.folders === 1 ? "" : "s"}`,
    );
  }

  if (attachmentCounts.images > 0) {
    summary.push(
      `${attachmentCounts.images} image${attachmentCounts.images === 1 ? "" : "s"}`,
    );
  }

  if (attachmentCounts.other > 0) {
    summary.push(
      `${attachmentCounts.other} path${attachmentCounts.other === 1 ? "" : "s"}`,
    );
  }

  if (pack.mode) {
    summary.push(getContextPackModeLabel(pack.mode));
  }

  if (pack.provider && pack.model) {
    summary.push(`${getProviderLabel(pack.provider)} / ${pack.model}`);
  }

  return summary;
};
