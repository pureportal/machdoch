import type { ChatSessionQueuedMessage, ChatSessionQueuedPromptEnhancementRequest } from "../../chat-session.model";
import type { ChatSessionContextAttachment, RequestIterationMode } from "@machdoch/client-ui/composer/model";
import { MAX_REQUEST_ITERATIONS } from "@machdoch/client-ui/composer/model";

export const CONTINUE_ITERATION_CONTENT = "Continue";

const createIterationContent = (
  task: string,
  mode: RequestIterationMode,
): string => {
  switch (mode) {
    case "repeat-prompt":
      return task;
    case "continue":
      return CONTINUE_ITERATION_CONTENT;
    case "repeat-prompt-and-continue":
      return `${task}\n\n---\n\nNext iteration: Continue working on the request above. Use the preceding conversation as context and avoid repeating completed work.`;
  }
};

export const normalizeRequestIterationCount = (value: number): number =>
  Number.isInteger(value) && value >= 1 && value <= MAX_REQUEST_ITERATIONS
    ? value
    : 1;

export const createQueuedRequestIterations = (input: {
  sessionId: string;
  task: string;
  count: number;
  mode: RequestIterationMode;
  orderRank: number;
  contextAttachments: ChatSessionContextAttachment[];
  promptEnhancementRequest?: ChatSessionQueuedPromptEnhancementRequest;
  timestamp: number;
}): ChatSessionQueuedMessage[] => {
  const task = input.task.trim();
  const count = normalizeRequestIterationCount(input.count);
  if (!task) return [];

  const groupId = crypto.randomUUID();
  return Array.from({ length: count }, (_, offset) => {
    const index = offset + 1;
    const isFirst = index === 1;
    const content = isFirst ? task : createIterationContent(task, input.mode);
    return {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      task: content,
      visibleMessageContent: content,
      promptHistoryContent: content,
      ...(isFirst && input.promptEnhancementRequest
        ? { promptEnhancementRequest: input.promptEnhancementRequest }
        : {}),
      iteration: { groupId, index, total: count, mode: input.mode },
      contextAttachments: input.contextAttachments.map((attachment) => ({
        ...attachment,
      })),
      contentUpdatedAt: input.timestamp,
      attachmentsUpdatedAt: input.timestamp,
      attachmentTombstones: {},
      blockerUpdatedAt: input.timestamp,
      orderRank: input.orderRank + offset,
      orderUpdatedAt: input.timestamp,
      status: "queued" as const,
      statusUpdatedAt: input.timestamp,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    };
  });
};

export const applyEnhancedPromptToQueuedRequestIterations = (
  messages: ChatSessionQueuedMessage[],
  firstMessage: ChatSessionQueuedMessage,
  enhancedPrompt: string,
  updatedAt: number,
): ChatSessionQueuedMessage[] => {
  const iteration = firstMessage.iteration;
  const enhancedTask = enhancedPrompt.trim();
  if (!iteration || iteration.index !== 1 || !enhancedTask) {
    return messages;
  }

  return messages.map((message) => {
    const followUp = message.iteration;
    if (
      message.sessionId !== firstMessage.sessionId ||
      followUp?.groupId !== iteration.groupId ||
      followUp.index === 1 ||
      !followUp.mode ||
      message.status !== "queued" ||
      message.contentUpdatedAt !== message.createdAt
    ) {
      return message;
    }

    const content = createIterationContent(enhancedTask, followUp.mode);
    if (content === message.task) return message;

    return {
      ...message,
      task: content,
      visibleMessageContent: content,
      promptHistoryContent: content,
      contentUpdatedAt: updatedAt,
      updatedAt,
    };
  });
};

export const getBlockingRequestIteration = (
  message: ChatSessionQueuedMessage,
  messages: readonly ChatSessionQueuedMessage[],
): ChatSessionQueuedMessage | undefined => {
  const iteration = message.iteration;
  if (!iteration) return undefined;
  return messages
    .filter(
      (entry) =>
        entry.sessionId === message.sessionId &&
        entry.iteration !== undefined &&
        entry.iteration.groupId === iteration.groupId &&
        entry.iteration.index < iteration.index,
    )
    .sort((left, right) => left.iteration!.index - right.iteration!.index)[0];
};
