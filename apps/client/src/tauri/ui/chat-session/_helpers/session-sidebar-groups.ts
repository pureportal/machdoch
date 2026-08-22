import {
  isQuickVoiceSession,
  type ChatSessionRecord,
} from "../../chat-session.model";

export const isSessionPinnedInSidebar = (
  session: ChatSessionRecord,
): boolean => {
  return isQuickVoiceSession(session) || typeof session.pinnedAt === "number";
};

export const compareSessionsBySidebarGroup = (
  left: ChatSessionRecord,
  right: ChatSessionRecord,
): number => {
  const leftIsPinned = isSessionPinnedInSidebar(left);
  const rightIsPinned = isSessionPinnedInSidebar(right);

  if (leftIsPinned === rightIsPinned) {
    return 0;
  }

  return leftIsPinned ? -1 : 1;
};

export const getUnpinnedSessionDividerIndex = (
  sessions: readonly ChatSessionRecord[],
): number | null => {
  const firstUnpinnedIndex = sessions.findIndex(
    (session) => !isSessionPinnedInSidebar(session),
  );

  return firstUnpinnedIndex > 0 ? firstUnpinnedIndex : null;
};
