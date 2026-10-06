export interface ConversationNavigationMessage {
  id: string;
  role: string;
  source?: { kind: string } | undefined;
  lifecycle?: { kind: string; owner?: string | undefined } | undefined;
}

export interface ConversationMessageNavigationState<
  T extends ConversationNavigationMessage,
> {
  currentIndex: number | null;
  currentMessage: T | null;
  messages: T[];
  nextMessage: T | null;
  previousMessage: T | null;
}

export interface ConversationMessageViewportBounds {
  bottom: number;
  id: string;
  top: number;
}

export const isNavigableConversationMessage = (
  message: ConversationNavigationMessage,
): boolean => {
  return (
    message.role !== "agent" ||
    (message.source?.kind !== "preview" &&
      !(
        message.lifecycle?.kind === "transient" &&
        message.lifecycle.owner === "prompt-enhancement"
      ))
  );
};

export const getNavigableConversationMessages = <
  T extends ConversationNavigationMessage,
>(
  messages: readonly T[],
): T[] => {
  return messages.filter(isNavigableConversationMessage);
};

export const getConversationMessageNavigationState = <
  T extends ConversationNavigationMessage,
>(
  messages: readonly T[],
  selectedMessageId: string | null,
): ConversationMessageNavigationState<T> => {
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

export const getRenderedMessageLimitForTarget = <
  T extends ConversationNavigationMessage,
>(
  messages: readonly T[],
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

export const getVisibleConversationMessageId = (
  messageBounds: readonly ConversationMessageViewportBounds[],
  viewportTop: number,
  viewportBottom: number,
  isAtBottom = false,
): string | null => {
  const visibleMessageBounds = messageBounds.filter(
    (bounds) =>
      bounds.bottom > bounds.top &&
      bounds.bottom > viewportTop &&
      bounds.top < viewportBottom,
  );

  if (visibleMessageBounds.length === 0) {
    return null;
  }

  if (isAtBottom) {
    return visibleMessageBounds.at(-1)?.id ?? null;
  }

  return visibleMessageBounds[0]?.id ?? null;
};
