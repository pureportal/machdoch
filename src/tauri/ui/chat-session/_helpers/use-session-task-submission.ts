import {
  useCallback,
  type MutableRefObject,
} from "react";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
} from "../../../../core/memory.js";
import type { RunMode } from "../../../../core/runtime-contract.generated.js";
import {
  isQuickVoiceSession,
  isSessionArchived,
  getSessionOverviewStatus,
  type ChatSessionContextAttachment,
  type ChatSessionMessage,
  type ChatSessionMessagePromptEnhancement,
  type ChatSessionRecord,
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
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
} from "../../task-thinking.model";
import {
  appendContextAttachmentsToTask,
  createPromptHistoryUpdate,
  getImageAttachmentPaths,
} from "./session-context-attachments";
import {
  createContinuationTaskPrompt,
  createExecutionFromTerminalProgress,
  createExecutionMessageContent,
  createRecoveredContinueTaskPrompt,
  createRecoveredRetryTaskPrompt,
  createRetryTaskPrompt,
  formatTaskExecutionError,
  getRecoveredTaskUserPrompt,
  isRecoveredTaskCrashMessage,
} from "./session-task-continuation";
import {
  createConversationContextFromSession,
  getEffectiveSessionMode,
  removeSessionArchiveFlag,
} from "./session-shell";
import { normalizeSessionReasoningOverride } from "./session-reasoning";
import {
  CONTINUE_TASK_DISPLAY_CONTENT,
  RETRY_TASK_DISPLAY_CONTENT,
  type TaskActionPromptKind,
} from "./task-action-prompts";
import type { ChatSessionRuntimeController } from "./use-chat-session-runtime";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";
import type { ChatSessionVoiceController } from "./use-chat-session-voice";
import type {
  HandleDesktopTaskProgress,
  UpdateThinkingTrace,
} from "./use-desktop-task-progress";

const TERMINAL_PROGRESS_STATE_BY_STATUS = {
  planned: "planned",
  executed: "completed",
  blocked: "blocked",
  cancelled: "cancelled",
  unsupported: "unsupported",
} satisfies Record<TaskExecutionResult["status"], TaskExecutionProgress["state"]>;
const TERMINAL_PROGRESS_FALLBACK_DELAY_MS = 1_500;

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
  activateSession: boolean;
  modeOverride?: RunMode;
  visibleMessageContent?: string;
  promptHistoryContent?: string;
  promptEnhancement?: ChatSessionMessagePromptEnhancement;
  messageIntent?: TaskActionPromptKind;
}

