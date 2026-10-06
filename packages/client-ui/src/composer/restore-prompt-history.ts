import type { ComposerHistorySelection } from "@machdoch/fleet-protocol";

interface ComposerHistorySource<Attachment extends { id: string }> {
  draft: string;
  draftContextAttachments: Attachment[];
  promptHistory: string[];
  promptContextHistory: Attachment[][];
}

export function resolvePromptHistoryRestore<Attachment extends { id: string }>(
  source: ComposerHistorySource<Attachment>,
  history: ComposerHistorySelection,
  draft: string,
): { draft: string; draftContextAttachments: Attachment[] } | null {
  const attachments = source.promptContextHistory[history.index] ?? [];
  if (
    source.draft !== history.previousDraft ||
    source.promptHistory[history.index] !== history.prompt ||
    source.draftContextAttachments.length !==
      history.previousAttachmentIds.length ||
    source.draftContextAttachments.some(
      (attachment, index) =>
        attachment.id !== history.previousAttachmentIds[index],
    ) ||
    attachments.length !== history.attachmentIds.length ||
    attachments.some(
      (attachment, index) => attachment.id !== history.attachmentIds[index],
    )
  )
    return null;
  return {
    draft,
    draftContextAttachments: attachments.map((attachment) => ({
      ...attachment,
    })),
  };
}
