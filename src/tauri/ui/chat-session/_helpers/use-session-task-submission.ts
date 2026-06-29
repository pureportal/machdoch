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
  type ChatSessionContextAttachment,
  type ChatSessionMessage,
  type ChatSessionRecord,
} from "../../chat-session.model";
import {
  loadUserMemorySettings,
  runDesktopTask,
  type RuntimeSnapshot,
} from "../../runtime";
import { createInitialThinkingTrace } from "../../task-thinking.model";
import {
  appendContextAttachmentsToTask,
  createPromptHistoryUpdate,
  getImageAttachmentPaths,
} from "./session-context-attachments";
import {
  createContinuationTaskPrompt,
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
import {
  CONTINUE_TASK_DISPLAY_CONTENT,
  RETRY_TASK_DISPLAY_CONTENT,
  type TaskActionPromptKind,
} from "./task-action-prompts";
import type { ChatSessionRuntimeController } from "./use-chat-session-runtime";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";
import type { ChatSessionVoiceController } from "./use-chat-session-voice";
import type { UpdateThinkingTrace } from "./use-desktop-task-progress";

export interface SubmitTaskToSessionOptions {
  sessionSnapshot: ChatSessionRecord;
  task: string;
  contextAttachments: ChatSessionContextAttachment[];
  clearDraft: boolean;
  activateSession: boolean;
  modeOverride?: RunMode;
  visibleMessageContent?: string;
  promptHistoryContent?: string;
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
  applySessionMessageLimit: (session: ChatSessionRecord) => ChatSessionRecord;
  updateThinkingTrace: UpdateThinkingTrace;
}) => {
  const appendAgentMessage = useCallback(
    (
      sessionId: string,
      taskId: string,
      content: string,
      source?: ChatSessionMessage["source"],
    ): void => {
      options.state.updateSessionById(sessionId, (session) => {
        return options.applySessionMessageLimit({
          ...session,
          updatedAt: Date.now(),
          messages: [
            ...session.messages,
            {
              id: crypto.randomUUID(),
              taskId,
              role: "agent",
              content,
              createdAt: Date.now(),
              ...(source ? { source } : {}),
            },
          ],
        });
      });
    },
    [options],
  );

  const submitTaskToSession = useCallback(
    (submitOptions: SubmitTaskToSessionOptions): void => {
      const normalizedTask = submitOptions.task.trim();

      if (!normalizedTask) {
        return;
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
      const imagePaths = getImageAttachmentPaths(contextAttachments);
      const { sessionSnapshot } = submitOptions;
      const isQuickTaskSessionSnapshot = isQuickVoiceSession(sessionSnapshot);
      const taskId = crypto.randomUUID();
      const userMessageCreatedAt = Date.now();
      const userMessageContextAttachments = contextAttachments.map(
        (attachment) => ({ ...attachment }),
      );
      const userMessage: ChatSessionMessage = {
        id: crypto.randomUUID(),
        taskId,
        role: "user",
        content: visibleMessageContent,
        createdAt: userMessageCreatedAt,
        ...(submitOptions.messageIntent
          ? { intent: submitOptions.messageIntent }
          : {}),
        ...(userMessageContextAttachments.length > 0
          ? { contextAttachments: userMessageContextAttachments }
          : {}),
      };
      const sessionId = sessionSnapshot.id;
      const sessionWorkspace = sessionSnapshot.workspace;
      const sessionMode = submitOptions.modeOverride ?? sessionSnapshot.mode;
      const taskConversationContext = createConversationContextFromSession(
        sessionSnapshot,
        options.runtime.userMemorySettings.globalEnabled,
        options.uiControlAvailability,
        options.aiContextMessageLimit,
      );
      const taskRunPromise = runDesktopTask(sessionWorkspace, executionTask, {
        conversationContext: taskConversationContext,
        ...(imagePaths.length > 0 ? { imagePaths } : {}),
        model: sessionSnapshot.model,
        provider: sessionSnapshot.provider,
        ...(sessionSnapshot.reasoning
          ? { reasoning: sessionSnapshot.reasoning }
          : {}),
        ...(sessionMode ? { mode: sessionMode } : {}),
        taskId,
      });
      const nextRunMode = getEffectiveSessionMode(
        sessionMode,
        options.runtime.runtimeSnapshot,
      );
      let taskFailureReported = false;

      options.voice.stopSpeaking();

      const reportTaskFailure = (error: unknown): void => {
        options.activeDesktopTasksRef.current.delete(taskId);

        if (options.ignoredDesktopTaskIdsRef.current.has(taskId)) {
          options.ignoredDesktopTaskIdsRef.current.delete(taskId);
          return;
        }

        if (taskFailureReported) {
          return;
        }

        taskFailureReported = true;
        appendAgentMessage(sessionId, taskId, formatTaskExecutionError(error));
      };

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
            ],
            promptHistory: nextPromptHistory.promptHistory,
            promptContextHistory: nextPromptHistory.promptContextHistory,
          };

          if (sessionSnapshot.mode) {
            nextSession.mode = sessionSnapshot.mode;
          } else {
            delete nextSession.mode;
          }

          if (sessionSnapshot.reasoning) {
            nextSession.reasoning = sessionSnapshot.reasoning;
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
            updatedAt: nextUpdatedAt,
            messages: [
              ...sessionSnapshot.messages,
              userMessage,
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
      options.updateThinkingTrace(sessionId, taskId, () => {
        return createInitialThinkingTrace(nextRunMode);
      });

      void taskRunPromise
        .then((taskRun) => {
          options.activeDesktopTasksRef.current.delete(taskId);

          if (options.ignoredDesktopTaskIdsRef.current.has(taskId)) {
            options.ignoredDesktopTaskIdsRef.current.delete(taskId);
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

          options.state.scheduleMessage(
            () => {
              if (options.ignoredDesktopTaskIdsRef.current.has(taskId)) {
                options.ignoredDesktopTaskIdsRef.current.delete(taskId);
                return;
              }

              appendAgentMessage(
                sessionId,
                taskId,
                createExecutionMessageContent(taskRun.execution),
                {
                  kind: "execution",
                  execution: taskRun.execution,
                },
              );
            },
            220,
          );
        })
        .catch(reportTaskFailure);
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
