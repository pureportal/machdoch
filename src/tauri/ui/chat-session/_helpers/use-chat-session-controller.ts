import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
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
  canDeleteSession,
  canRenameSession,
  createSession,
  createVisibleConversationMessages,
  getSessionOverviewStatus,
  getSessionTitle,
  isQuickVoiceSession,
  isSessionArchived,
  QUICK_VOICE_SESSION_KIND,
  sortSessionsByUpdatedAt,
  type ChatSessionMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
  trimSessionTaskGroupsToVisibleMessageLimit,
} from "../../chat-session.model";
import {
  getDefaultModelForProvider,
  type RuntimeProvider,
} from "../../model-catalog";
import {
  cancelDesktopTask,
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
  removeSessionProfileOverride,
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
import { useChatSessionSpeechInput } from "./use-chat-session-speech-input";
import { useChatSessionShellState } from "./use-chat-session-shell-state";
import { useChatSessionVoice } from "./use-chat-session-voice";

const formatTaskExecutionError = (error: unknown): string => {
  const detail = error instanceof Error ? error.message : String(error);

  return `**Desktop handoff failed.** ${detail}`;
};

const createExecutionMessageContent = (
  execution: TaskExecutionResult,
): string => {
  return getExecutionMessageContent(execution);
};

const appendTranscriptToDraft = (draft: string, transcript: string): string => {
  const normalizedTranscript = transcript.trim();

  if (!normalizedTranscript) {
    return draft;
  }

  if (!draft.trim()) {
    return normalizedTranscript;
  }

  return /\s$/u.test(draft) ? `${draft}${normalizedTranscript}` : `${draft}\n${normalizedTranscript}`;
};

const clampQuickVoiceMessageLimit = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 50;
  }

  return Math.min(200, Math.max(10, Math.round(value)));
};

export interface UseChatSessionControllerOptions {
  isolateActiveSession?: boolean;
  enableSessionAutoProfile?: boolean;
}

