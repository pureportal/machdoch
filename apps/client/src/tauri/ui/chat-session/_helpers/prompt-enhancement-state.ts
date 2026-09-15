import {
  isTransientChatOperationMessage,
  type ChatSessionQueuedMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import { getExecutionAttemptTaskId } from "./execution-retry-policy";
import type { PromptEnhancementAttempt } from "./prompt-enhancement-attempt";
import { isQueuedPromptEnhancementInputCurrent } from "./queued-message-lifecycle";

export const isPromptEnhancementCurrent = (input: {
  session: ChatSessionRecord | null | undefined;
  taskId: string;
  targetMessageId?: string;
  queuedMessage?: ChatSessionQueuedMessage;
  currentQueuedMessage?: ChatSessionQueuedMessage;
}): boolean => {
  return Boolean(
    input.session?.messages.some(
      (message) =>
        isTransientChatOperationMessage(message) &&
        message.taskId === input.taskId,
    ) &&
    (!input.targetMessageId ||
      input.session.messages.some(
        (message) => message.id === input.targetMessageId,
      )) &&
    (!input.queuedMessage ||
      (input.currentQueuedMessage &&
        input.currentQueuedMessage.status !== "failed" &&
        isQueuedPromptEnhancementInputCurrent(
          input.queuedMessage,
          input.currentQueuedMessage,
        ))),
  );
};

export const updatePromptEnhancementAttempt = (
  state: ShellPersistedState,
  input: {
    sessionId: string;
    taskId: string;
    attempt: PromptEnhancementAttempt;
    queuedMessage?: ChatSessionQueuedMessage;
  },
): ShellPersistedState => {
  const nextTaskId = getExecutionAttemptTaskId(input.attempt.execution);
  const updatedAt = input.attempt.updatedAt;
  return {
    ...state,
    sessions: state.sessions.map((session) =>
      session.id === input.sessionId
        ? {
            ...session,
            updatedAt,
            messages: session.messages.map((message) =>
              message.taskId === input.taskId &&
              isTransientChatOperationMessage(message) &&
              message.lifecycle
                ? {
                    ...message,
                    taskId: nextTaskId,
                    lifecycle: {
                      ...message.lifecycle,
                      operationId: nextTaskId,
                    },
                    promptEnhancementAttempt: input.attempt,
                  }
                : message,
            ),
          }
        : session,
    ),
    queuedSessionMessages: state.queuedSessionMessages.map((message) => {
      if (
        input.queuedMessage &&
        isQueuedPromptEnhancementInputCurrent(input.queuedMessage, message)
      ) {
        const failed =
          input.attempt.status === "failed" ||
          input.attempt.status === "cancelled";
        return {
          ...message,
          promptEnhancementAttempt: input.attempt,
          updatedAt,
          ...(failed
            ? {
                status: "failed" as const,
                statusUpdatedAt: updatedAt,
                failureMessage:
                  input.attempt.status === "cancelled"
                    ? "Enhancement cancelled."
                    : "Enhancement failed.",
              }
            : {}),
        };
      }
      if (
        nextTaskId !== input.taskId &&
        message.sessionId === input.sessionId &&
        message.blockedByTaskId === input.taskId
      ) {
        return {
          ...message,
          blockedByTaskId: nextTaskId,
          blockerUpdatedAt: updatedAt,
          updatedAt,
        };
      }
      return message;
    }),
  };
};