export const useSessionTaskSubmission = (options: {
  state: ChatSessionShellStateController;
  runtime: Pick<
    ChatSessionRuntimeController,
    | "applyLoadedUserMemorySettings"
    | "refreshWorkspaceRuntimeSnapshot"
    | "runtimeSnapshot"
    | "userMemorySettings"
  >;
  voice: Pick<ChatSessionVoiceController, "stopSpeaking">;
  uiControlAvailability: RuntimeSnapshot["uiControl"] | undefined;
  aiContextMessageLimit: number;
  activeDesktopTasksRef: MutableRefObject<Map<string, string>>;
  ignoredDesktopTaskIdsRef: MutableRefObject<Set<string>>;
  progressHandlersRef: MutableRefObject<Map<string, HandleDesktopTaskProgress>>;
  applySessionMessageLimit: (session: ChatSessionRecord) => ChatSessionRecord;
  updateThinkingTrace: UpdateThinkingTrace;
}) => {
  const appendAgentMessage = useCallback(
    (
      sessionId: string,
      taskId: string,
      content: string,
      source?: ChatSessionMessage["source"],
      userAnchor?: ChatSessionMessage,
    ): string => {
      const messageId = crypto.randomUUID();
      const createdAt = Date.now();

      options.state.updateSessionById(sessionId, (session) => {
        const restoredUserAnchorMessages =
          userAnchor && !hasUserMessageForTask(session.messages, taskId)
            ? [userAnchor]
            : [];

        return options.applySessionMessageLimit({
          ...session,
          updatedAt: createdAt,
          messages: [
            ...session.messages,
            ...restoredUserAnchorMessages,
            {
              id: messageId,
              taskId,
              role: "agent",
              content,
              createdAt,
              ...(source ? { source } : {}),
            },
          ],
        });
      });

      return messageId;
    },
    [options],
  );

  const submitTaskToSession = useCallback(
    (submitOptions: SubmitTaskToSessionOptions): boolean => {
      const normalizedTask = submitOptions.task.trim();

      if (!normalizedTask) {
        return false;
      }

      const submittedSessionSnapshot = submitOptions.sessionSnapshot;
      const sessionId = submittedSessionSnapshot.id;
      const sessionSnapshot =
        options.state.shellState.sessions.find(
          (session) => session.id === sessionId,
        ) ?? submittedSessionSnapshot;
      const sessionSnapshotReasoning = normalizeSessionReasoningOverride(
        sessionSnapshot.reasoning,
        sessionSnapshot.provider,
        sessionSnapshot.model,
      );
      const hasActiveTaskForSession = [
        ...options.activeDesktopTasksRef.current.values(),
      ].includes(sessionId);

      if (
        hasActiveTaskForSession ||
        getSessionOverviewStatus(sessionSnapshot) === "running"
      ) {
        return false;
      }

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
      const isQuickTaskSessionSnapshot = isQuickVoiceSession(sessionSnapshot);
      const taskId = crypto.randomUUID();
      const taskStartedAt = Date.now();
      const userMessageContextAttachments = contextAttachments.map(
        (attachment) => ({ ...attachment }),
      );
      const userMessage: ChatSessionMessage = {
        id: crypto.randomUUID(),
        taskId,
        role: "user",
        content: visibleMessageContent,
        createdAt: taskStartedAt,
        ...(submitOptions.messageIntent
          ? { intent: submitOptions.messageIntent }
          : {}),
        ...(userMessageContextAttachments.length > 0
          ? { contextAttachments: userMessageContextAttachments }
          : {}),
        ...(promptEnhancement ? { promptEnhancement } : {}),
      };
      const sessionWorkspace = sessionSnapshot.workspace;
      const sessionMode = submitOptions.modeOverride ?? sessionSnapshot.mode;
      const taskConversationContext = createConversationContextFromSession(
        sessionSnapshot,
        options.runtime.userMemorySettings.globalEnabled,
        options.uiControlAvailability,
        options.aiContextMessageLimit,
      );
      const nextRunMode = getEffectiveSessionMode(
        sessionMode,
        options.runtime.runtimeSnapshot,
      );
      const initialThinkingMessage: ChatSessionMessage = {
        id: crypto.randomUUID(),
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
      let terminalFallbackExecution: TaskExecutionResult | null = null;

      options.voice.stopSpeaking();

      const clearTerminalFallbackTimeout = (): void => {
        if (terminalFallbackTimeoutId === undefined) {
          return;
        }

        window.clearTimeout(terminalFallbackTimeoutId);
        terminalFallbackTimeoutId = undefined;
      };

      const cleanupTaskTracking = (): void => {
        clearTerminalFallbackTimeout();
        options.progressHandlersRef.current.delete(taskId);
        options.activeDesktopTasksRef.current.delete(taskId);
      };

      const replaceWeakTerminalFallback = (
        execution: TaskExecutionResult,
      ): void => {
        if (
          !terminalFallbackMessageId ||
          !execution.response?.markdown.trim()
        ) {
          return;
        }

        const fallbackMessageId = terminalFallbackMessageId;

        terminalFallbackMessageId = null;
        options.state.updateSessionById(sessionId, (session) => {
          let didReplace = false;
          const nextMessages = session.messages.map((message) => {
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
              source: {
                kind: "execution" as const,
                execution,
              },
            };
          });

          if (!didReplace) {
            return session;
          }

          return options.applySessionMessageLimit({
            ...session,
            updatedAt: Date.now(),
            messages: nextMessages,
          });
        });
      };

      const createTerminalExecutionFromError = (
        error: unknown,
      ): TaskExecutionResult | null => {
        const detail = error instanceof Error ? error.message : String(error);
        const normalizedDetail = detail.trim();

        if (!normalizedDetail) {
          return null;
        }

        const isTimeout = /\b(?:timeout|timed out|exceeded)\b/iu.test(
          normalizedDetail,
        );
        const isCancellation =
          isTimeout || /\b(?:cancelled|canceled|cancellation)\b/iu.test(normalizedDetail);

        if (!isCancellation) {
          return null;
        }

        return {
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
              lines: [`reason: ${normalizedDetail}`],
            },
          ],
          reason: normalizedDetail,
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
        };
      };

      const appendTerminalExecution = (execution: TaskExecutionResult): void => {
        cleanupTaskTracking();

        if (options.ignoredDesktopTaskIdsRef.current.has(taskId)) {
          options.ignoredDesktopTaskIdsRef.current.delete(taskId);
          return;
        }

        taskFinalized = true;
        options.state.updateSessionById(sessionId, (session) => {
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

          return options.applySessionMessageLimit({
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
        );
      };

      const reportTaskFailure = (error: unknown): void => {
        if (taskFinalized) {
          cleanupTaskTracking();
          return;
        }

        const terminalExecution =
          terminalFallbackExecution ?? createTerminalExecutionFromError(error);

        if (terminalExecution) {
          appendTerminalExecution(terminalExecution);
          return;
        }

        cleanupTaskTracking();

        if (options.ignoredDesktopTaskIdsRef.current.has(taskId)) {
          options.ignoredDesktopTaskIdsRef.current.delete(taskId);
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
        );
      };

      const scheduleTerminalProgressFallback = (
        progress: TaskExecutionProgress,
      ): void => {
        if (taskFinalized) {
          return;
        }

        const fallbackExecution = createExecutionFromTerminalProgress(
          progress,
          latestAssistantText,
        );

        if (!fallbackExecution) {
          return;
        }

        terminalFallbackExecution = fallbackExecution;
        clearTerminalFallbackTimeout();
        terminalFallbackTimeoutId = window.setTimeout(() => {
          terminalFallbackTimeoutId = undefined;

          if (taskFinalized) {
            return;
          }

          appendTerminalExecution(fallbackExecution);
        }, TERMINAL_PROGRESS_FALLBACK_DELAY_MS);
      };

      options.progressHandlersRef.current.set(taskId, (progress) => {
        const assistantText = progress.assistantText?.trim();

        if (assistantText) {
          latestAssistantText = assistantText;
        }

        scheduleTerminalProgressFallback(progress);
      });

      if (
        isSessionArchived(sessionSnapshot) &&
        options.state.sessionScopeFilter === "archived"
      ) {
        options.state.setSessionScopeFilter("open");
      }

      options.state.applyShellState((prev) => {
        const nextUpdatedAt = Date.now();
        let sessionFound = false;
        const nextSessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          sessionFound = true;

          const sessionWithoutArchive = removeSessionArchiveFlag(session);
          const nextPromptHistory = createPromptHistoryUpdate(
            sessionWithoutArchive,
            promptHistoryContent,
            contextAttachments,
          );
          const nextSession: ChatSessionRecord = {
            ...sessionWithoutArchive,
            workspace: sessionSnapshot.workspace,
            provider: sessionSnapshot.provider,
            model: sessionSnapshot.model,
            draft: submitOptions.clearDraft ? "" : sessionWithoutArchive.draft,
            draftContextAttachments: submitOptions.clearDraft
              ? []
              : sessionWithoutArchive.draftContextAttachments,
            ...(submitOptions.clearDraft
              ? { composerUpdatedAt: nextUpdatedAt }
              : {}),
            sessionMemoryEnabled: isQuickTaskSessionSnapshot
              ? false
              : sessionSnapshot.sessionMemoryEnabled,
            sessionMemory: isQuickTaskSessionSnapshot
              ? []
              : sessionWithoutArchive.sessionMemory,
            useGlobalMemory: sessionSnapshot.useGlobalMemory,
            uiControlEnabled: sessionSnapshot.uiControlEnabled,
            updatedAt: nextUpdatedAt,
            messages: [
              ...sessionWithoutArchive.messages,
              userMessage,
              initialThinkingMessage,
            ],
            promptHistory: nextPromptHistory.promptHistory,
            promptContextHistory: nextPromptHistory.promptContextHistory,
          };

          if (sessionSnapshot.mode) {
            nextSession.mode = sessionSnapshot.mode;
          } else {
            delete nextSession.mode;
          }

          if (sessionSnapshotReasoning) {
            nextSession.reasoning = sessionSnapshotReasoning;
          } else {
            delete nextSession.reasoning;
          }

          if (sessionSnapshot.specialSession) {
            nextSession.specialSession = sessionSnapshot.specialSession;
          } else {
            delete nextSession.specialSession;
          }

          if (sessionSnapshot.manualTitle) {
            nextSession.manualTitle = sessionSnapshot.manualTitle;
          } else {
            delete nextSession.manualTitle;
          }

          return options.applySessionMessageLimit(nextSession);
        });

        if (!sessionFound) {
          const nextPromptHistory = createPromptHistoryUpdate(
            sessionSnapshot,
            promptHistoryContent,
            contextAttachments,
          );
          const insertedSession = options.applySessionMessageLimit({
            ...sessionSnapshot,
            draft: submitOptions.clearDraft ? "" : sessionSnapshot.draft,
            draftContextAttachments: submitOptions.clearDraft
              ? []
              : sessionSnapshot.draftContextAttachments,
            ...(submitOptions.clearDraft
              ? { composerUpdatedAt: nextUpdatedAt }
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

          return {
            ...prev,
            ...(submitOptions.activateSession ? { activeSessionId: sessionId } : {}),
            sessions: [insertedSession, ...prev.sessions],
          };
        }

        return {
          ...prev,
          ...(submitOptions.activateSession ? { activeSessionId: sessionId } : {}),
          sessions: nextSessions,
        };
      });

      if (submitOptions.activateSession) {
        options.state.setActiveSessionId(sessionId);
      }

      if (submitOptions.clearDraft && sessionId === options.state.activeSession.id) {
        options.state.setDraftValue("");
      }

      if (sessionId === options.state.activeSession.id) {
        options.state.setPromptHistoryIndex(null);
        options.state.setDraftBeforeHistory("");
      }

      options.activeDesktopTasksRef.current.set(taskId, sessionId);

      const taskRunPromise = runDesktopTask(sessionWorkspace, executionTask, {
        conversationContext: taskConversationContext,
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
        model: sessionSnapshot.model,
        provider: sessionSnapshot.provider,
        ...(sessionSnapshotReasoning
          ? { reasoning: sessionSnapshotReasoning }
          : {}),
        ...(sessionMode ? { mode: sessionMode } : {}),
        taskId,
      });

      void taskRunPromise
        .then((taskRun) => {
          if (options.ignoredDesktopTaskIdsRef.current.has(taskId)) {
            cleanupTaskTracking();
            options.ignoredDesktopTaskIdsRef.current.delete(taskId);
            return;
          }

          if (taskFinalized) {
            replaceWeakTerminalFallback(taskRun.execution);
            cleanupTaskTracking();
            return;
          }

          taskFinalized = true;
          clearTerminalFallbackTimeout();
          options.progressHandlersRef.current.delete(taskId);

          const sessionMemoryUpdates =
            taskRun.execution.memoryUpdates
              ?.filter((update) => update.scope === "session")
              .map((update) => update.entry) ?? [];
          const wroteGlobalMemory =
            taskRun.execution.memoryUpdates?.some(
              (update) => update.scope === "global",
            ) ?? false;

          if (!isQuickTaskSessionSnapshot && sessionMemoryUpdates.length > 0) {
            options.state.updateSessionById(sessionId, (session) => {
              return options.applySessionMessageLimit({
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
            void options.runtime
              .refreshWorkspaceRuntimeSnapshot(sessionWorkspace)
              .then(() => loadUserMemorySettings())
              .then(options.runtime.applyLoadedUserMemorySettings)
              .catch((error) => {
                console.error("Failed to refresh user memory settings", error);
              });
          }

          if (options.ignoredDesktopTaskIdsRef.current.has(taskId)) {
            cleanupTaskTracking();
            options.ignoredDesktopTaskIdsRef.current.delete(taskId);
            return;
          }

          options.state.updateSessionById(sessionId, (session) => {
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
            const messagesWithoutRecoveredCrash =
              messagesWithUserAnchor.filter(
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

            return options.applySessionMessageLimit({
              ...session,
              updatedAt: timestamp,
              messages: [
                ...nextMessages,
                {
                  id: crypto.randomUUID(),
                  taskId,
                  role: "agent",
                  content: createExecutionMessageContent(taskRun.execution),
                  createdAt: timestamp,
                  source: {
                    kind: "execution",
                    execution: taskRun.execution,
                  },
                },
              ],
            });
          });
          options.activeDesktopTasksRef.current.delete(taskId);
        })
        .catch(reportTaskFailure);

      return true;
    },
    [appendAgentMessage, options],
  );

  const getMessageSourceSession = useCallback(
    (message: ChatSessionMessage): ChatSessionRecord => {
      return (
        options.state.shellState.sessions.find((session) =>
          session.messages.some((entry) => entry.id === message.id),
        ) ?? options.state.activeSession
      );
    },
    [options],
  );

  const handleRetryTask = useCallback(
    (message: ChatSessionMessage): void => {
      if (isRecoveredTaskCrashMessage(message)) {
        const sourceSession = getMessageSourceSession(message);
        const recoveredTask = getRecoveredTaskUserPrompt(sourceSession, message);

        if (!recoveredTask) {
          return;
        }

        submitTaskToSession({
          sessionSnapshot: sourceSession,
          task: createRecoveredRetryTaskPrompt(recoveredTask),
          contextAttachments: [],
          clearDraft: false,
          activateSession: true,
          visibleMessageContent: RETRY_TASK_DISPLAY_CONTENT,
          promptHistoryContent: RETRY_TASK_DISPLAY_CONTENT,
          messageIntent: "retry-task",
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

      submitTaskToSession({
        sessionSnapshot: getMessageSourceSession(message),
        task: createRetryTaskPrompt(execution),
        contextAttachments: [],
        clearDraft: false,
        activateSession: true,
        visibleMessageContent: RETRY_TASK_DISPLAY_CONTENT,
        promptHistoryContent: RETRY_TASK_DISPLAY_CONTENT,
        messageIntent: "retry-task",
      });
    },
    [getMessageSourceSession, submitTaskToSession],
  );

  const handleContinueTask = useCallback(
    (message: ChatSessionMessage): void => {
      if (isRecoveredTaskCrashMessage(message)) {
        const sourceSession = getMessageSourceSession(message);
        const recoveredTask = getRecoveredTaskUserPrompt(sourceSession, message);

        if (!recoveredTask) {
          return;
        }

        submitTaskToSession({
          sessionSnapshot: sourceSession,
          task: createRecoveredContinueTaskPrompt(recoveredTask),
          contextAttachments: [],
          clearDraft: false,
          activateSession: true,
          visibleMessageContent: CONTINUE_TASK_DISPLAY_CONTENT,
          promptHistoryContent: CONTINUE_TASK_DISPLAY_CONTENT,
          messageIntent: "continue-task",
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

      submitTaskToSession({
        sessionSnapshot: getMessageSourceSession(message),
        task: createContinuationTaskPrompt(execution),
        contextAttachments: [],
        clearDraft: false,
        activateSession: true,
        visibleMessageContent: CONTINUE_TASK_DISPLAY_CONTENT,
        promptHistoryContent: CONTINUE_TASK_DISPLAY_CONTENT,
        messageIntent: "continue-task",
      });
    },
    [getMessageSourceSession, submitTaskToSession],
  );

  return {
    submitTaskToSession,
    handleRetryTask,
    handleContinueTask,
  };
};
