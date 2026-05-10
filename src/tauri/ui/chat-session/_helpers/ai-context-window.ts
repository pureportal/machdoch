import type { ConversationHistoryEntry } from "../../../../core/types.js";
import {
  createVisibleConversationMessages,
  type ChatSessionMessage,
} from "../../chat-session.model";
import { getRenderedMessageContent } from "./execution-message.tsx";
import { shouldOmitTaskActionPromptFromAiContext } from "./task-action-prompts";

export const DEFAULT_AI_CONTEXT_MESSAGE_LIMIT = 60;
export const MIN_AI_CONTEXT_MESSAGE_LIMIT = 1;
export const MAX_AI_CONTEXT_MESSAGE_LIMIT = 200;

export const clampAiContextMessageLimit = (value: unknown): number => {
  const numericValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numericValue)) {
    return DEFAULT_AI_CONTEXT_MESSAGE_LIMIT;
  }

  return Math.min(
    MAX_AI_CONTEXT_MESSAGE_LIMIT,
    Math.max(MIN_AI_CONTEXT_MESSAGE_LIMIT, Math.round(numericValue)),
  );
};

const createConversationHistoryEntry = (
  message: ChatSessionMessage,
): ConversationHistoryEntry | undefined => {
  if (
    message.role === "user" &&
    (message.intent || shouldOmitTaskActionPromptFromAiContext(message.content))
  ) {
    return undefined;
  }

  const content = getRenderedMessageContent(message).trim();

  if (content.length === 0) {
    return undefined;
  }

  const role: ConversationHistoryEntry["role"] =
    message.role === "agent" ? "assistant" : "user";

  return {
    role,
    content,
    ...(typeof message.createdAt === "number"
      ? { createdAt: message.createdAt }
      : {}),
  };
};

const isConversationHistoryEntry = (
  entry: ConversationHistoryEntry | undefined,
): entry is ConversationHistoryEntry => {
  return entry !== undefined;
};

export const createAiContextHistory = (
  messages: ChatSessionMessage[],
  maxMessages: unknown,
): ConversationHistoryEntry[] => {
  return createVisibleConversationMessages(messages)
    .map(createConversationHistoryEntry)
    .filter(isConversationHistoryEntry)
    .slice(-clampAiContextMessageLimit(maxMessages));
};

export const getAiContextCutoffMessageId = (
  visibleMessages: ChatSessionMessage[],
  maxMessages: unknown,
): string | null => {
  const normalizedLimit = clampAiContextMessageLimit(maxMessages);
  const contextMessages = visibleMessages.filter((message) => {
    return getRenderedMessageContent(message).trim().length > 0;
  });

  if (contextMessages.length <= normalizedLimit) {
    return null;
  }

  return contextMessages.at(-normalizedLimit)?.id ?? null;
};
