import {
  createTaskOutcomeFromExecution,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  DesktopTaskRunProtocolError,
  getDesktopTaskRunFailure,
} from "../../desktop-task-error";
import type {
  DesktopTaskRunResponse,
  RecentDesktopTaskResult,
} from "../../runtime";
import { appendTerminalExecutionToThinkingTrace } from "../../task-thinking.model";
import {
  createExecutionMessageContent,
  formatTaskExecutionError,
  isRecoveredTaskCrashMessage,
} from "./session-task-continuation";

export const applyRecoveredTaskResult = (
  session: ChatSessionRecord,
  result: RecentDesktopTaskResult,
): ChatSessionRecord => {
  const taskId = result.id.trim();
  if (
    result.kind !== "chat-run" ||
    !taskId ||
    !session.messages.some(
      (message) =>
        message.role === "user" && (message.taskId ?? message.id) === taskId,
    )
  )
    return session;
  if (
    session.messages.some(
      (message) =>
        message.taskId === taskId &&
        message.role === "agent" &&
        (message.source?.kind === "execution" ||
          (message.outcome && !isRecoveredTaskCrashMessage(message))),
    )
  )
    return session;
  const timestamp = result.finishedAt > 0 ? result.finishedAt : Date.now();
  const messages = session.messages.filter(
    (message) =>
      message.taskId !== taskId || !isRecoveredTaskCrashMessage(message),
  );
  if (result.outcome.status === "failed") {
    const failure = getDesktopTaskRunFailure(result.outcome.failure);
    const error = failure
      ? new DesktopTaskRunProtocolError(failure)
      : new Error("Desktop task returned malformed failure state.");
    return {
      ...session,
      updatedAt: timestamp,
      messages: [
        ...messages,
        {
          id: `${taskId}-agent`,
          taskId,
          role: "agent",
          content: formatTaskExecutionError(error),
          createdAt: timestamp,
          outcome: {
            status:
              failure?.kind === "cancelled"
                ? "cancelled"
                : failure?.kind === "timed-out"
                  ? "timed-out"
                  : "failed",
            reason: error.message,
          },
        },
      ],
    };
  }
  const execution = (result.outcome.response as DesktopTaskRunResponse)
    ?.execution;
  if (!execution) return session;
  return {
    ...session,
    updatedAt: timestamp,
    messages: [
      ...messages.map((message) =>
        message.taskId === taskId && message.source?.kind === "thinking"
          ? {
              ...message,
              source: {
                kind: "thinking" as const,
                thinking: appendTerminalExecutionToThinkingTrace(
                  message.source.thinking,
                  execution,
                  timestamp,
                ),
              },
            }
          : message,
      ),
      {
        id: `${taskId}-execution`,
        taskId,
        role: "agent",
        content: createExecutionMessageContent(execution),
        createdAt: timestamp,
        source: { kind: "execution", execution },
        outcome: createTaskOutcomeFromExecution(execution),
      },
    ],
  };
};

export const reconcileRecoveredTaskResults = (
  state: ShellPersistedState,
  results: readonly RecentDesktopTaskResult[],
): ShellPersistedState => {
  let changed = false;
  const sessions = state.sessions.map((session) => {
    const next = results.reduce(applyRecoveredTaskResult, session);
    changed ||= next !== session;
    return next;
  });
  return changed ? { ...state, sessions } : state;
};
