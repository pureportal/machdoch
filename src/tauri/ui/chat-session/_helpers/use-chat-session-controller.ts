import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  MAX_SESSION_MEMORY_ENTRIES,
  mergeConversationMemoryEntries,
} from "../../../../core/memory.js";
import type { RunMode, TaskExecutionResult } from "../../../../core/types.js";
import {
  canArchiveSession,
  createSession,
  getSessionTitle,
  isSessionArchived,
  sortSessionsByUpdatedAt,
  type ChatSessionMessage,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  getDefaultModelForProvider,
  type RuntimeProvider,
} from "../../model-catalog";
import {
  loadUserMemorySettings,
  openWorkspacePath,
  runDesktopTask,
  subscribeToDesktopTaskProgress,
} from "../../runtime";
import {
  appendThinkingProgressLine,
  createInitialThinkingTrace,
} from "../../task-thinking.model";
import { getExecutionMessageContent } from "./execution-message.tsx";
import {
  createConversationContextFromSession,
  getEffectiveSessionMode,
  removeSessionArchiveFlag,
  removeSessionModeOverride,
  RUN_MODE_META,
  type SettingsSection,
} from "./session-shell";
import {
  createMemorySummaryState,
  createProviderChooserState,
} from "./session-shell-view-model";
import {
  closeDesktopWindow,
  minimizeDesktopWindow,
  stopTitlebarEvent,
  toggleDesktopWindowMaximize,
} from "./session-window-controls";
import { useChatSessionRuntime } from "./use-chat-session-runtime";
import { useChatSessionShellState } from "./use-chat-session-shell-state";

const formatTaskExecutionError = (error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);

  return `**Desktop handoff failed.** ${detail}`;
};

const createExecutionMessageContent = (
  execution: TaskExecutionResult,
): string => {
  return getExecutionMessageContent(execution);
};

