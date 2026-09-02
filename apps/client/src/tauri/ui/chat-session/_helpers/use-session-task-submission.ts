import { useCallback, useRef, type MutableRefObject } from "react";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
} from "../../../../core/memory.js";
import type { RunMode } from "../../../../core/runtime-contract.generated.js";
import {
  isQuickVoiceSession,
  isSessionArchived,
  createTaskOutcomeFromExecution,
  getSessionOverviewStatus,
  type ChatSessionContextAttachment,
  type ChatSessionMessage,
  type ChatSessionMessagePromptEnhancement,
  type ChatSessionMessageSettings,
  type ChatSessionQueuedMessage,
  type ChatSessionQueuedPromptEnhancementRequest,
  type ChatSessionRecord,
  type ChatSessionTaskAction,
  type ChatSessionTaskOutcome,
} from "../../chat-session.model";
import type {
  TaskExecutionProgress,
  TaskExecutionResult,
} from "../../../../core/types.js";
import {
  loadUserMemorySettings,
  runDesktopTask,
  type RuntimeSnapshot,
} from "../../runtime";
import { getDesktopTaskRunFailure } from "../../desktop-task-error";
import {
  appendThinkingProgress,
  appendTerminalExecutionToThinkingTrace,
  createInitialThinkingTrace,
} from "../../task-thinking.model";
import {
  isComposerClearGuardCurrent,
  type ComposerClearGuard,
} from "./composer-submission";
import {
  appendContextAttachmentsToTask,
  areContextAttachmentRecordsEqual,
  createPromptHistoryUpdate,
  getImageAttachmentMediaReferences,
  getImageAttachmentPaths,
} from "./session-context-attachments";
import { getRenderedMessageContent } from "./execution-message.tsx";
import { createQueuedMessagePromptAfterOperationConflict } from "./prompt-enhancement";
import {
  createContinuationTaskPrompt,
  createExecutionFromTerminalProgress,
  createExecutionMessageContent,
  createRecoveredContinueTaskPrompt,
  createRecoveredRetryTaskPrompt,
  createRetryTaskPrompt,
  formatTaskExecutionError,
  getRecoveredTaskObjective,
  isRecoveredTaskCrashMessage,
} from "./session-task-continuation";
import {
  createConversationContextFromSession,
  getEffectiveSessionMode,
  removeSessionArchiveFlag,
} from "./session-shell";
import { normalizeSessionReasoningOverride } from "./session-reasoning";
import {
  applySessionMessageSettings,
  createSessionMessageSettings,
  getSessionMessageSettings,
} from "./session-message-settings";
import {
  CONTINUE_TASK_DISPLAY_CONTENT,
  createTaskAction,
  RETRY_TASK_DISPLAY_CONTENT,
} from "./task-action-prompts";
import type { ChatSessionRuntimeController } from "./use-chat-session-runtime";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";
import type { ChatSessionVoiceController } from "./use-chat-session-voice";
import type {
  DesktopTaskProgressRoute,
  UpdateThinkingTrace,
} from "./use-desktop-task-progress";

const TERMINAL_PROGRESS_STATE_BY_STATUS = {
  planned: "planned",
  executed: "completed",
  blocked: "blocked",
  cancelled: "cancelled",
  unsupported: "unsupported",
} satisfies Record<
  TaskExecutionResult["status"],
  TaskExecutionProgress["state"]
>;
const TERMINAL_PROGRESS_FALLBACK_DELAY_MS = 1_500;

const areContextAttachmentsEqual = (
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

const isTaskAlreadyActiveError = (error: unknown): boolean => {
  return getDesktopTaskRunFailure(error)?.kind === "task-already-active";
};

const getSessionOperationActiveTaskId = (error: unknown): string | null => {
  const failure = getDesktopTaskRunFailure(error);
  return failure?.kind === "operation-already-active"
    ? failure.activeTaskId
    : null;
};

const normalizeSubmitMessagePromptEnhancement = (
  promptEnhancement: ChatSessionMessagePromptEnhancement | undefined,
  visibleMessageContent: string,
): ChatSessionMessagePromptEnhancement | undefined => {
  const originalContent = promptEnhancement?.originalContent.trim();

  if (!originalContent || originalContent === visibleMessageContent.trim()) {
    return undefined;
  }

  return { originalContent };
};

const hasUserMessageForTask = (
  messages: readonly ChatSessionMessage[],
  taskId: string,
): boolean => {
  return messages.some(
    (message) =>
      message.role === "user" && (message.taskId ?? message.id) === taskId,
  );
};

export const reconcileQueuedMessagesForTaskSubmission = (input: {
  queuedSessionMessages: ChatSessionQueuedMessage[];
  queuedMessageTombstones: Record<string, number>;
  sessionId: string;
  conversationCutoffMessageId?: string;
  preserveQueuedMessagesCreatedAfter?: number;
  consumedQueuedMessageId?: string;
  timestamp: number;
}): {
  queuedSessionMessages: ChatSessionQueuedMessage[];
  queuedMessageTombstones: Record<string, number>;
} | null => {
  if (!input.conversationCutoffMessageId && !input.consumedQueuedMessageId) {
    return null;
  }

  const queuedSessionMessages = input.queuedSessionMessages.filter(
    (message) => {
      if (message.id === input.consumedQueuedMessageId) {
        return false;
      }

      if (
        !input.conversationCutoffMessageId ||
        message.sessionId !== input.sessionId
      ) {
        return true;
      }

      return (
        input.preserveQueuedMessagesCreatedAfter !== undefined &&
        message.createdAt >= input.preserveQueuedMessagesCreatedAfter
      );
    },
  );
  const queuedMessageIds = new Set(
    queuedSessionMessages.map((message) => message.id),
  );
  const queuedMessageTombstones = {
    ...input.queuedMessageTombstones,
  };

  for (const message of input.queuedSessionMessages) {
    if (!queuedMessageIds.has(message.id)) {
      queuedMessageTombstones[message.id] = input.timestamp;
    }
  }

  return {
    queuedSessionMessages,
    queuedMessageTombstones: Object.fromEntries(
      Object.entries(queuedMessageTombstones)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 2_048),
    ),
  };
};

