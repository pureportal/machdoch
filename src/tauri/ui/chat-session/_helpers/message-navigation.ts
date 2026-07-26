import type { ChatSessionMessage } from "../../chat-session.model";

export interface ConversationMessageNavigationState {
  currentIndex: number | null;
  currentMessage: ChatSessionMessage | null;
  messages: ChatSessionMessage[];
  nextMessage: ChatSessionMessage | null;
  previousMessage: ChatSessionMessage | null;
}

const isNavigableConversationMessage = (
  message: ChatSessionMessage,
): boolean => {
  return message.role !== "agent" || message.source?.kind !== "preview";
};

export const getNavigableConversationMessages = (
  messages: readonly ChatSessionMessage[],
): ChatSessionMessage[] => {
  return messages.filter(isNavigableConversationMessage);
};

export const getConversationMessageNavigationState = (
  messages: readonly ChatSessionMessage[],
  selectedMessageId: string | null,
): ConversationMessageNavigationState => {
  const navigableMessages = getNavigableConversationMessages(messages);

  if (navigableMessages.length === 0) {
    return {
      currentIndex: null,
      currentMessage: null,
      messages: navigableMessages,
      nextMessage: null,
      previousMessage: null,
    };
  }

  const requestedIndex = selectedMessageId
    ? navigableMessages.findIndex((message) => message.id === selectedMessageId)
    : -1;
  const currentIndex =
    requestedIndex >= 0 ? requestedIndex : navigableMessages.length - 1;

  return {
    currentIndex,
    currentMessage: navigableMessages[currentIndex] ?? null,
    messages: navigableMessages,
    nextMessage: navigableMessages[currentIndex + 1] ?? null,
    previousMessage: navigableMessages[currentIndex - 1] ?? null,
  };
};

export const getRenderedMessageLimitForTarget = (
  messages: readonly ChatSessionMessage[],
  targetMessageId: string,
  currentLimit: number,
): number => {
  const targetIndex = messages.findIndex(
    (message) => message.id === targetMessageId,
  );

  if (targetIndex < 0) {
    return currentLimit;
  }

  return Math.max(currentLimit, messages.length - targetIndex);
};