export const useChatSessionController = (
  options: UseChatSessionControllerOptions = {},
) => {
  const enableSessionAutoProfile = options.enableSessionAutoProfile !== false;
  const state = useChatSessionShellState({
    isolateActiveSession: options.isolateActiveSession,
  });
  const activeDesktopTasksRef = useRef<Map<string, string>>(new Map());
  const ignoredDesktopTaskIdsRef = useRef<Set<string>>(new Set());
  const runtime = useChatSessionRuntime({
    catalogOpen: state.catalogOpen,
    activeSessionProvider: state.activeSession.provider,
    activeSessionProfile: state.activeSession.profile,
    activeSessionWorkspace: state.activeSession.workspace,
  });
  const voice = useChatSessionVoice({
    activeSessionId: state.activeSession.id,
    settings: state.shellState.voice,
    aiVoiceSettings: runtime.userVoiceSettings,
    visibleMessages: state.visibleMessages,
    onSettingsChange: (updater) => {
      state.applyShellState((prev) => ({
        ...prev,
        voice: updater(prev.voice),
      }));
    },
  });
  const handleSpeechTranscript = useCallback(
    (sessionId: string, transcript: string): void => {
      const normalizedTranscript = transcript.trim();

      if (!normalizedTranscript) {
        return;
      }

      if (sessionId === state.activeSession.id) {
        state.setPromptHistoryIndex(null);
        state.setDraftBeforeHistory("");
        state.setDraftValue(
          appendTranscriptToDraft(state.activeSession.draft, normalizedTranscript),
        );
        return;
      }

      state.updateSessionById(sessionId, (session) => ({
        ...session,
        draft: appendTranscriptToDraft(session.draft, normalizedTranscript),
      }));
    },
    [
      state.activeSession.draft,
      state.activeSession.id,
      state.setDraftBeforeHistory,
      state.setDraftValue,
      state.setPromptHistoryIndex,
      state.updateSessionById,
    ],
  );
  const speechInput = useChatSessionSpeechInput({
    activeSessionId: state.activeSession.id,
    settings: runtime.userSpeechToTextSettings,
    onTranscript: handleSpeechTranscript,
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
  const quickTaskSession = useMemo(() => {
    return state.shellState.sessions.find(isQuickVoiceSession) ?? null;
  }, [state.shellState.sessions]);
  const quickTaskVisibleMessages = useMemo(() => {
    return quickTaskSession
      ? createVisibleConversationMessages(quickTaskSession.messages)
      : [];
  }, [quickTaskSession]);
  const activeRunMode = getEffectiveSessionMode(
    state.activeSession.mode,
    runtime.runtimeSnapshot,
  );
  const activeRunModeMeta = RUN_MODE_META[activeRunMode];
  const defaultRunMode = runtime.runtimeSnapshot?.mode ?? "ask";
  const isUsingWorkspaceDefaultMode = !state.activeSession.mode;
  const hasActiveWorkspace = state.activeSession.workspace !== null;
  const canSendMessage =
    Boolean(state.activeSession.draft.trim()) &&
    !speechInput.recording &&
    !speechInput.transcribing;
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

  const handleSpeechInputAction = (): void => {
    if (!speechInput.browserSupported) {
      return;
    }

    if (!speechInput.enabled && !speechInput.recording && !speechInput.transcribing) {
      handleOpenSettings("voice");
      return;
    }

    speechInput.toggleRecording();
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

  const applySessionMessageLimit = useCallback(
    (session: ChatSessionRecord): ChatSessionRecord => {
      if (!isQuickVoiceSession(session)) {
        return session;
      }

      return {
        ...session,
        messages: trimSessionTaskGroupsToVisibleMessageLimit(
          session.messages,
          clampQuickVoiceMessageLimit(
            runtime.userDesktopSettings.quickVoiceMaxMessages,
          ),
        ),
      };
    },
    [runtime.userDesktopSettings.quickVoiceMaxMessages],
  );

  const appendAgentMessage = (
    sessionId: string,
    taskId: string,
    content: string,
    source?: ChatSessionMessage["source"],
  ): void => {
    state.updateSessionById(sessionId, (session) => {
      return applySessionMessageLimit({
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

          return applySessionMessageLimit({
            ...session,
            updatedAt: Date.now(),
            messages: nextMessages,
          });
        }

        return applySessionMessageLimit({
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
        });
      });
    },
    [applySessionMessageLimit, runtime.runtimeSnapshot, state.updateSessionById],
  );

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToDesktopTaskProgress((progressEvent) => {
      const sessionId = activeDesktopTasksRef.current.get(progressEvent.taskId);

      if (
        !sessionId ||
        ignoredDesktopTaskIdsRef.current.has(progressEvent.taskId)
      ) {
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
    const provider =
      providerChooserState.chooserProviders.find(
        (entry) => entry === state.shellState.lastSelectedProvider,
      ) ??
      providerChooserState.chooserProviders[0] ??
      state.shellState.lastSelectedProvider;
    const session = createSession({
      workspace: state.activeSession.workspace,
      provider,
      ...(state.shellState.lastSelectedProfile
        ? { profile: state.shellState.lastSelectedProfile }
        : {}),
      ...(state.shellState.lastSelectedMode
        ? { mode: state.shellState.lastSelectedMode }
        : {}),
      model:
        state.shellState.lastSelectedModelByProvider[provider] ??
        getDefaultModelForProvider(provider),
    });

    state.applyShellState((prev) => ({
      ...prev,
      activeSessionId: session.id,
      sessions: [session, ...prev.sessions],
    }));
    state.setActiveSessionId(session.id);
  };

  const deleteSession = (sessionId: string): void => {
    let nextActiveSessionId = state.activeSessionId;

    state.applyShellState((prev) => {
      const targetSession = prev.sessions.find((session) => session.id === sessionId);

      if (targetSession && !canDeleteSession(targetSession)) {
        return prev;
      }

      const remainingSessions = prev.sessions.filter(
        (session) => session.id !== sessionId,
      );

      if (remainingSessions.length === 0) {
        const replacement = createSession({
          workspace: state.activeSession.workspace,
          provider: prev.lastSelectedProvider,
          ...(prev.lastSelectedProfile
            ? { profile: prev.lastSelectedProfile }
            : {}),
          ...(prev.lastSelectedMode ? { mode: prev.lastSelectedMode } : {}),
          model:
            prev.lastSelectedModelByProvider[prev.lastSelectedProvider] ??
            getDefaultModelForProvider(prev.lastSelectedProvider),
        });
        nextActiveSessionId = replacement.id;

        return {
          ...prev,
          activeSessionId: replacement.id,
          sessions: [replacement],
        };
      }

      if (state.activeSessionId === sessionId) {
        nextActiveSessionId = sortSessionsByUpdatedAt(remainingSessions)[0].id;
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

    if (nextActiveSessionId !== state.activeSessionId) {
      state.setActiveSessionId(nextActiveSessionId);
    }
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
        session.id === state.activeSessionId
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
        if (session.id !== state.activeSessionId) {
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

  const handleSessionProfileSelection = useCallback(
    async (profile: string | null): Promise<void> => {
      const nextSnapshot = await runtime.refreshWorkspaceRuntimeSnapshot(
        state.activeSession.workspace,
        profile,
      );

      if (profile && !nextSnapshot) {
        return;
      }

      state.applyShellState((prev) => {
        const activeSession = prev.sessions.find(
          (session) => session.id === state.activeSessionId,
        );

        if (!activeSession) {
          return prev;
        }

        const nextProvider =
          nextSnapshot?.provider && nextSnapshot.provider !== "unconfigured"
            ? nextSnapshot.provider
            : activeSession.provider;
        const nextModel = nextSnapshot?.model ?? activeSession.model;
        const nextUpdatedAt = Date.now();
        const nextSessions = prev.sessions.map((session) => {
          if (session.id !== state.activeSessionId) {
            return session;
          }

          const profileScopedSession = profile
            ? {
                ...session,
                profile,
                updatedAt: nextUpdatedAt,
              }
            : {
                ...removeSessionProfileOverride(session),
                updatedAt: nextUpdatedAt,
              };
          const nextSession = removeSessionModeOverride(profileScopedSession);

          return {
            ...nextSession,
            provider: nextProvider,
            model: nextModel,
          };
        });
        const nextState: ShellPersistedState = {
          ...prev,
          lastSelectedProvider: nextProvider,
          lastSelectedModelByProvider: {
            ...prev.lastSelectedModelByProvider,
            [nextProvider]: nextModel,
          },
          sessions: nextSessions,
        };

        if (profile) {
          nextState.lastSelectedProfile = profile;
        } else {
          delete nextState.lastSelectedProfile;
        }

        delete nextState.lastSelectedMode;

        return nextState;
      });
    },
    [
      runtime.refreshWorkspaceRuntimeSnapshot,
      state.activeSessionId,
      state.activeSession.workspace,
      state.applyShellState,
    ],
  );

  useEffect(() => {
    if (!enableSessionAutoProfile) {
      return;
    }

    if (!state.activeSession.workspace || state.activeSession.profile) {
      return;
    }

    if (state.shellState.lastSelectedProfile) {
      return;
    }

    const runtimeSnapshot = runtime.runtimeSnapshot;

    if (!runtimeSnapshot) {
      return;
    }

    const autoProfile =
      runtimeSnapshot.activeProfile?.trim() ||
      (runtimeSnapshot.availableProfiles.length === 1
        ? runtimeSnapshot.availableProfiles[0]?.name.trim()
        : undefined);

    if (!autoProfile) {
      return;
    }

    void handleSessionProfileSelection(autoProfile).catch((error) => {
      console.error("Failed to auto-apply runtime profile", error);
    });
  }, [
    enableSessionAutoProfile,
    handleSessionProfileSelection,
    runtime.runtimeSnapshot,
    state.activeSession.profile,
    state.activeSession.workspace,
    state.shellState.lastSelectedProfile,
  ]);

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

  const handleCancel = (): void => {
    let targetTaskId: string | null = null;

    for (const [taskId, sessionId] of activeDesktopTasksRef.current.entries()) {
      if (sessionId === state.activeSession.id) {
        targetTaskId = taskId;
        break;
      }
    }

    if (targetTaskId) {
      void cancelDesktopTask(targetTaskId).catch((error) => {
        console.error("Failed to cancel desktop task:", error);
      });
    }
  };

  const buildQuickVoiceSessionSnapshot = useCallback((): ChatSessionRecord => {
    const existingQuickVoiceSession = state.shellState.sessions.find(
      isQuickVoiceSession,
    );
    const baseSession =
      existingQuickVoiceSession ??
      createSession({
        id: crypto.randomUUID(),
        specialSession: QUICK_VOICE_SESSION_KIND,
      });
    const nextSession: ChatSessionRecord = {
      ...baseSession,
      specialSession: QUICK_VOICE_SESSION_KIND,
      workspace: state.activeSession.workspace,
      provider: state.activeSession.provider,
      model: state.activeSession.model,
      sessionMemoryEnabled: state.activeSession.sessionMemoryEnabled,
      useGlobalMemory: state.activeSession.useGlobalMemory,
      uiControlEnabled: state.activeSession.uiControlEnabled,
      updatedAt: Date.now(),
    };

    if (state.activeSession.profile) {
      nextSession.profile = state.activeSession.profile;
    } else {
      delete nextSession.profile;
    }

    if (state.activeSession.mode) {
      nextSession.mode = state.activeSession.mode;
    } else {
      delete nextSession.mode;
    }

    delete nextSession.archivedAt;
    delete nextSession.manualTitle;

    return nextSession;
  }, [
    state.activeSession.mode,
    state.activeSession.model,
    state.activeSession.profile,
    state.activeSession.provider,
    state.activeSession.sessionMemoryEnabled,
    state.activeSession.uiControlEnabled,
    state.activeSession.useGlobalMemory,
    state.activeSession.workspace,
    state.shellState.sessions,
  ]);

  const submitTaskToSession = useCallback(
    (options: {
      sessionSnapshot: ChatSessionRecord;
      task: string;
      clearDraft: boolean;
      activateSession: boolean;
    }): void => {
      const normalizedTask = options.task.trim();

      if (!normalizedTask) {
        return;
      }

      const { sessionSnapshot } = options;
      const taskId = crypto.randomUUID();
      const sessionId = sessionSnapshot.id;
      const sessionWorkspace = sessionSnapshot.workspace;
      const sessionProfile = sessionSnapshot.profile;
      const sessionMode = sessionSnapshot.mode;
      const taskConversationContext = createConversationContextFromSession(
        sessionSnapshot,
        runtime.userMemorySettings.globalEnabled,
        uiControlAvailability,
      );
      const taskRunPromise = runDesktopTask(sessionWorkspace, normalizedTask, {
        conversationContext: taskConversationContext,
        model: sessionSnapshot.model,
        ...(sessionProfile ? { profile: sessionProfile } : {}),
        provider: sessionSnapshot.provider,
        ...(sessionMode ? { mode: sessionMode } : {}),
        taskId,
      });
      const nextRunMode = getEffectiveSessionMode(
        sessionSnapshot.mode,
        runtime.runtimeSnapshot,
      );
      let taskFailureReported = false;

      voice.stopSpeaking();

      const reportTaskFailure = (error: unknown): void => {
        activeDesktopTasksRef.current.delete(taskId);

        if (ignoredDesktopTaskIdsRef.current.has(taskId)) {
          ignoredDesktopTaskIdsRef.current.delete(taskId);
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
        state.sessionScopeFilter === "archived"
      ) {
        state.setSessionScopeFilter("open");
      }

      state.applyShellState((prev) => {
        const nextUpdatedAt = Date.now();
        let sessionFound = false;
        const nextSessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          sessionFound = true;

          const sessionWithoutArchive = removeSessionArchiveFlag(session);
          const nextPromptHistory =
            sessionWithoutArchive.promptHistory.at(-1) === normalizedTask
              ? sessionWithoutArchive.promptHistory
              : [...sessionWithoutArchive.promptHistory, normalizedTask].slice(
                  -40,
                );
          const nextSession: ChatSessionRecord = {
            ...sessionWithoutArchive,
            workspace: sessionSnapshot.workspace,
            provider: sessionSnapshot.provider,
            model: sessionSnapshot.model,
            draft: options.clearDraft ? "" : sessionWithoutArchive.draft,
            sessionMemoryEnabled: sessionSnapshot.sessionMemoryEnabled,
            useGlobalMemory: sessionSnapshot.useGlobalMemory,
            uiControlEnabled: sessionSnapshot.uiControlEnabled,
            updatedAt: nextUpdatedAt,
            messages: [
              ...sessionWithoutArchive.messages,
              {
                id: crypto.randomUUID(),
                taskId,
                role: "user",
                content: normalizedTask,
                createdAt: Date.now(),
              },
            ],
            promptHistory: nextPromptHistory,
          };

          if (sessionSnapshot.profile) {
            nextSession.profile = sessionSnapshot.profile;
          } else {
            delete nextSession.profile;
          }

          if (sessionSnapshot.mode) {
            nextSession.mode = sessionSnapshot.mode;
          } else {
            delete nextSession.mode;
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

          return applySessionMessageLimit(nextSession);
        });

        if (!sessionFound) {
          const nextPromptHistory =
            sessionSnapshot.promptHistory.at(-1) === normalizedTask
              ? sessionSnapshot.promptHistory
              : [...sessionSnapshot.promptHistory, normalizedTask].slice(-40);
          const insertedSession = applySessionMessageLimit({
            ...sessionSnapshot,
            draft: options.clearDraft ? "" : sessionSnapshot.draft,
            updatedAt: nextUpdatedAt,
            messages: [
              ...sessionSnapshot.messages,
              {
                id: crypto.randomUUID(),
                taskId,
                role: "user",
                content: normalizedTask,
                createdAt: Date.now(),
              },
            ],
            promptHistory: nextPromptHistory,
          });

          return {
            ...prev,
            ...(options.activateSession ? { activeSessionId: sessionId } : {}),
            sessions: [insertedSession, ...prev.sessions],
          };
        }

        return {
          ...prev,
          ...(options.activateSession ? { activeSessionId: sessionId } : {}),
          sessions: nextSessions,
        };
      });

      if (options.activateSession) {
        state.setActiveSessionId(sessionId);
      }

      if (options.clearDraft && sessionId === state.activeSession.id) {
        state.setDraftValue("");
      }

      if (sessionId === state.activeSession.id) {
        state.setPromptHistoryIndex(null);
        state.setDraftBeforeHistory("");
      }

      activeDesktopTasksRef.current.set(taskId, sessionId);
      updateThinkingTrace(sessionId, taskId, () => {
        return createInitialThinkingTrace(nextRunMode);
      });

      void taskRunPromise
        .then((taskRun) => {
          activeDesktopTasksRef.current.delete(taskId);

          if (ignoredDesktopTaskIdsRef.current.has(taskId)) {
            ignoredDesktopTaskIdsRef.current.delete(taskId);
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

          if (sessionMemoryUpdates.length > 0) {
            state.updateSessionById(sessionId, (session) => {
              return applySessionMessageLimit({
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
            void runtime
              .refreshWorkspaceRuntimeSnapshot(sessionWorkspace, sessionProfile)
              .then(() => loadUserMemorySettings())
              .then(runtime.applyLoadedUserMemorySettings)
              .catch((error) => {
                console.error("Failed to refresh user memory settings", error);
              });
          }

          state.scheduleMessage(
            () => {
              if (ignoredDesktopTaskIdsRef.current.has(taskId)) {
                ignoredDesktopTaskIdsRef.current.delete(taskId);
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
    [
      applySessionMessageLimit,
      appendAgentMessage,
      runtime.applyLoadedUserMemorySettings,
      runtime.refreshWorkspaceRuntimeSnapshot,
      runtime.runtimeSnapshot,
      runtime.userMemorySettings.globalEnabled,
      state.activeSession.id,
      state.applyShellState,
      state.setActiveSessionId,
      state.scheduleMessage,
      state.sessionScopeFilter,
      state.setDraftValue,
      state.setDraftBeforeHistory,
      state.setPromptHistoryIndex,
      state.setSessionScopeFilter,
      state.updateSessionById,
      uiControlAvailability,
      updateThinkingTrace,
      voice,
    ],
  );

  const submitQuickVoiceCommand = useCallback(
    (transcript: string): void => {
      const normalizedTranscript = transcript.trim();

      if (!normalizedTranscript) {
        return;
      }

      submitTaskToSession({
        sessionSnapshot: buildQuickVoiceSessionSnapshot(),
        task: normalizedTranscript,
        clearDraft: true,
        activateSession: false,
      });
    },
    [buildQuickVoiceSessionSnapshot, submitTaskToSession],
  );

  const clearQuickTaskHistory = useCallback((): void => {
    const quickTaskSessionId = quickTaskSession?.id ?? null;

    if (quickTaskSessionId) {
      const quickTaskIds = new Set<string>();
      const isQuickTaskRunning =
        getSessionOverviewStatus(quickTaskSession) === "running";

      if (isQuickTaskRunning) {
        for (const message of quickTaskSession.messages) {
          quickTaskIds.add(message.taskId ?? message.id);
        }
      }

      for (const [
        taskId,
        sessionId,
      ] of activeDesktopTasksRef.current.entries()) {
        if (sessionId !== quickTaskSessionId) {
          continue;
        }

        quickTaskIds.add(taskId);
        activeDesktopTasksRef.current.delete(taskId);
        void cancelDesktopTask(taskId).catch((error) => {
          console.error("Failed to cancel cleared quick task:", error);
        });
      }

      for (const taskId of quickTaskIds) {
        ignoredDesktopTaskIdsRef.current.add(taskId);
      }
    }

    state.applyShellState((prev) => {
      const nextUpdatedAt = Date.now();
      let didClearQuickTaskHistory = false;
      const sessions = prev.sessions.map((session) => {
        if (!isQuickVoiceSession(session)) {
          return session;
        }

        const hasHistory =
          session.messages.length > 0 ||
          session.promptHistory.length > 0 ||
          session.sessionMemory.length > 0;

        if (!hasHistory) {
          return session;
        }

        didClearQuickTaskHistory = true;

        return {
          ...session,
          messages: [],
          promptHistory: [],
          sessionMemory: [],
          updatedAt: nextUpdatedAt,
        };
      });

      if (!didClearQuickTaskHistory) {
        return prev;
      }

      return {
        ...prev,
        sessions,
      };
    });
  }, [quickTaskSession, state.applyShellState]);

  const handleSend = (): void => {
    const task = state.activeSession.draft.trim();

    if (!task) {
      return;
    }

    submitTaskToSession({
      sessionSnapshot: state.activeSession,
      task,
      clearDraft: true,
      activateSession: true,
    });
  };

  return {
    isDesktop,
    submitQuickVoiceCommand,
    clearQuickTaskHistory,
    quickTask: {
      session: quickTaskSession,
      visibleMessages: quickTaskVisibleMessages,
      canClearHistory: Boolean(
        quickTaskSession &&
          (quickTaskSession.messages.length > 0 ||
            quickTaskSession.promptHistory.length > 0 ||
            quickTaskSession.sessionMemory.length > 0),
      ),
      status: quickTaskSession
        ? getSessionOverviewStatus(quickTaskSession)
        : "empty",
    },
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
      onActivateSession: state.setActiveSessionId,
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
      canRenameSession: canRenameSession(state.activeSession),
      canDeleteSession: canDeleteSession(state.activeSession),
      activeRunModeLabel: activeRunModeMeta.label,
      activeRunModeBadgeClassName: activeRunModeMeta.badgeClassName,
      isUsingWorkspaceDefaultMode,
      runtimeSnapshot: runtime.runtimeSnapshot,
      runtimeLoading: runtime.runtimeLoading,
      runtimeError: runtime.runtimeError,
      onSessionProfileSelection: handleSessionProfileSelection,
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
      voicePlayback: {
        supported: voice.supported,
        speakingMessageId: voice.speakingMessageId,
        onSpeakMessage: voice.speakMessage,
        onStopSpeaking: voice.stopSpeaking,
      },
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
      speechInput: {
        browserSupported: speechInput.browserSupported,
        enabled: speechInput.enabled,
        recording: speechInput.recording,
        transcribing: speechInput.transcribing,
        statusText: speechInput.statusText,
        statusTone: speechInput.statusTone,
        onAction: handleSpeechInputAction,
      },
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
      onCancel: handleCancel,
      isExecuting: getSessionOverviewStatus(state.activeSession) === "running",
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
      desktopSetup: {
        settings: runtime.userDesktopSettings,
        saving: runtime.desktopSetupSaving,
        message: runtime.desktopSetupMessage,
        onSave: runtime.handleDesktopSettingsSave,
      },
      voiceSetup: {
        supported: voice.supported,
        systemVoicesSupported: voice.systemVoicesSupported,
        autoSpeakResponses: voice.autoSpeakResponses,
        availabilityDescription: voice.availabilityDescription,
        speechToTextAvailabilityDescription:
          speechInput.availabilityDescription,
        speechToTextProvider: runtime.userSpeechToTextSettings.activeProvider,
        speechToTextProviderAvailability:
          runtime.userSpeechToTextSettings.providerAvailability,
        speechToTextProviderSaving: runtime.speechToTextSetupSaving,
        speechToTextProviderMessage: runtime.speechToTextSetupMessage,
        aiProvider: runtime.userVoiceSettings.activeProvider,
        aiProviderAvailability: runtime.userVoiceSettings.providerAvailability,
        aiProviderSaving: runtime.voiceSetupSaving,
        aiProviderMessage: runtime.voiceSetupMessage,
        preferredVoiceURI: voice.preferredVoiceURI,
        rate: voice.rate,
        voiceOptions: voice.voiceOptions,
        onSpeechToTextProviderChange:
          runtime.handleSpeechToTextActiveProviderSave,
        onAiProviderChange: runtime.handleVoiceActiveProviderSave,
        onAutoSpeakResponsesChange: voice.setAutoSpeakResponses,
        onPreferredVoiceChange: voice.setPreferredVoiceURI,
        onRateChange: voice.setRate,
      },
    },
  };
};