const createTerminalThinkingProgress = (
  execution: TaskExecutionResult,
): TaskExecutionProgress => {
  return {
    task: execution.task,
    mode: execution.mode,
    state: TERMINAL_PROGRESS_STATE_BY_STATUS[execution.status],
    message: execution.summary,
    executedTools: execution.executedTools,
    outputSections: execution.outputSections,
    cancellable: false,
    ...(execution.reason ? { reason: execution.reason } : {}),
  };
};

export interface SubmitTaskToSessionOptions {
  sessionSnapshot: ChatSessionRecord;
  task: string;
  contextAttachments: ChatSessionContextAttachment[];
  clearDraft: boolean;
  createSessionIfMissing?: boolean;
  composerClearGuard?: ComposerClearGuard;
  activateSession: boolean;
  modeOverride?: RunMode;
  visibleMessageContent?: string;
  promptHistoryContent?: string;
  promptEnhancement?: ChatSessionMessagePromptEnhancement;
  promptEnhancementRequestOnConflict?: ChatSessionQueuedPromptEnhancementRequest;
  messageSettings?: ChatSessionMessageSettings;
  messageTaskAction?: ChatSessionTaskAction;
  conversationCutoffMessageId?: string;
  preserveQueuedMessagesCreatedAfter?: number;
  consumedQueuedMessageId?: string;
  queuedMessageRecovery?: ChatSessionQueuedMessage;
  onTaskStarted?: (taskId: string) => void;
}

export interface SessionOperationConflictSubmission {
  sessionId: string;
  activeTaskId: string;
  task: string;
  contextAttachments: ChatSessionContextAttachment[];
  visibleMessageContent: string;
  promptHistoryContent: string;
  promptEnhancement?: ChatSessionMessagePromptEnhancement;
  promptEnhancementRequest?: ChatSessionQueuedPromptEnhancementRequest;
  queuedMessageRecovery?: ChatSessionQueuedMessage;
}

const getMessageTaskId = (message: ChatSessionMessage): string =>
  message.taskId ?? message.id;

const getUserMessageContextAttachments = (
  message: ChatSessionMessage,
): ChatSessionContextAttachment[] => {
  return (message.contextAttachments ?? []).map((attachment) => ({
    ...attachment,
  }));
};

const rebuildPromptHistory = (
  messages: readonly ChatSessionMessage[],
): Pick<ChatSessionRecord, "promptHistory" | "promptContextHistory"> => {
  let history: Pick<
    ChatSessionRecord,
    "promptHistory" | "promptContextHistory"
  > = {
    promptHistory: [],
    promptContextHistory: [],
  };

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }

    const content =
      message.promptEnhancement?.originalContent.trim() ||
      getRenderedMessageContent(message).trim();

    if (!content) {
      continue;
    }

    history = createPromptHistoryUpdate(
      history,
      content,
      getUserMessageContextAttachments(message),
    );
  }

  return history;
};

const createConversationBranch = (
  session: ChatSessionRecord,
  cutoffMessageId: string,
): ChatSessionRecord | null => {
  const cutoffIndex = session.messages.findIndex(
    (message) => message.id === cutoffMessageId,
  );

  if (cutoffIndex < 0) {
    return null;
  }

  const cutoffMessage = session.messages[cutoffIndex];
  const messages = session.messages.slice(0, cutoffIndex);
  const removedMessages = session.messages.slice(cutoffIndex);
  const promptHistory = rebuildPromptHistory(messages);
  const branchTimestamp = Date.now();
  const messageTombstones = { ...session.messageTombstones };

  for (const message of removedMessages) {
    messageTombstones[message.id] = Math.max(
      messageTombstones[message.id] ?? 0,
      branchTimestamp,
    );
  }

  const cutoffCreatedAt = cutoffMessage?.createdAt;
  const sessionMemory =
    typeof cutoffCreatedAt === "number"
      ? session.sessionMemory.filter(
          (entry) => entry.createdAt < cutoffCreatedAt,
        )
      : session.sessionMemory;

  return {
    ...session,
    messages,
    messageTombstones,
    promptHistory: promptHistory.promptHistory,
    promptContextHistory: promptHistory.promptContextHistory,
    sessionMemory,
  };
};

const findSourceUserMessage = (
  session: ChatSessionRecord,
  agentMessage: ChatSessionMessage,
): ChatSessionMessage | null => {
  const agentMessageIndex = session.messages.findIndex(
    (message) => message.id === agentMessage.id,
  );

  if (agentMessageIndex < 0) {
    return null;
  }

  let nearestUserMessage: ChatSessionMessage | null = null;

  for (let index = agentMessageIndex - 1; index >= 0; index -= 1) {
    const candidate = session.messages[index];

    if (candidate?.role !== "user") {
      continue;
    }

    nearestUserMessage ??= candidate;

    if (
      agentMessage.taskId &&
      getMessageTaskId(candidate) === agentMessage.taskId
    ) {
      return candidate;
    }
  }

  return nearestUserMessage;
};

