import type {
  ChatSessionQueuedMessage,
  ChatSessionTaskOutcome,
} from "../../chat-session.model";

export const shouldDispatchQueuedFollowUp = (
  policy: ChatSessionQueuedMessage["dispatchPolicy"],
  blockerOutcome: ChatSessionTaskOutcome | null,
  blockerActive: boolean,
): boolean => {
  if (!blockerOutcome) {
    return policy === "after-terminal" && !blockerActive;
  }

  return policy === "after-terminal" || blockerOutcome.status === "succeeded";
};
