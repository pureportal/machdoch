import {
  useCallback,
  useRef,
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
const TASK_ALREADY_ACTIVE_ERROR_PREFIX = "MACHDOCH_TASK_ALREADY_ACTIVE:";
const SESSION_OPERATION_ALREADY_ACTIVE_ERROR_PREFIX =
  "MACHDOCH_OPERATION_ALREADY_ACTIVE:";

export interface ComposerClearGuard {
  draft: string;
  contextAttachments: ChatSessionContextAttachment[];
  composerUpdatedAt?: number;
  draftUpdatedAt?: number;
  draftAttachmentsUpdatedAt?: number;
}

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
        attachment.id === candidate.id &&
        attachment.path === candidate.path &&
        attachment.kind === candidate.kind &&
        attachment.name === candidate.name &&
        attachment.parent === candidate.parent
      );
    })
  );
};

const isComposerClearGuardCurrent = (
  session: ChatSessionRecord,
  guard: ComposerClearGuard | undefined,
): boolean => {
  if (!guard) {
    return true;
  }

  return (
    session.draft === guard.draft &&
    areContextAttachmentsEqual(
      session.draftContextAttachments,
      guard.contextAttachments,
    ) &&
    (session.draftUpdatedAt ?? session.composerUpdatedAt) ===
      (guard.draftUpdatedAt ?? guard.composerUpdatedAt) &&
    (session.draftAttachmentsUpdatedAt ?? session.composerUpdatedAt) ===
      (guard.draftAttachmentsUpdatedAt ?? guard.composerUpdatedAt)
  );
};

const isTaskAlreadyActiveError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);

  return message.includes(TASK_ALREADY_ACTIVE_ERROR_PREFIX);
};

const getSessionOperationActiveTaskId = (error: unknown): string | null => {
  const message = error instanceof Error ? error.message : String(error);
  const prefixIndex = message.indexOf(
    SESSION_OPERATION_ALREADY_ACTIVE_ERROR_PREFIX,
  );

  if (prefixIndex < 0) {
    return null;
  }

  const taskId = message
    .slice(prefixIndex + SESSION_OPERATION_ALREADY_ACTIVE_ERROR_PREFIX.length)
    .split(/\s/u, 1)[0]
    ?.trim();

  return taskId || null;
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
  messageIntent?: TaskActionPromptKind;
}

export interface SessionOperationConflictSubmission {
  sessionId: string;
  activeTaskId: string;
  task: string;
  contextAttachments: ChatSessionContextAttachment[];
  visibleMessageContent: string;
  promptHistoryContent: string;
  promptEnhancement?: ChatSessionMessagePromptEnhancement;
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
    ): string => {
      const messageId = source?.kind === "execution"
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
        };
        const existingMessageIndex = session.messages.findIndex(
          (message) => message.id === messageId,
        );
        const nextMessages = [...session.messages, ...restoredUserAnchorMessages];

        if (existingMessageIndex >= 0) {
          nextMessages[existingMessageIndex] = {
            ...nextMessage,
            createdAt: session.messages[existingMessageIndex]?.createdAt ?? createdAt,
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
      let latestShellState = currentOptions.state.shellState;

      currentOptions.state.applyShellState((currentState) => {
        latestShellState = currentState;
        return currentState;
      });

      const currentSession = latestShellState.sessions.find(
        (session) => session.id === sessionId,
      );

      if (!currentSession && !submitOptions.createSessionIfMissing) {
        return false;
      }

      const sessionSnapshot = currentSession ?? submittedSessionSnapshot;
      const sessionSnapshotReasoning = normalizeSessionReasoningOverride(
        sessionSnapshot.reasoning,
        sessionSnapshot.provider,
        sessionSnapshot.model,
      );
      const hasActiveTaskForSession = [
        ...currentOptions.activeDesktopTasksRef.current.values(),
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
        id: `${taskId}-user`,
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
      let terminalFallbackExecution: TaskExecutionResult | null = null;

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
        currentOptions.progressHandlersRef.current.delete(taskId);
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
              source: {
                kind: "execution" as const,
                execution,
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

              for (const [candidateIndex, candidate] of
                promptHistory.entries()) {
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

          const queued = currentOptions.onSessionOperationConflict?.({
            sessionId,
            activeTaskId: activeSessionTaskId,
            task: normalizedTask,
            contextAttachments: contextAttachments.map((attachment) => ({
              ...attachment,
            })),
            visibleMessageContent,
            promptHistoryContent,
            ...(promptEnhancement ? { promptEnhancement } : {}),
          });

          if (!queued) {
            currentOptions.state.updateSessionById(sessionId, (session) => {
              if (
                session.draft.trim().length > 0 ||
                session.draftContextAttachments.length > 0
              ) {
                return session;
              }

              const composerUpdatedAt = Date.now();
              return {
                ...session,
                draft: normalizedTask,
                draftContextAttachments: contextAttachments.map(
                  (attachment) => ({ ...attachment }),
                ),
                composerUpdatedAt,
                updatedAt: composerUpdatedAt,
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
          return;
        }

        const terminalExecution =
          terminalFallbackExecution ?? createTerminalExecutionFromError(error);

        if (terminalExecution) {
          appendTerminalExecution(terminalExecution);
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

      currentOptions.progressHandlersRef.current.set(taskId, (progress) => {
        const assistantText = progress.assistantText?.trim();

        if (assistantText) {
          latestAssistantText = assistantText;
        }

        scheduleTerminalProgressFallback(progress);
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

          const sessionWithoutArchive = removeSessionArchiveFlag(session);
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
                sessionWithoutArchive.promptContextHistory.map(
                  (attachments) =>
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
              ? { composerUpdatedAt: nextUpdatedAt }
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
          if (nextPromptHistory.promptHistory !== sessionSnapshot.promptHistory) {
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
          composerCleared ||= submitOptions.clearDraft;

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

      const taskRunPromise = runDesktopTask(sessionWorkspace, executionTask, {
        conversationContext: taskConversationContext,
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
        model: sessionSnapshot.model,
        provider: sessionSnapshot.provider,
        ...(sessionSnapshotReasoning
          ? { reasoning: sessionSnapshotReasoning }
          : {}),
        ...(sessionMode ? { mode: sessionMode } : {}),
        sessionId,
        taskId,
      });

      void taskRunPromise
        .then((taskRun) => {
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

          if (taskFinalized) {
            replaceWeakTerminalFallback(taskRun.execution);
            cleanupTaskTracking();
            return;
          }

          taskFinalized = true;
          clearTerminalFallbackTimeout();
          currentOptions.progressHandlersRef.current.delete(taskId);

          if (currentOptions.ignoredDesktopTaskIdsRef.current.has(taskId)) {
            cleanupTaskTracking();
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

            const executionMessageId = `${taskId}-execution`;

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
                  },
                },
              ],
            });
          });
          currentOptions.activeDesktopTasksRef.current.delete(taskId);
        })
        .catch(reportTaskFailure);

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
