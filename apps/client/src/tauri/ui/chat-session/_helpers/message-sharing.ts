import { isNavigableConversationMessage } from "@machdoch/client-ui/conversation/message-navigation";
import {
  isQuickVoiceSession,
  isSessionArchived,
  isTransientChatOperationMessage,
  type ChatSessionMessage,
  type ChatSessionRecord,
} from "../../chat-session.model";
import { getRenderedMessageContent } from "./execution-message";

export interface MessageShareDraft {
  sourceSessionId: string;
  messageId: string | null;
  targetSessionId: string | null;
}

const isShareableMessage = (message: ChatSessionMessage): boolean =>
  isNavigableConversationMessage(message) &&
  !isTransientChatOperationMessage(message) &&
  getRenderedMessageContent(message).trim().length > 0;

export const getShareableMessages = (
  session: ChatSessionRecord,
): ChatSessionMessage[] => session.messages.filter(isShareableMessage);

export const hasShareableMessages = (session: ChatSessionRecord): boolean =>
  session.messages.some(isShareableMessage);

export const getDefaultSharedMessageId = (
  session: ChatSessionRecord,
): string | null => {
  const messages = getShareableMessages(session);
  return (
    messages.filter((message) => message.role === "agent").at(-1)?.id ??
    messages.at(-1)?.id ??
    null
  );
};

export const canReceiveSharedMessage = (session: ChatSessionRecord): boolean =>
  !isQuickVoiceSession(session) && !isSessionArchived(session);

export const createSharedMessagePrompt = (
  sourceTitle: string,
  message: ChatSessionMessage,
): string =>
  `Important information from the chat "${sourceTitle}":\n\n${getRenderedMessageContent(message).trim()}`;
