import type {
  ChatSessionContextAttachment,
  ChatSessionRecord,
} from "../../chat-session.model";
import { areContextAttachmentRecordsEqual } from "./session-context-attachments";

export interface ComposerClearGuard {
  draft: string;
  contextAttachments: ChatSessionContextAttachment[];
  draftUpdatedAt: number;
  draftAttachmentsUpdatedAt: number;
}

export const createComposerClearGuard = (
  session: Pick<
    ChatSessionRecord,
    | "draft"
    | "draftContextAttachments"
    | "draftUpdatedAt"
    | "draftAttachmentsUpdatedAt"
  >,
): ComposerClearGuard => ({
  draft: session.draft,
  contextAttachments: session.draftContextAttachments.map((attachment) => ({
    ...attachment,
  })),
  draftUpdatedAt: session.draftUpdatedAt,
  draftAttachmentsUpdatedAt: session.draftAttachmentsUpdatedAt,
});

export const isComposerClearGuardCurrent = (
  session: ChatSessionRecord,
  guard: ComposerClearGuard | undefined,
): boolean => {
  if (!guard) {
    return true;
  }

  return (
    session.draft === guard.draft &&
    session.draftContextAttachments.length ===
      guard.contextAttachments.length &&
    session.draftContextAttachments.every((attachment, index) => {
      const candidate = guard.contextAttachments[index];
      return (
        candidate !== undefined &&
        areContextAttachmentRecordsEqual(attachment, candidate)
      );
    }) &&
    session.draftUpdatedAt === guard.draftUpdatedAt &&
    session.draftAttachmentsUpdatedAt === guard.draftAttachmentsUpdatedAt
  );
};

export const createComposerSubmissionSessionSnapshot = (
  renderedSession: ChatSessionRecord,
  currentSession: ChatSessionRecord | null,
  submittedDraft: string,
): ChatSessionRecord => {
  const baseSession =
    currentSession?.id === renderedSession.id
      ? currentSession
      : renderedSession;

  return submittedDraft === baseSession.draft
    ? baseSession
    : { ...baseSession, draft: submittedDraft };
};
