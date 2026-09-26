import type {
  ChatSessionContextAttachment,
  ChatSessionQueuedMessage,
  ChatSessionQueuedPromptEnhancementRequest,
} from "../../chat-session.model";
import { MAX_REQUEST_ITERATIONS } from "../../chat-session.model";
import { getConciseTaskObjective } from "./task-action-prompts";

export const CONTINUE_ITERATION_CONTENT = "Continue";

export const normalizeRequestIterationCount = (value: number): number =>
  Number.isInteger(value) && value >= 1 && value <= MAX_REQUEST_ITERATIONS
    ? value
    : 1;

export const createQueuedRequestIterations = (input: {
  sessionId: string;
  task: string;
  count: number;
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
    const content = isFirst ? task : CONTINUE_ITERATION_CONTENT;
    return {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      task: isFirst
        ? task
        : `Continue the work on the original request.\n\nObjective: ${getConciseTaskObjective(task)}\n\nReview the previous iteration and the conversation for full context. Take the next useful step, avoid repeating completed work, and verify the result.`,
      visibleMessageContent: content,
      promptHistoryContent: content,
      ...(isFirst && input.promptEnhancementRequest
        ? { promptEnhancementRequest: input.promptEnhancementRequest }
        : {}),
      iteration: { groupId, index, total: count },
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