export const useSessionTaskSubmission = (options: {
  state: ChatSessionShellStateController;
  runtime: Pick<
    ChatSessionRuntimeController,
    | "applyLoadedUserMemorySettings"
    | "refreshWorkspaceMemoryEntries"
    | "refreshWorkspaceRuntimeSnapshot"
    | "runtimeSnapshot"
    | "userMemorySettings"
  >;
  voice: Pick<ChatSessionVoiceController, "stopSpeaking">;
  uiControlAvailability: RuntimeSnapshot["uiControl"] | undefined;
  aiContextMessageLimit: number;
  activeDesktopTasksRef: MutableRefObject<Map<string, string>>;
  unsettledDesktopTasksRef: MutableRefObject<Map<string, string>>;
  ignoredDesktopTaskIdsRef: MutableRefObject<Set<string>>;
  progressRoutesRef: MutableRefObject<Map<string, DesktopTaskProgressRoute>>;
  applySessionMessageLimit: (session: ChatSessionRecord) => ChatSessionRecord;
  updateThinkingTrace: UpdateThinkingTrace;
  onSessionOperationConflict?: (
    submission: SessionOperationConflictSubmission,
  ) => boolean;
  onComposerCleared?: (sessionId: string) => void;
}) => {
  const latestOptionsRef = useRef(options);
  latestOptionsRef.current = options;

  const appendAgentMessage = useCallback(
    (
      sessionId: string,
      taskId: string,
      content: string,
      source?: ChatSessionMessage["source"],
      userAnchor?: ChatSessionMessage,
      outcome?: ChatSessionTaskOutcome,
    ): string => {
      const messageId =
        source?.kind === "execution"
          ? `${taskId}-execution`
          : `${taskId}-agent`;
      const createdAt = Date.now();

      latestOptionsRef.current.state.updateSessionById(sessionId, (session) => {
        const restoredUserAnchorMessages =
          userAnchor && !hasUserMessageForTask(session.messages, taskId)
            ? [userAnchor]
            : [];
        const nextMessage: ChatSessionMessage = {
          id: messageId,
          taskId,
          role: "agent",
          content,
          createdAt,
          ...(source ? { source } : {}),
          ...(outcome ? { outcome } : {}),
        };
        const existingMessageIndex = session.messages.findIndex(
          (message) => message.id === messageId,
        );
        const nextMessages = [
          ...session.messages,
          ...restoredUserAnchorMessages,
        ];

        if (existingMessageIndex >= 0) {
          nextMessages[existingMessageIndex] = {
            ...nextMessage,
            createdAt:
              session.messages[existingMessageIndex]?.createdAt ?? createdAt,
          };
        } else {
          nextMessages.push(nextMessage);
        }

        return latestOptionsRef.current.applySessionMessageLimit({
          ...session,
          updatedAt: createdAt,
          messages: nextMessages,
        });
      });

      return messageId;
    },
    [],
  );

  const submitTaskToSession = useCallback(
    (submitOptions: SubmitTaskToSessionOptions): boolean => {
      const normalizedTask = submitOptions.task.trim();

      if (!normalizedTask) {
        return false;
      }

      const currentOptions = latestOptionsRef.current;
      const submittedSessionSnapshot = submitOptions.sessionSnapshot;
      const sessionId = submittedSessionSnapshot.id;
      const currentSession = currentOptions.state.getSessionById(sessionId);

      if (!currentSession && !submitOptions.createSessionIfMissing) {
        return false;
      }

      const sourceSessionSnapshot = submitOptions.messageSettings
        ? applySessionMessageSettings(
            currentSession ?? submittedSessionSnapshot,
            submitOptions.messageSettings,
          )
        : (currentSession ?? submittedSessionSnapshot);
      const hasActiveTaskForSession = [
        ...currentOptions.activeDesktopTasksRef.current.values(),
      ].includes(sessionId);

      if (
        hasActiveTaskForSession ||
        getSessionOverviewStatus(sourceSessionSnapshot) === "running"
      ) {
        return false;
      }

      const sessionSnapshot = submitOptions.conversationCutoffMessageId
        ? createConversationBranch(
            sourceSessionSnapshot,
            submitOptions.conversationCutoffMessageId,
          )
        : sourceSessionSnapshot;

      if (!sessionSnapshot) {
        return false;
      }

      const sessionSnapshotReasoning = normalizeSessionReasoningOverride(
        sessionSnapshot.reasoning,
        sessionSnapshot.provider,
        sessionSnapshot.model,
      );
      const contextAttachments = submitOptions.contextAttachments;
      const executionTask = appendContextAttachmentsToTask(
        normalizedTask,
        contextAttachments,
      );
      const visibleMessageContent =
        submitOptions.visibleMessageContent?.trim() || normalizedTask;
      const promptHistoryContent =
        submitOptions.promptHistoryContent?.trim() || normalizedTask;
      const promptEnhancement = normalizeSubmitMessagePromptEnhancement(
        submitOptions.promptEnhancement,
        visibleMessageContent,
      );
      const imagePaths = getImageAttachmentPaths(contextAttachments);
      const mediaAssetReferences =
        getImageAttachmentMediaReferences(contextAttachments);
      const isQuickTaskSessionSnapshot = isQuickVoiceSession(sessionSnapshot);
      const taskId = crypto.randomUUID();
      const taskStartedAt = Date.now();
      const userMessageContextAttachments = contextAttachments.map(
        (attachment) => ({ ...attachment }),
      );
      const messageSettings =
        submitOptions.messageSettings ??
        createSessionMessageSettings(sessionSnapshot);
      const userMessage: ChatSessionMessage = {
        id: `${taskId}-user`,
        taskId,
        role: "user",
        content: visibleMessageContent,
        createdAt: taskStartedAt,
        ...(submitOptions.messageTaskAction
          ? { taskAction: { ...submitOptions.messageTaskAction } }
          : {}),
        ...(userMessageContextAttachments.length > 0
          ? { contextAttachments: userMessageContextAttachments }
          : {}),
        ...(promptEnhancement ? { promptEnhancement } : {}),
        settings: { ...messageSettings },
      };
      let appendedPromptHistoryBaseline: Pick<
        ChatSessionRecord,
        "promptHistory" | "promptContextHistory"
      > | null = null;
      let composerCleared = false;
      const sessionWorkspace = sessionSnapshot.workspace;
      const sessionMode = submitOptions.modeOverride ?? sessionSnapshot.mode;
      const taskConversationContext = createConversationContextFromSession(
        sessionSnapshot,
        currentOptions.runtime.userMemorySettings.globalEnabled,
        currentOptions.uiControlAvailability,
        currentOptions.aiContextMessageLimit,
        currentOptions.runtime.runtimeSnapshot?.workspaceMemoryEnabled ??
          currentOptions.runtime.userMemorySettings.workspaceDefaultEnabled !==
            false,
      );
      const nextRunMode = getEffectiveSessionMode(
        sessionMode,
        currentOptions.runtime.runtimeSnapshot,
      );
      const initialThinkingMessage: ChatSessionMessage = {
        id: `${taskId}-thinking`,
        taskId,
        role: "agent",
        content: "",
        createdAt: taskStartedAt,
        source: {
          kind: "thinking",
          thinking: createInitialThinkingTrace(nextRunMode, taskStartedAt),
        },
      };
      let taskFailureReported = false;
      let taskFinalized = false;
      let latestAssistantText = "";
      let terminalFallbackMessageId: string | null = null;
      let terminalFallbackTimeoutId: number | undefined;

      currentOptions.voice.stopSpeaking();

      const clearTerminalFallbackTimeout = (): void => {
        if (terminalFallbackTimeoutId === undefined) {
          return;
        }

        window.clearTimeout(terminalFallbackTimeoutId);
        terminalFallbackTimeoutId = undefined;
      };

      const cleanupTaskTracking = (): void => {
        clearTerminalFallbackTimeout();
        currentOptions.progressRoutesRef.current.delete(taskId);
        currentOptions.activeDesktopTasksRef.current.delete(taskId);
      };

      const replaceWeakTerminalFallback = (
        execution: TaskExecutionResult,
      ): void => {
        if (!terminalFallbackMessageId) {
          return;
        }

        const fallbackMessageId = terminalFallbackMessageId;

        terminalFallbackMessageId = null;
        currentOptions.state.updateSessionById(sessionId, (session) => {
          let didReplace = false;
          const terminalProgress = createTerminalThinkingProgress(execution);
          const nextMessages = session.messages.map((message) => {
            if (
              message.taskId === taskId &&
              message.role === "agent" &&
              message.source?.kind === "thinking"
            ) {
              didReplace = true;
              return {
                ...message,
                source: {
                  kind: "thinking" as const,
                  thinking: appendThinkingProgress(
                    message.source.thinking,
                    terminalProgress,
                    Date.now(),
                  ),
                },
              };
            }

            if (
              message.id !== fallbackMessageId ||
              message.taskId !== taskId ||
              message.role !== "agent" ||
              message.source?.kind !== "execution"
            ) {
              return message;
            }

            didReplace = true;
            return {
              ...message,
              content: createExecutionMessageContent(execution),
              outcome: createTaskOutcomeFromExecution(execution),
              source: {
                ...message.source,
                execution,
                ...(message.source.thinking
                  ? {
                      thinking: appendTerminalExecutionToThinkingTrace(
                        message.source.thinking,
                        execution,
                        Date.now(),
                      ),
                    }
                  : {}),
              },
            };
          });

          if (!didReplace) {
            return session;
          }

          return currentOptions.applySessionMessageLimit({
            ...session,
            updatedAt: Date.now(),
            messages: nextMessages,
          });
        });
      };

      const createTerminalExecutionFromError = (
        error: unknown,
      ): {
        execution: TaskExecutionResult;
        outcome: ChatSessionTaskOutcome;
      } | null => {
        const failure = getDesktopTaskRunFailure(error);
        if (failure?.kind !== "cancelled" && failure?.kind !== "timed-out") {
          return null;
        }
        const isTimeout = failure.kind === "timed-out";

        return {
          execution: {
            task: executionTask,
            mode: nextRunMode,
            status: "cancelled",
            summary: isTimeout
              ? "Execution was stopped after exceeding the configured safety timeout."
              : "Execution was cancelled before the task completed.",
            executedTools: [],
            outputSections: [
              {
                title: isTimeout ? "Execution limit" : "Cancellation",
                lines: [`reason: ${failure.message}`],
              },
            ],
            reason: failure.message,
            ...(latestAssistantText
              ? {
                  response: {
                    markdown: latestAssistantText,
                    highlights: [],
                    relatedFiles: [],
                    verification: [],
                    followUps: [],
                  },
                }
              : {}),
          },
          outcome: {
            status: isTimeout ? "timed-out" : "cancelled",
            reason: failure.message,
          },
        };
      };

      const replaceTerminalFallbackWithFailure = (error: unknown): void => {
        if (!terminalFallbackMessageId) {
          return;
        }

        const fallbackMessageId = terminalFallbackMessageId;
        terminalFallbackMessageId = null;
        const reason = error instanceof Error ? error.message : String(error);

        currentOptions.state.updateSessionById(sessionId, (session) => {
          let changed = false;
          const messages = session.messages.map((message) => {
            if (message.id !== fallbackMessageId) {
              return message;
            }

            changed = true;
            const { source: _, ...messageWithoutSource } = message;
            return {
              ...messageWithoutSource,
              content: formatTaskExecutionError(error),
              outcome: { status: "failed" as const, reason },
            };
          });

          return changed
            ? currentOptions.applySessionMessageLimit({
                ...session,
                messages,
                updatedAt: Date.now(),
              })
            : session;
        });
      };

      const appendTerminalExecution = (
        execution: TaskExecutionResult,
        outcome = createTaskOutcomeFromExecution(execution),
      ): void => {
        cleanupTaskTracking();

        if (currentOptions.ignoredDesktopTaskIdsRef.current.has(taskId)) {
          currentOptions.ignoredDesktopTaskIdsRef.current.delete(taskId);
          return;
        }

        taskFinalized = true;
        currentOptions.state.updateSessionById(sessionId, (session) => {
          const timestamp = Date.now();
          const terminalProgress = createTerminalThinkingProgress(execution);
          const messagesWithoutRecoveredCrash = session.messages.filter(
            (message) =>
              (message.taskId ?? message.id) !== taskId ||
              !isRecoveredTaskCrashMessage(message),
          );
          const nextMessages = messagesWithoutRecoveredCrash.map((message) => {
            if (
              message.taskId !== taskId ||
              message.role !== "agent" ||
              message.source?.kind !== "thinking"
            ) {
              return message;
            }

            return {
              ...message,
              source: {
                kind: "thinking" as const,
                thinking: appendThinkingProgress(
                  message.source.thinking,
                  terminalProgress,
                  timestamp,
                ),
              },
            };
          });

          return currentOptions.applySessionMessageLimit({
            ...session,
            updatedAt: timestamp,
            messages: nextMessages,
          });
        });
        terminalFallbackMessageId = appendAgentMessage(
          sessionId,
          taskId,
          createExecutionMessageContent(execution),
          {
            kind: "execution",
            execution,
          },
          userMessage,
          outcome,
        );
      };

      const reportTaskFailure = (error: unknown): void => {
        const activeSessionTaskId = getSessionOperationActiveTaskId(error);

        if (activeSessionTaskId) {
          cleanupTaskTracking();
          currentOptions.state.updateSessionById(sessionId, (session) => {
            const promptHistory = [...session.promptHistory];
            const promptContextHistory = [...session.promptContextHistory];
            const alignedPromptContextHistory = promptHistory.map(
              (_entry, index) => promptContextHistory[index] ?? [],
            );
            let promptHistoryIndex = -1;
            let bestBaselineMatch = -1;

            if (appendedPromptHistoryBaseline) {
              const baselineContexts =
                appendedPromptHistoryBaseline.promptHistory.map(
                  (_entry, index) =>
                    appendedPromptHistoryBaseline?.promptContextHistory[
                      index
                    ] ?? [],
                );

              for (const [
                candidateIndex,
                candidate,
              ] of promptHistory.entries()) {
                if (
                  candidate !== promptHistoryContent ||
                  !areContextAttachmentsEqual(
                    alignedPromptContextHistory[candidateIndex] ?? [],
                    contextAttachments,
                  )
                ) {
                  continue;
                }

                let baselineIndex =
                  appendedPromptHistoryBaseline.promptHistory.length - 1;
                let currentIndex = candidateIndex - 1;
                let matchedBaselineEntries = 0;

                while (
                  baselineIndex >= 0 &&
                  currentIndex >= 0 &&
                  promptHistory[currentIndex] ===
                    appendedPromptHistoryBaseline.promptHistory[
                      baselineIndex
                    ] &&
                  areContextAttachmentsEqual(
                    alignedPromptContextHistory[currentIndex] ?? [],
                    baselineContexts[baselineIndex] ?? [],
                  )
                ) {
                  matchedBaselineEntries += 1;
                  baselineIndex -= 1;
                  currentIndex -= 1;
                }

                if (matchedBaselineEntries > bestBaselineMatch) {
                  bestBaselineMatch = matchedBaselineEntries;
                  promptHistoryIndex = candidateIndex;
                }
              }
            }

            if (promptHistoryIndex >= 0) {
              promptHistory.splice(promptHistoryIndex, 1);
              promptContextHistory.splice(promptHistoryIndex, 1);
            }

            return {
              ...session,
              messages: session.messages.filter(
                (message) => message.taskId !== taskId,
              ),
              promptHistory,
              promptContextHistory,
              updatedAt: Date.now(),
            };
          });

          const queuedPrompt = createQueuedMessagePromptAfterOperationConflict(
            {
              task: normalizedTask,
              visibleMessageContent,
              promptHistoryContent,
              ...(promptEnhancement ? { promptEnhancement } : {}),
            },
            submitOptions.promptEnhancementRequestOnConflict,
          );
          const queued = currentOptions.onSessionOperationConflict?.({
            sessionId,
            activeTaskId: activeSessionTaskId,
            contextAttachments: contextAttachments.map((attachment) => ({
              ...attachment,
            })),
            ...queuedPrompt,
            ...(submitOptions.queuedMessageRecovery
              ? {
                  queuedMessageRecovery: {
                    ...submitOptions.queuedMessageRecovery,
                    contextAttachments:
                      submitOptions.queuedMessageRecovery.contextAttachments.map(
                        (attachment) => ({ ...attachment }),
                      ),
                  },
                }
              : {}),
          });

          if (!queued) {
            currentOptions.state.updateSessionById(sessionId, (session) => {
              if (
                session.draft.trim().length > 0 ||
                session.draftContextAttachments.length > 0
              ) {
                return session;
              }

              const updatedAt = Date.now();
              return {
                ...session,
                draft: normalizedTask,
                draftContextAttachments: contextAttachments.map(
                  (attachment) => ({ ...attachment }),
                ),
                draftUpdatedAt: updatedAt,
                draftAttachmentsUpdatedAt: updatedAt,
                updatedAt,
              };
            });
          }
          return;
        }

        if (isTaskAlreadyActiveError(error)) {
          cleanupTaskTracking();
          return;
        }

        if (taskFinalized) {
          cleanupTaskTracking();
          replaceTerminalFallbackWithFailure(error);
          return;
        }

        const terminalResult = createTerminalExecutionFromError(error);

        if (terminalResult) {
          if ("execution" in terminalResult) {
            appendTerminalExecution(
              terminalResult.execution,
              terminalResult.outcome,
            );
          } else {
            appendTerminalExecution(terminalResult);
          }
          return;
        }

        cleanupTaskTracking();

        if (currentOptions.ignoredDesktopTaskIdsRef.current.has(taskId)) {
          currentOptions.ignoredDesktopTaskIdsRef.current.delete(taskId);
          return;
        }

        if (taskFailureReported) {
          return;
        }

        taskFailureReported = true;
        taskFinalized = true;
        appendAgentMessage(
          sessionId,
          taskId,
          formatTaskExecutionError(error),
          undefined,
          userMessage,
          {
            status: "failed",
            reason: error instanceof Error ? error.message : String(error),
          },
        );
      };

      const scheduleTerminalProgressFallback = (
        progress: TaskExecutionProgress,
      ): void => {
        if (taskFinalized || progress.state === "cancelled") {
          return;
        }

        const fallbackExecution = createExecutionFromTerminalProgress(
          progress,
          latestAssistantText,
        );

        if (!fallbackExecution) {
          return;
        }

        clearTerminalFallbackTimeout();
        terminalFallbackTimeoutId = window.setTimeout(() => {
          terminalFallbackTimeoutId = undefined;

          if (taskFinalized) {
            return;
          }

          appendTerminalExecution(fallbackExecution);
        }, TERMINAL_PROGRESS_FALLBACK_DELAY_MS);
      };

      currentOptions.progressRoutesRef.current.set(taskId, {
        onProgress: (progress) => {
          const assistantText = progress.assistantText?.trim();

          if (assistantText) {
            latestAssistantText = assistantText;
          }

          scheduleTerminalProgressFallback(progress);
        },
      });

      if (
        isSessionArchived(sessionSnapshot) &&
        currentOptions.state.sessionScopeFilter === "archived"
      ) {
        currentOptions.state.setSessionScopeFilter("open");
      }

      currentOptions.state.applyShellState((prev) => {
        const nextUpdatedAt = Date.now();
        let sessionFound = false;
        const nextSessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          sessionFound = true;

          const unarchivedSession = removeSessionArchiveFlag(session);
          const sessionWithoutArchive =
            submitOptions.conversationCutoffMessageId
              ? (createConversationBranch(
                  unarchivedSession,
                  submitOptions.conversationCutoffMessageId,
                ) ?? unarchivedSession)
              : unarchivedSession;
          const shouldClearComposer =
            submitOptions.clearDraft &&
            isComposerClearGuardCurrent(
              sessionWithoutArchive,
              submitOptions.composerClearGuard,
            );
          composerCleared ||= shouldClearComposer;
          const nextPromptHistory = createPromptHistoryUpdate(
            sessionWithoutArchive,
            promptHistoryContent,
            contextAttachments,
          );
          if (
            nextPromptHistory.promptHistory !==
            sessionWithoutArchive.promptHistory
          ) {
            appendedPromptHistoryBaseline = {
              promptHistory: [...sessionWithoutArchive.promptHistory],
              promptContextHistory:
                sessionWithoutArchive.promptContextHistory.map((attachments) =>
                  attachments.map((attachment) => ({ ...attachment })),
                ),
            };
          }
          const nextSession: ChatSessionRecord = {
            ...sessionWithoutArchive,
            draft: shouldClearComposer ? "" : sessionWithoutArchive.draft,
            draftContextAttachments: shouldClearComposer
              ? []
              : sessionWithoutArchive.draftContextAttachments,
            ...(shouldClearComposer
              ? {
                  draftUpdatedAt: nextUpdatedAt,
                  draftAttachmentsUpdatedAt: nextUpdatedAt,
                }
              : {}),
            sessionMemoryEnabled: isQuickVoiceSession(sessionWithoutArchive)
              ? false
              : sessionWithoutArchive.sessionMemoryEnabled,
            sessionMemory: isQuickVoiceSession(sessionWithoutArchive)
              ? []
              : sessionWithoutArchive.sessionMemory,
            updatedAt: nextUpdatedAt,
            messages: [
              ...sessionWithoutArchive.messages,
              userMessage,
              initialThinkingMessage,
            ],
            promptHistory: nextPromptHistory.promptHistory,
            promptContextHistory: nextPromptHistory.promptContextHistory,
          };

          return currentOptions.applySessionMessageLimit(nextSession);
        });

        if (!sessionFound) {
          if (!submitOptions.createSessionIfMissing) {
            return prev;
          }

          const nextPromptHistory = createPromptHistoryUpdate(
            sessionSnapshot,
            promptHistoryContent,
            contextAttachments,
          );
          if (
            nextPromptHistory.promptHistory !== sessionSnapshot.promptHistory
          ) {
            appendedPromptHistoryBaseline = {
              promptHistory: [...sessionSnapshot.promptHistory],
              promptContextHistory: sessionSnapshot.promptContextHistory.map(
                (attachments) =>
                  attachments.map((attachment) => ({ ...attachment })),
              ),
            };
          }
          const insertedSession = currentOptions.applySessionMessageLimit({
            ...sessionSnapshot,
            draft: submitOptions.clearDraft ? "" : sessionSnapshot.draft,
            draftContextAttachments: submitOptions.clearDraft
              ? []
              : sessionSnapshot.draftContextAttachments,
            ...(submitOptions.clearDraft
              ? {
                  draftUpdatedAt: nextUpdatedAt,
                  draftAttachmentsUpdatedAt: nextUpdatedAt,
                }
              : {}),
            updatedAt: nextUpdatedAt,
            messages: [
              ...sessionSnapshot.messages,
              userMessage,
              initialThinkingMessage,
            ],
            promptHistory: nextPromptHistory.promptHistory,
            promptContextHistory: nextPromptHistory.promptContextHistory,
          });
          composerCleared ||= submitOptions.clearDraft;

          return {
            ...prev,
            ...(submitOptions.activateSession
              ? { activeSessionId: sessionId }
              : {}),
            sessions: [insertedSession, ...prev.sessions],
          };
        }

        const queuedMessageReconciliation =
          reconcileQueuedMessagesForTaskSubmission({
            queuedSessionMessages: prev.queuedSessionMessages,
            queuedMessageTombstones: prev.queuedMessageTombstones,
            sessionId,
            conversationCutoffMessageId:
              submitOptions.conversationCutoffMessageId,
            preserveQueuedMessagesCreatedAfter:
              submitOptions.preserveQueuedMessagesCreatedAfter,
            consumedQueuedMessageId: submitOptions.consumedQueuedMessageId,
            timestamp: nextUpdatedAt,
          });

        return {
          ...prev,
          ...(submitOptions.activateSession
            ? { activeSessionId: sessionId }
            : {}),
          sessions: nextSessions,
          ...(queuedMessageReconciliation ?? {}),
        };
      });

      if (composerCleared) {
        currentOptions.onComposerCleared?.(sessionId);
      }

      if (submitOptions.activateSession) {
        currentOptions.state.setActiveSessionId(sessionId);
      }

      if (sessionId === currentOptions.state.activeSession.id) {
        currentOptions.state.setPromptHistoryIndex(null);
        currentOptions.state.setDraftBeforeHistory("");
      }

      currentOptions.activeDesktopTasksRef.current.set(taskId, sessionId);
      currentOptions.unsettledDesktopTasksRef.current.set(taskId, sessionId);
      submitOptions.onTaskStarted?.(taskId);

      const taskRunPromise = runDesktopTask(sessionWorkspace, executionTask, {
        conversationContext: taskConversationContext,
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
        ...(mediaAssetReferences.length > 0 ? { mediaAssetReferences } : {}),
        model: sessionSnapshot.model,
        provider: sessionSnapshot.provider,
        ...(sessionSnapshotReasoning
          ? { reasoning: sessionSnapshotReasoning }
          : {}),
        ...(sessionMode ? { mode: sessionMode } : {}),
        sessionId,
        taskId,
        operationKind: "chat-run",
      });

      void taskRunPromise
        .then((taskRun) => {
          currentOptions.unsettledDesktopTasksRef.current.delete(taskId);

          if (currentOptions.ignoredDesktopTaskIdsRef.current.has(taskId)) {
            cleanupTaskTracking();
            currentOptions.ignoredDesktopTaskIdsRef.current.delete(taskId);
            return;
          }

          const sessionMemoryUpdates =
            taskRun.execution.memoryUpdates
              ?.filter((update) => update.scope === "session")
              .map((update) => update.entry) ?? [];
          const wroteGlobalMemory =
            taskRun.execution.memoryUpdates?.some(
              (update) => update.scope === "global",
            ) ?? false;
          const wroteWorkspaceMemory =
            taskRun.execution.memoryUpdates?.some(
              (update) => update.scope === "workspace",
            ) ?? false;

          if (!isQuickTaskSessionSnapshot && sessionMemoryUpdates.length > 0) {
            currentOptions.state.updateSessionById(sessionId, (session) => {
              return currentOptions.applySessionMessageLimit({
                ...session,
                sessionMemory: mergeConversationMemoryEntries(
                  session.sessionMemory,
                  sessionMemoryUpdates,
                  MAX_SESSION_MEMORY_ENTRIES,
                ),
                updatedAt: Date.now(),
              });
            });
          }

          if (wroteGlobalMemory) {
            void currentOptions.runtime
              .refreshWorkspaceRuntimeSnapshot(sessionWorkspace)
              .then(() => loadUserMemorySettings())
              .then(currentOptions.runtime.applyLoadedUserMemorySettings)
              .catch((error) => {
                console.error("Failed to refresh user memory settings", error);
              });
          }

          if (wroteWorkspaceMemory) {
            void currentOptions.runtime
              .refreshWorkspaceMemoryEntries()
              .catch((error) => {
                console.error("Failed to refresh workspace memory", error);
              });
          }

          if (taskFinalized) {
            cleanupTaskTracking();
            replaceWeakTerminalFallback(taskRun.execution);
            return;
          }

          taskFinalized = true;
          cleanupTaskTracking();

          if (currentOptions.ignoredDesktopTaskIdsRef.current.has(taskId)) {
            currentOptions.ignoredDesktopTaskIdsRef.current.delete(taskId);
            return;
          }

          currentOptions.state.updateSessionById(sessionId, (session) => {
            const timestamp = Date.now();
            const terminalProgress = createTerminalThinkingProgress(
              taskRun.execution,
            );
            const messagesWithUserAnchor = hasUserMessageForTask(
              session.messages,
              taskId,
            )
              ? session.messages
              : [...session.messages, userMessage];
            const messagesWithoutRecoveredCrash = messagesWithUserAnchor.filter(
              (message) =>
                (message.taskId ?? message.id) !== taskId ||
                !isRecoveredTaskCrashMessage(message),
            );
            const nextMessages = messagesWithoutRecoveredCrash.map(
              (message) => {
                if (
                  message.taskId !== taskId ||
                  message.role !== "agent" ||
                  message.source?.kind !== "thinking"
                ) {
                  return message;
                }

                return {
                  ...message,
                  source: {
                    kind: "thinking" as const,
                    thinking: appendThinkingProgress(
                      message.source.thinking,
                      terminalProgress,
                      timestamp,
                    ),
                  },
                };
              },
            );

            const executionMessageId = `${taskId}-execution`;
            const existingExecutionMessage = session.messages.find(
              (message) => message.id === executionMessageId,
            );
            const existingExecutionThinking =
              existingExecutionMessage?.source?.kind === "execution"
                ? existingExecutionMessage.source.thinking
                : undefined;

            return currentOptions.applySessionMessageLimit({
              ...session,
              updatedAt: timestamp,
              messages: [
                ...nextMessages.filter(
                  (message) => message.id !== executionMessageId,
                ),
                {
                  id: executionMessageId,
                  taskId,
                  role: "agent",
                  content: createExecutionMessageContent(taskRun.execution),
                  createdAt: timestamp,
                  source: {
                    kind: "execution",
                    execution: taskRun.execution,
                    ...(existingExecutionThinking
                      ? {
                          thinking: appendTerminalExecutionToThinkingTrace(
                            existingExecutionThinking,
                            taskRun.execution,
                            timestamp,
                          ),
                        }
                      : {}),
                  },
                  outcome: createTaskOutcomeFromExecution(taskRun.execution),
                },
              ],
            });
          });
        })
        .catch((error) => {
          currentOptions.unsettledDesktopTasksRef.current.delete(taskId);
          reportTaskFailure(error);
        });

      return true;
    },
    [appendAgentMessage],
  );

  const getMessageSourceSession = useCallback(
    (message: ChatSessionMessage): ChatSessionRecord => {
      return (
        latestOptionsRef.current.state.shellState.sessions.find((session) =>
          session.messages.some((entry) => entry.id === message.id),
        ) ?? latestOptionsRef.current.state.activeSession
      );
    },
    [],
  );

  const handleEditMessage = useCallback(
    (message: ChatSessionMessage, content: string): boolean => {
      const normalizedContent = content.trim();

      if (message.role !== "user" || message.taskAction || !normalizedContent) {
        return false;
      }

      const sourceSession = getMessageSourceSession(message);
      const messageSettings = getSessionMessageSettings(message, sourceSession);

      return submitTaskToSession({
        sessionSnapshot: sourceSession,
        task: normalizedContent,
        contextAttachments: getUserMessageContextAttachments(message),
        messageSettings,
        clearDraft: false,
        activateSession: true,
        visibleMessageContent: normalizedContent,
        promptHistoryContent: normalizedContent,
        conversationCutoffMessageId: message.id,
      });
    },
    [getMessageSourceSession, submitTaskToSession],
  );

  const handleRetryMessage = useCallback(
    (message: ChatSessionMessage): boolean => {
      if (
        message.role !== "agent" ||
        message.source?.kind === "thinking" ||
        message.source?.kind === "preview"
      ) {
        return false;
      }

      const sourceSession = getMessageSourceSession(message);
      const sourceUserMessage = findSourceUserMessage(sourceSession, message);

      if (!sourceUserMessage) {
        return false;
      }

      const visibleMessageContent =
        getRenderedMessageContent(sourceUserMessage).trim();
      const task =
        sourceUserMessage.taskAction && message.source?.kind === "execution"
          ? message.source.execution.task.trim()
          : visibleMessageContent;

      if (!task || !visibleMessageContent) {
        return false;
      }

      return submitTaskToSession({
        sessionSnapshot: sourceSession,
        task,
        contextAttachments: getUserMessageContextAttachments(sourceUserMessage),
        messageSettings: getSessionMessageSettings(
          sourceUserMessage,
          sourceSession,
        ),
        clearDraft: false,
        activateSession: true,
        visibleMessageContent,
        promptHistoryContent:
          sourceUserMessage.promptEnhancement?.originalContent ??
          visibleMessageContent,
        ...(sourceUserMessage.promptEnhancement
          ? { promptEnhancement: sourceUserMessage.promptEnhancement }
          : {}),
        ...(sourceUserMessage.taskAction
          ? { messageTaskAction: { ...sourceUserMessage.taskAction } }
          : {}),
        conversationCutoffMessageId: sourceUserMessage.id,
      });
    },
    [getMessageSourceSession, submitTaskToSession],
  );

  const handleRetryTask = useCallback(
    (message: ChatSessionMessage): void => {
      if (isRecoveredTaskCrashMessage(message)) {
        const sourceSession = getMessageSourceSession(message);
        const recoveredObjective = getRecoveredTaskObjective(
          sourceSession,
          message,
        );

        const taskAction = recoveredObjective
          ? createTaskAction("retry-task", recoveredObjective)
          : null;

        if (!taskAction) {
          return;
        }

        submitTaskToSession({
          sessionSnapshot: sourceSession,
          task: createRecoveredRetryTaskPrompt(taskAction.objective),
          contextAttachments: [],
          clearDraft: false,
          activateSession: true,
          visibleMessageContent: RETRY_TASK_DISPLAY_CONTENT,
          promptHistoryContent: RETRY_TASK_DISPLAY_CONTENT,
          messageTaskAction: taskAction,
        });
        return;
      }

      if (message.source?.kind !== "execution") {
        return;
      }

      const execution = message.source.execution;

      if (
        execution.status !== "blocked" &&
        execution.status !== "cancelled" &&
        execution.status !== "unsupported"
      ) {
        return;
      }

      const sourceSession = getMessageSourceSession(message);
      const sourceUserMessage = findSourceUserMessage(sourceSession, message);
      const taskAction = createTaskAction(
        "retry-task",
        sourceUserMessage?.taskAction?.objective ?? execution.task,
      );

      if (!taskAction) {
        return;
      }

      submitTaskToSession({
        sessionSnapshot: sourceSession,
        task: createRetryTaskPrompt(execution, taskAction.objective),
        contextAttachments: [],
        clearDraft: false,
        activateSession: true,
        visibleMessageContent: RETRY_TASK_DISPLAY_CONTENT,
        promptHistoryContent: RETRY_TASK_DISPLAY_CONTENT,
        messageTaskAction: taskAction,
      });
    },
    [getMessageSourceSession, submitTaskToSession],
  );

  const handleContinueTask = useCallback(
    (message: ChatSessionMessage): void => {
      if (isRecoveredTaskCrashMessage(message)) {
        const sourceSession = getMessageSourceSession(message);
        const recoveredObjective = getRecoveredTaskObjective(
          sourceSession,
          message,
        );

        const taskAction = recoveredObjective
          ? createTaskAction("continue-task", recoveredObjective)
          : null;

        if (!taskAction) {
          return;
        }

        submitTaskToSession({
          sessionSnapshot: sourceSession,
          task: createRecoveredContinueTaskPrompt(taskAction.objective),
          contextAttachments: [],
          clearDraft: false,
          activateSession: true,
          visibleMessageContent: CONTINUE_TASK_DISPLAY_CONTENT,
          promptHistoryContent: CONTINUE_TASK_DISPLAY_CONTENT,
          messageTaskAction: taskAction,
        });
        return;
      }

      if (message.source?.kind !== "execution") {
        return;
      }

      const execution = message.source.execution;

      if (
        execution.status !== "executed" &&
        execution.status !== "blocked" &&
        execution.status !== "cancelled"
      ) {
        return;
      }

      const sourceSession = getMessageSourceSession(message);
      const sourceUserMessage = findSourceUserMessage(sourceSession, message);
      const taskAction = createTaskAction(
        "continue-task",
        sourceUserMessage?.taskAction?.objective ?? execution.task,
      );

      if (!taskAction) {
        return;
      }

      submitTaskToSession({
        sessionSnapshot: sourceSession,
        task: createContinuationTaskPrompt(execution, taskAction.objective),
        contextAttachments: [],
        clearDraft: false,
        activateSession: true,
        visibleMessageContent: CONTINUE_TASK_DISPLAY_CONTENT,
        promptHistoryContent: CONTINUE_TASK_DISPLAY_CONTENT,
        messageTaskAction: taskAction,
      });
    },
    [getMessageSourceSession, submitTaskToSession],
  );

  return {
    submitTaskToSession,
    handleEditMessage,
    handleRetryMessage,
    handleRetryTask,
    handleContinueTask,
  };
};
