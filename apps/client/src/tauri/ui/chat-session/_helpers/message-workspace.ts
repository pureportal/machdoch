import type { ChatSessionMessage } from "../../chat-session.model";

export const getMessageWorkspaceRoot = (
  message: ChatSessionMessage,
  messages: readonly ChatSessionMessage[],
  currentWorkspace: string | null | undefined,
): string | null => {
  if (message.settings) {
    return message.settings.workspace;
  }

  const request = message.taskId
    ? messages.find(
        (candidate) =>
          candidate.role === "user" &&
          candidate.taskId === message.taskId &&
          candidate.settings !== undefined,
      )
    : undefined;

  return request?.settings
    ? request.settings.workspace
    : (currentWorkspace ?? null);
};
