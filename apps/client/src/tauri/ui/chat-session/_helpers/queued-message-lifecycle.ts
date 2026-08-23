import type {
  ChatSessionContextAttachment,
  ChatSessionQueuedMessage,
} from "../../chat-session.model";
import {
  createQueuedMessageDispatchPrompt,
  type QueuedMessageDispatchPrompt,
} from "./prompt-enhancement";
import { areContextAttachmentRecordsEqual } from "./session-context-attachments";

const areQueuedMessageAttachmentsEqual = (
  left: readonly ChatSessionContextAttachment[],
  right: readonly ChatSessionContextAttachment[],
): boolean => {
  return (
    left.length === right.length &&
    left.every((attachment, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        areContextAttachmentRecordsEqual(attachment, candidate)
      );
    })
  );
};

export const isQueuedPromptEnhancementInputCurrent = (
  baseline: ChatSessionQueuedMessage,
  current: ChatSessionQueuedMessage,
): boolean => {
  return (
    baseline.id === current.id &&
    baseline.task === current.task &&
    baseline.contentUpdatedAt === current.contentUpdatedAt &&
    baseline.attachmentsUpdatedAt === current.attachmentsUpdatedAt &&
    baseline.promptEnhancementRequest?.mode ===
      current.promptEnhancementRequest?.mode &&
    areQueuedMessageAttachmentsEqual(
      baseline.contextAttachments,
      current.contextAttachments,
    )
  );
};

export interface QueuedMessageDispatchAttempt {
  message: ChatSessionQueuedMessage;
  prompt: QueuedMessageDispatchPrompt;
}

export const createQueuedMessageDispatchAttempt = (
  message: ChatSessionQueuedMessage,
  enhancedPrompt: string | undefined,
  updatedAt: number,
): QueuedMessageDispatchAttempt => {
  if (message.promptEnhancementRequest && enhancedPrompt === undefined) {
    throw new Error("Queued prompt enhancement has not completed.");
  }

  if (!message.promptEnhancementRequest && enhancedPrompt !== undefined) {
    throw new Error("Queued prompt enhancement was already consumed.");
  }

  const prompt = createQueuedMessageDispatchPrompt(message, enhancedPrompt);
  const nextMessage: ChatSessionQueuedMessage = {
    ...message,
    task: prompt.task,
    visibleMessageContent: prompt.visibleMessageContent,
    promptHistoryContent: prompt.promptHistoryContent,
    status: "dispatching",
    statusUpdatedAt: updatedAt,
    updatedAt,
    ...(enhancedPrompt !== undefined ? { contentUpdatedAt: updatedAt } : {}),
  };

  delete nextMessage.failureMessage;

  if (enhancedPrompt !== undefined) {
    delete nextMessage.promptEnhancementRequest;
    delete nextMessage.promptEnhancement;

    if (prompt.promptEnhancement) {
      nextMessage.promptEnhancement = prompt.promptEnhancement;
    }
  }

  return { message: nextMessage, prompt };
};

export const createFailedQueuedMessageRecovery = (
  message: ChatSessionQueuedMessage,
  id: string,
  activeTaskId: string,
  updatedAt: number,
): ChatSessionQueuedMessage => {
  return {
    ...message,
    id,
    blockedByTaskId: activeTaskId,
    blockerUpdatedAt: updatedAt,
    status: "failed",
    statusUpdatedAt: updatedAt,
    failureMessage: "Task could not start because another task became active.",
    updatedAt,
  };
};

export const createQueuedMessageRetry = (
  message: ChatSessionQueuedMessage,
  id: string,
  updatedAt: number,
): ChatSessionQueuedMessage => {
  const retry: ChatSessionQueuedMessage = {
    ...message,
    id,
    status: "queued",
    statusUpdatedAt: updatedAt,
    updatedAt,
  };

  delete retry.failureMessage;
  return retry;
};