export const useChatSessionController = () => {
  const state = useChatSessionShellState();
  const activeDesktopTasksRef = useRef<Map<string, string>>(new Map());
  const runtime = useChatSessionRuntime({
    catalogOpen: state.catalogOpen,
    activeSessionProvider: state.activeSession.provider,
    activeSessionWorkspace: state.activeSession.workspace,
  });
  const isDesktop = isTauri();
  const providerChooserState = createProviderChooserState({
    isDesktop,
    runtimeSnapshot: runtime.runtimeSnapshot,
    globalProviders: runtime.globalProviders,
  });
  const memorySummaryState = createMemorySummaryState({
    session: state.activeSession,
    userMemorySettings: runtime.userMemorySettings,
  });
  const currentSessionTitle = getSessionTitle(state.activeSession);
  const activeRunMode = getEffectiveSessionMode(
    state.activeSession.mode,
    runtime.runtimeSnapshot,
  );
  const activeRunModeMeta = RUN_MODE_META[activeRunMode];
  const defaultRunMode = runtime.runtimeSnapshot?.mode ?? "ask";
  const isUsingWorkspaceDefaultMode = !state.activeSession.mode;
  const hasActiveWorkspace = state.activeSession.workspace !== null;
  const canSendMessage = Boolean(state.activeSession.draft.trim());
  const uiControlAvailability = runtime.runtimeSnapshot?.uiControl;
  const isUiControlAvailable = uiControlAvailability?.available === true;
  const uiControlDescription = isUiControlAvailable
    ? uiControlAvailability.supportsWindowHandles
      ? "Let machdoch inspect the desktop, capture windows, drive mouse and keyboard, and on Windows target native window/control handles."
      : "Let machdoch inspect the desktop, capture windows, and drive mouse and keyboard when GUI automation is available."
    : (uiControlAvailability?.reason ??
      "Desktop UI control is unavailable for this workspace or environment right now.");

  const handleOpenSettings = (section: SettingsSection = "providers"): void => {
    state.setSettingsSection(section);
    state.setCatalogOpen(true);
  };

  const handleMinimizeWindow = (event: MouseEvent<HTMLButtonElement>): void => {
    stopTitlebarEvent(event);
    void minimizeDesktopWindow();
  };

  const handleToggleMaximizeWindow = (
    event: MouseEvent<HTMLButtonElement>,
  ): void => {
    stopTitlebarEvent(event);
    void toggleDesktopWindowMaximize();
  };

  const handleCloseWindow = (event: MouseEvent<HTMLButtonElement>): void => {
    stopTitlebarEvent(event);
    void closeDesktopWindow();
  };

  const appendAgentMessage = (
    sessionId: string,
    taskId: string,
    content: string,
    source?: ChatSessionMessage["source"],
  ): void => {
    state.updateSessionById(sessionId, (session) => ({
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
    }));
  };

  const updateThinkingTrace = useCallback(
    (
      sessionId: string,
      taskId: string,
      updater: (
        trace: ReturnType<typeof createInitialThinkingTrace>,
      ) => ReturnType<typeof createInitialThinkingTrace>,
    ): void => {
      state.updateSessionById(sessionId, (session) => {
        let thinkingMessageIndex = -1;

        for (let index = session.messages.length - 1; index >= 0; index -= 1) {
          const message = session.messages[index];

          if (
            message.taskId === taskId &&
            message.role === "agent" &&
            message.source?.kind === "thinking"
          ) {
            thinkingMessageIndex = index;
            break;
          }
        }

        const baseTrace =
          thinkingMessageIndex >= 0 &&
          session.messages[thinkingMessageIndex]?.source?.kind === "thinking"
            ? session.messages[thinkingMessageIndex].source.thinking
            : createInitialThinkingTrace(
                getEffectiveSessionMode(session.mode, runtime.runtimeSnapshot),
              );
        const nextTrace = updater(baseTrace);

        if (thinkingMessageIndex >= 0) {
          if (nextTrace === baseTrace) {
            return session;
          }

          const nextMessages = [...session.messages];
          const thinkingMessage = nextMessages[thinkingMessageIndex];

          if (!thinkingMessage || thinkingMessage.source?.kind !== "thinking") {
            return session;
          }

          nextMessages[thinkingMessageIndex] = {
            ...thinkingMessage,
            source: {
              kind: "thinking",
              thinking: nextTrace,
            },
          };

          return {
            ...session,
            updatedAt: Date.now(),
            messages: nextMessages,
          };
        }

        return {
          ...session,
          updatedAt: Date.now(),
          messages: [
            ...session.messages,
            {
              id: crypto.randomUUID(),
              taskId,
              role: "agent",
              content: "",
              createdAt: Date.now(),
              source: {
                kind: "thinking",
                thinking: nextTrace,
              },
            },
          ],
        };
      });
    },
    [runtime.runtimeSnapshot, state.updateSessionById],
  );

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToDesktopTaskProgress((progressEvent) => {
      const sessionId = activeDesktopTasksRef.current.get(progressEvent.taskId);

      if (!sessionId) {
        return;
      }

      updateThinkingTrace(sessionId, progressEvent.taskId, (trace) => {
        return appendThinkingProgressLine(
          trace,
          progressEvent.line,
          progressEvent.timestamp,
        );
      });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unsubscribe = unlisten;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [updateThinkingTrace]);

  const createNewSession = (): void => {
    state.applyShellState((prev) => {
      const provider =
        providerChooserState.chooserProviders.find(
          (entry) => entry === prev.lastSelectedProvider,
        ) ??
        providerChooserState.chooserProviders[0] ??
        prev.lastSelectedProvider;
      const session = createSession({
        workspace: state.activeSession.workspace,
        provider,
        ...(prev.lastSelectedMode ? { mode: prev.lastSelectedMode } : {}),
        model:
          prev.lastSelectedModelByProvider[provider] ??
          getDefaultModelForProvider(provider),
      });

      return {
        ...prev,
        activeSessionId: session.id,
        sessions: [session, ...prev.sessions],
      };
    });
  };

  const deleteSession = (sessionId: string): void => {
    state.applyShellState((prev) => {
      const remainingSessions = prev.sessions.filter(
        (session) => session.id !== sessionId,
      );

      if (remainingSessions.length === 0) {
        const replacement = createSession({
          workspace: state.activeSession.workspace,
          provider: prev.lastSelectedProvider,
          ...(prev.lastSelectedMode ? { mode: prev.lastSelectedMode } : {}),
          model:
            prev.lastSelectedModelByProvider[prev.lastSelectedProvider] ??
            getDefaultModelForProvider(prev.lastSelectedProvider),
        });

        return {
          ...prev,
          activeSessionId: replacement.id,
          sessions: [replacement],
        };
      }

      return {
        ...prev,
        activeSessionId:
          prev.activeSessionId === sessionId
            ? sortSessionsByUpdatedAt(remainingSessions)[0].id
            : prev.activeSessionId,
        sessions: remainingSessions,
      };
    });
  };

  const handleRenameCommit = (): void => {
    const trimmed = state.renameValue.trim();

    state.updateActiveSession((session) => {
      const sessionWithoutManualTitle = { ...session };

      delete sessionWithoutManualTitle.manualTitle;

      return trimmed.length > 0
        ? {
            ...sessionWithoutManualTitle,
            manualTitle: trimmed,
            updatedAt: Date.now(),
          }
        : {
            ...sessionWithoutManualTitle,
            updatedAt: Date.now(),
          };
    });

    state.setIsRenamingSession(false);
  };

  const handleRenameCancel = (): void => {
    state.setRenameValue(currentSessionTitle);
    state.setIsRenamingSession(false);
  };

  const handleSelectFolder = async (): Promise<void> => {
    if (!isDesktop) {
      state.updateActiveSession((session) => ({
        ...session,
        workspace: "/mock/workspace/path",
        updatedAt: Date.now(),
      }));
      return;
    }

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Workspace Folder",
      });

      if (selected && typeof selected === "string") {
        state.updateActiveSession((session) => ({
          ...session,
          workspace: selected,
          updatedAt: Date.now(),
        }));
      }
    } catch (error) {
      console.error("Failed to select folder", error);
    }
  };

  const handleSessionModelSelection = (
    provider: RuntimeProvider,
    model: string,
  ): void => {
    state.applyShellState((prev) => ({
      ...prev,
      lastSelectedProvider: provider,
      lastSelectedModelByProvider: {
        ...prev.lastSelectedModelByProvider,
        [provider]: model,
      },
      sessions: prev.sessions.map((session) =>
        session.id === prev.activeSessionId
          ? {
              ...session,
              provider,
              model,
              updatedAt: Date.now(),
            }
          : session,
      ),
    }));
  };

  const handleSessionModeSelection = (mode: RunMode | null): void => {
    state.applyShellState((prev) => {
      const nextUpdatedAt = Date.now();
      const nextSessions = prev.sessions.map((session) => {
        if (session.id !== prev.activeSessionId) {
          return session;
        }

        if (mode) {
          return {
            ...session,
            mode,
            updatedAt: nextUpdatedAt,
          };
        }

        return {
          ...removeSessionModeOverride(session),
          updatedAt: nextUpdatedAt,
        };
      });
      const nextState: ShellPersistedState = {
        ...prev,
        sessions: nextSessions,
      };

      if (mode) {
        nextState.lastSelectedMode = mode;
      } else {
        delete nextState.lastSelectedMode;
      }

      return nextState;
    });
  };

  const handleSessionMemoryEnabledChange = (enabled: boolean): void => {
    state.updateActiveSession((session) => ({
      ...session,
      sessionMemoryEnabled: enabled,
      updatedAt: Date.now(),
    }));
  };

  const handleUseGlobalMemoryChange = (enabled: boolean): void => {
    state.updateActiveSession((session) => ({
      ...session,
      useGlobalMemory: enabled,
      updatedAt: Date.now(),
    }));
  };

  const handleUiControlEnabledChange = (enabled: boolean): void => {
    state.updateActiveSession((session) => ({
      ...session,
      uiControlEnabled: enabled,
      updatedAt: Date.now(),
    }));
  };

  const handleDraftChange = (value: string): void => {
    state.setPromptHistoryIndex(null);
    state.setDraftBeforeHistory("");
    state.setDraftValue(value);
  };

  const handleComposerHistoryNavigation = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    if (state.activeSession.promptHistory.length === 0) {
      return;
    }

    event.preventDefault();

    if (event.key === "ArrowUp") {
      if (state.promptHistoryIndex === null) {
        state.setDraftBeforeHistory(state.activeSession.draft);

        const nextIndex = state.activeSession.promptHistory.length - 1;
        state.setPromptHistoryIndex(nextIndex);
        state.setDraftValue(state.activeSession.promptHistory[nextIndex]);
        return;
      }

      const nextIndex = Math.max(state.promptHistoryIndex - 1, 0);
      state.setPromptHistoryIndex(nextIndex);
      state.setDraftValue(state.activeSession.promptHistory[nextIndex]);
      return;
    }

    if (state.promptHistoryIndex === null) {
      return;
    }

    const nextIndex = state.promptHistoryIndex + 1;

    if (nextIndex >= state.activeSession.promptHistory.length) {
      state.setPromptHistoryIndex(null);
      state.setDraftValue(state.draftBeforeHistory);
      state.setDraftBeforeHistory("");
      return;
    }

    state.setPromptHistoryIndex(nextIndex);
    state.setDraftValue(state.activeSession.promptHistory[nextIndex]);
  };

  const handleOpenWorkspaceFile = (relativePath: string): void => {
    void openWorkspacePath(state.activeSession.workspace, relativePath).catch(
      (error) => {
        console.error("Failed to open workspace path", error);
      },
    );
  };

  const handleSend = (): void => {
    const task = state.activeSession.draft.trim();

    if (!task) {
      return;
    }

    const taskId = crypto.randomUUID();
    const sessionId = state.activeSession.id;
    const selectedProvider = state.activeSession.provider;
    const selectedModel = state.activeSession.model;
    const conversationContext = createConversationContextFromSession(
      state.activeSession,
      runtime.userMemorySettings.globalEnabled,
      uiControlAvailability,
    );
    const taskRunPromise = runDesktopTask(state.activeSession.workspace, task, {
      conversationContext,
      provider: selectedProvider,
      model: selectedModel,
      ...(state.activeSession.mode ? { mode: state.activeSession.mode } : {}),
      taskId,
    });
    let taskFailureReported = false;

    const reportTaskFailure = (error: unknown): void => {
      activeDesktopTasksRef.current.delete(taskId);

      if (taskFailureReported) {
        return;
      }

      taskFailureReported = true;
      appendAgentMessage(sessionId, taskId, formatTaskExecutionError(error));
    };

    const updatedPromptHistory =
      state.activeSession.promptHistory.at(-1) === task
        ? state.activeSession.promptHistory
        : [...state.activeSession.promptHistory, task].slice(-40);

    if (
      isSessionArchived(state.activeSession) &&
      state.sessionScopeFilter === "archived"
    ) {
      state.setSessionScopeFilter("open");
    }

    state.updateActiveSession((session) => {
      const sessionWithoutArchive = removeSessionArchiveFlag(session);

      return {
        ...sessionWithoutArchive,
        draft: "",
        updatedAt: Date.now(),
        messages: [
          ...sessionWithoutArchive.messages,
          {
            id: crypto.randomUUID(),
            taskId,
            role: "user",
            content: task,
            createdAt: Date.now(),
          },
        ],
        promptHistory: updatedPromptHistory,
      };
    });

    state.setPromptHistoryIndex(null);
    state.setDraftBeforeHistory("");
    activeDesktopTasksRef.current.set(taskId, sessionId);
    updateThinkingTrace(sessionId, taskId, () => {
      return createInitialThinkingTrace(activeRunMode);
    });

    void taskRunPromise
      .then((taskRun) => {
        activeDesktopTasksRef.current.delete(taskId);

        const sessionMemoryUpdates =
          taskRun.execution.memoryUpdates
            ?.filter((update) => update.scope === "session")
            .map((update) => update.entry) ?? [];
        const wroteGlobalMemory =
          taskRun.execution.memoryUpdates?.some(
            (update) => update.scope === "global",
          ) ?? false;

        if (sessionMemoryUpdates.length > 0) {
          state.updateSessionById(sessionId, (session) => ({
            ...session,
            sessionMemory: mergeConversationMemoryEntries(
              session.sessionMemory,
              sessionMemoryUpdates,
              MAX_SESSION_MEMORY_ENTRIES,
            ),
            updatedAt: Date.now(),
          }));
        }

        if (wroteGlobalMemory) {
          void runtime
            .refreshWorkspaceRuntimeSnapshot(state.activeSession.workspace)
            .then(() => loadUserMemorySettings())
            .then(runtime.applyLoadedUserMemorySettings)
            .catch((error) => {
              console.error("Failed to refresh user memory settings", error);
            });
        }

        state.scheduleMessage(
          () => {
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
  };

  return {
    isDesktop,
    catalogOpen: state.catalogOpen,
    setCatalogOpen: state.setCatalogOpen,
    hasAnyProvider: providerChooserState.hasAnyProvider,
    titlebar: {
      providerStatuses: providerChooserState.activeProviderStats,
      onMinimizeWindow: handleMinimizeWindow,
      onToggleMaximizeWindow: handleToggleMaximizeWindow,
      onCloseWindow: handleCloseWindow,
    },
    openProviderSettings: () => handleOpenSettings("providers"),
    sidebar: {
      totalSessions: state.shellState.sessions.length,
      activeSessionId: state.activeSession.id,
      filteredSessions: state.filteredSessions,
      sessionScopeFilter: state.sessionScopeFilter,
      sessionStatusFilter: state.sessionStatusFilter,
      onSessionScopeFilterChange: state.setSessionScopeFilter,
      onSessionStatusFilterChange: state.setSessionStatusFilter,
      onCreateSession: createNewSession,
      onActivateSession: (sessionId: string) => {
        state.applyShellState((prev) => ({
          ...prev,
          activeSessionId: sessionId,
        }));
      },
      onArchiveSession: (sessionId: string) => {
        state.updateSessionById(sessionId, (session) => {
          if (!canArchiveSession(session)) {
            return session;
          }

          return {
            ...session,
            archivedAt: Date.now(),
          };
        });
      },
    },
    header: {
      activeSession: state.activeSession,
      currentSessionTitle,
      isRenamingSession: state.isRenamingSession,
      renameValue: state.renameValue,
      activeRunModeLabel: activeRunModeMeta.label,
      activeRunModeBadgeClassName: activeRunModeMeta.badgeClassName,
      isUsingWorkspaceDefaultMode,
      runtimeSnapshot: runtime.runtimeSnapshot,
      runtimeLoading: runtime.runtimeLoading,
      runtimeError: runtime.runtimeError,
      onRenameValueChange: state.setRenameValue,
      onRenameCommit: handleRenameCommit,
      onRenameCancel: handleRenameCancel,
      onSelectFolder: handleSelectFolder,
      onCreateSession: createNewSession,
      onStartRename: () => {
        state.setRenameValue(currentSessionTitle);
        state.setIsRenamingSession(true);
      },
      onDeleteSession: () => deleteSession(state.activeSession.id),
    },
    conversation: {
      visibleMessages: state.visibleMessages,
      bottomRef: state.bottomRef,
      onOpenWorkspaceFile: handleOpenWorkspaceFile,
    },
    composer: {
      activeSession: state.activeSession,
      chooserProviders: providerChooserState.chooserProviders,
      activeRunMode,
      activeRunModeMeta,
      defaultRunMode,
      isUsingWorkspaceDefaultMode,
      hasActiveWorkspace,
      composerWorkspaceLabel: memorySummaryState.composerWorkspaceLabel,
      sessionMemoryDescription: memorySummaryState.sessionMemoryDescription,
      globalMemoryDescription: memorySummaryState.globalMemoryDescription,
      uiControlDescription,
      isGlobalMemoryAvailable: memorySummaryState.isGlobalMemoryAvailable,
      isGlobalMemoryActive: memorySummaryState.isGlobalMemoryActive,
      isUiControlAvailable,
      canSendMessage,
      onSelectFolder: handleSelectFolder,
      onSessionModelSelection: handleSessionModelSelection,
      onSessionModeSelection: handleSessionModeSelection,
      onSessionMemoryEnabledChange: handleSessionMemoryEnabledChange,
      onUseGlobalMemoryChange: handleUseGlobalMemoryChange,
      onUiControlEnabledChange: handleUiControlEnabledChange,
      onDraftChange: handleDraftChange,
      onComposerHistoryNavigation: handleComposerHistoryNavigation,
      onSend: handleSend,
    },
    settingsDialog: {
      settingsSection: state.settingsSection,
      onSettingsSectionChange: state.setSettingsSection,
      providerSetup: {
        provider: runtime.providerSetupProvider,
        keyValue: runtime.providerSetupKey,
        saving: runtime.providerSetupSaving,
        message: runtime.providerSetupMessage,
        onProviderChange: runtime.handleProviderSetupProviderChange,
        onOpenProviderPortal: runtime.handleProviderSetupPortalOpen,
        onKeyChange: runtime.handleProviderSetupKeyChange,
        onSave: runtime.handleProviderSetupSave,
      },
      webSearchSetup: {
        activeProvider: runtime.webSearchActiveProvider,
        provider: runtime.webSearchSetupProvider,
        keyValue: runtime.webSearchSetupKey,
        saving: runtime.webSearchSetupSaving,
        message: runtime.webSearchSetupMessage,
        onActiveProviderChange: runtime.handleWebSearchActiveProviderSave,
        onProviderChange: runtime.handleWebSearchSetupProviderChange,
        onKeyChange: runtime.handleWebSearchSetupKeyChange,
        onSave: runtime.handleWebSearchSetupSave,
      },
      memorySetup: {
        settings: runtime.userMemorySettings,
        saving: runtime.memorySetupSaving,
        message: runtime.memorySetupMessage,
        onGlobalEnabledChange: runtime.handleGlobalMemoryEnabledSave,
      },
    },
  };
};
