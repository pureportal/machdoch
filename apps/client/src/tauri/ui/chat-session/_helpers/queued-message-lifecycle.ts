import { getActiveChatOperationIds, getLatestUserTaskId, getSessionOverviewStatus, getSessionTaskOutcome, type ChatSessionQueuedMessage, type ChatSessionRecord, type ChatSessionTaskOutcomeStatus } from "../../chat-session.model";
import { type ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import {
  createQueuedMessageDispatchPrompt,
  type QueuedMessageDispatchPrompt,
} from "./prompt-enhancement";
import { getBlockingRequestIteration } from "./request-iterations";
import { areContextAttachmentRecordsEqual } from "./session-context-attachments";

const QUEUE_STOPPING_TASK_OUTCOMES: ReadonlySet<ChatSessionTaskOutcomeStatus> =
  new Set(["failed", "blocked", "timed-out", "unsupported", "crashed"]);

const getLatestFailedTaskId = (session: ChatSessionRecord): string | null => {
  const taskId = getLatestUserTaskId(session.messages);
  const outcome = taskId ? getSessionTaskOutcome(session, taskId) : null;

  return outcome && QUEUE_STOPPING_TASK_OUTCOMES.has(outcome.status)
    ? taskId
    : null;
};

export const shouldStopQueueAfterFailure = (
  session: ChatSessionRecord,
): boolean => {
  const failedTaskId = getLatestFailedTaskId(session);

  return (
    session.queuePausedAt === undefined &&
    failedTaskId !== null &&
    failedTaskId !== session.queueResumedAfterTaskId
  );
};

export const setSessionQueuePaused = (
  session: ChatSessionRecord,
  paused: boolean,
  timestamp: number,
): ChatSessionRecord => {
  if ((session.queuePausedAt !== undefined) === paused) {
    return session;
  }

  const nextSession = { ...session, updatedAt: timestamp };

  if (paused) {
    nextSession.queuePausedAt = timestamp;
    return nextSession;
  }

  delete nextSession.queuePausedAt;
  const failedTaskId = getLatestFailedTaskId(session);

  if (failedTaskId) {
    nextSession.queueResumedAfterTaskId = failedTaskId;
  }

  return nextSession;
};

export const findQueuedHead = (
  messages: readonly ChatSessionQueuedMessage[],
  sessionId: string,
  stopQueueOnFailure: boolean,
): ChatSessionQueuedMessage | undefined => {
  return messages.find(
    (message) =>
      message.sessionId === sessionId &&
      (stopQueueOnFailure || message.status !== "failed") &&
      !getBlockingRequestIteration(message, messages) &&
      message.task.trim().length > 0,
  );
};

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

export const canDispatchQueuedMessage = (
  message: ChatSessionQueuedMessage,
  session: ChatSessionRecord,
  unsettledDesktopTaskId: string | null,
): boolean => {
  if (unsettledDesktopTaskId || session.queuePausedAt !== undefined) {
    return false;
  }

  if (!message.blockedByTaskId) {
    return true;
  }

  return !getActiveChatOperationIds(session).includes(message.blockedByTaskId);
};

export const canStartQueuedMessageDispatch = (
  message: ChatSessionQueuedMessage,
  queuedHeadId: string | undefined,
  session: ChatSessionRecord,
  unsettledDesktopTaskId: string | null,
): boolean => {
  return (
    queuedHeadId === message.id &&
    canDispatchQueuedMessage(message, session, unsettledDesktopTaskId) &&
    getSessionOverviewStatus(session) !== "running"
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
    delete nextMessage.promptEnhancementAttempt;
    delete nextMessage.promptEnhancement;

    if (prompt.promptEnhancement) {
      nextMessage.promptEnhancement = prompt.promptEnhancement;
    }
  }

  return { message: nextMessage, prompt };
};

export const createConflictedQueuedMessageRecovery = (
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
    status: "queued",
    statusUpdatedAt: updatedAt,
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
  delete retry.promptEnhancementAttempt;
  return retry;
};
