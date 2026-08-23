import type {
  ChatSessionQueuedMessage,
  ChatSessionTaskOutcome,
} from "../../chat-session.model";

export const shouldDispatchQueuedFollowUp = (
  policy: ChatSessionQueuedMessage["dispatchPolicy"],
  blockerOutcome: ChatSessionTaskOutcome | null,
  blockerActive: boolean,
): boolean => {
  if (blockerActive) {
    return false;
  }

  if (!blockerOutcome) {
    return policy === "after-terminal";
  }

  return policy === "after-terminal" || blockerOutcome.status === "succeeded";
};
