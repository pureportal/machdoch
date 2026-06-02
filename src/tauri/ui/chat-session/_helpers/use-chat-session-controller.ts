import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createImageInputUnsupportedModelMessage,
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
  providerSupportsImageInputMediaType,
} from "../../../../core/model-capabilities.js";
import type {
  AgentModelImageMediaType,
  RunMode,
} from "../../../../core/types.js";
import {
  canDeleteSession,
  canRenameSession,
  applySessionRetentionPolicy,
  createSession,
  createVisibleConversationMessages,
  getLatestRunningTaskId,
  getSessionOverviewStatus,
  getSessionTitle,
  isQuickVoiceSession,
  QUICK_VOICE_SESSION_KIND,
  type ChatSessionContextAttachment,
  type ChatSessionRecord,
  type ShellPersistedState,
  trimSessionTaskGroupsToVisibleMessageLimit,
} from "../../chat-session.model";
import {
  type RuntimeProvider,
} from "../../model-catalog";
import {
  cancelDesktopTask,
  openWorkspacePath,
  resolveDroppedPaths,
  saveClipboardImageAttachment,
} from "../../runtime";
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
} from "../../task-thinking.model";
import { clampAiContextMessageLimit } from "./ai-context-window";
import {
  appendTranscriptToDraft,
  clampQuickVoiceMessageLimit,
  createContextAttachment,
  getImageAttachmentPaths,
  mergeContextAttachments,
  normalizeDialogSelection,
  type AttachmentSelectionKind,
  type DialogSelection,
  type FileDropTarget,
} from "./session-context-attachments";
import {
  getEffectiveSessionMode,
  removeSessionModeOverride,
  removeSessionProfileOverride,
  RUN_MODE_META,
} from "./session-shell";
import {
  createMemorySummaryState,
  createProviderChooserState,
} from "./session-shell-view-model";
import { useChatSessionRuntime } from "./use-chat-session-runtime";
import { useChatSessionSpeechInput } from "./use-chat-session-speech-input";
import { useChatSessionShellState } from "./use-chat-session-shell-state";
import { useChatSessionVoice } from "./use-chat-session-voice";
import { useDesktopTaskProgress } from "./use-desktop-task-progress";
import { useSessionComposerState } from "./use-session-composer-state";
import { useSessionFileDrops } from "./use-session-file-drops";
import { useSessionLifecycle } from "./use-session-lifecycle";
import { useSessionSettingsActions } from "./use-session-settings";
import { useSessionTaskSubmission } from "./use-session-task-submission";
import { useSessionWindowControls } from "./use-session-window-controls";
import { useSpeechInputDevices } from "./use-speech-input-devices";

export interface UseChatSessionControllerOptions {
  isolateActiveSession?: boolean;
  enableSessionAutoProfile?: boolean;
  fileDropTarget?: FileDropTarget;
}

const CLIPBOARD_IMAGE_MEDIA_TYPES: readonly AgentModelImageMediaType[] = [
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
];

const getClipboardImageMediaType = (
  file: File,
): AgentModelImageMediaType | null => {
  const normalizedMediaType = file.type.trim().toLowerCase();
  const mediaType = CLIPBOARD_IMAGE_MEDIA_TYPES.find(
    (candidate) => candidate === normalizedMediaType,
  );

  return mediaType ?? getImageInputMediaTypeForPath(file.name) ?? null;
};

export const useChatSessionController = (
  options: UseChatSessionControllerOptions = {},
) => {
  const enableSessionAutoProfile = options.enableSessionAutoProfile !== false;
  const state = useChatSessionShellState({
    isolateActiveSession: options.isolateActiveSession,
  });
  const activeDesktopTasksRef = useRef<Map<string, string>>(new Map());
  const ignoredDesktopTaskIdsRef = useRef<Set<string>>(new Set());
  const [quickTaskDraft, setQuickTaskDraft] = useState("");
  const [quickTaskContextAttachments, setQuickTaskContextAttachments] =
    useState<ChatSessionContextAttachment[]>([]);
  const composerState = useSessionComposerState(state);
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
  const speechInputDevices = useSpeechInputDevices(
    state.catalogOpen && state.settingsSection === "voice",
  );
  const isDesktop = isTauri();
  const providerChooserState = createProviderChooserState({
    isDesktop,
    runtimeSnapshot: runtime.runtimeSnapshot,
    globalProviders: runtime.globalProviders,
  });
  const lifecycleActions = useSessionLifecycle({
    state,
    providerChooserState,
  });
  const settingsActions = useSessionSettingsActions(state);
  const windowControls = useSessionWindowControls();
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
  const defaultRunMode = runtime.runtimeSnapshot?.mode ?? "machdoch";
  const isUsingWorkspaceDefaultMode = !state.activeSession.mode;
  const hasActiveWorkspace = state.activeSession.workspace !== null;
  const activeSessionImageInputSupported = modelSupportsImageInput(
    state.activeSession.provider,
    state.activeSession.model,
  );
  const activeSessionImageAttachmentPaths = getImageAttachmentPaths(
    state.activeSession.draftContextAttachments,
  );
  const activeSessionImageInputError =
    activeSessionImageAttachmentPaths.length > 0 &&
    !activeSessionImageInputSupported
      ? createImageInputUnsupportedModelMessage(
          state.activeSession.provider,
          state.activeSession.model,
        )
      : null;
  const canSendMessage =
    Boolean(state.activeSession.draft.trim()) &&
    !speechInput.recording &&
    !speechInput.transcribing &&
    !activeSessionImageInputError;
  const uiControlAvailability = runtime.runtimeSnapshot?.uiControl;
  const isUiControlAvailable = uiControlAvailability?.available === true;
  const uiControlDescription = isUiControlAvailable
    ? uiControlAvailability.supportsWindowHandles
      ? "Let machdoch inspect the desktop, capture windows, drive mouse and keyboard, and on Windows target native window/control handles."
      : "Let machdoch inspect the desktop, capture windows, and drive mouse and keyboard when GUI automation is available."
    : (uiControlAvailability?.reason ??
      "Desktop UI control is unavailable for this workspace or environment right now.");
  const quickTaskMode = quickTaskSession?.mode ?? state.activeSession.mode;
  const quickTaskEffectiveRunMode = getEffectiveSessionMode(
    quickTaskMode,
    runtime.runtimeSnapshot,
  );
  const quickTaskUseGlobalMemory =
    quickTaskSession?.useGlobalMemory ?? state.activeSession.useGlobalMemory;
  const quickTaskUiControlEnabled =
    quickTaskSession?.uiControlEnabled ?? state.activeSession.uiControlEnabled;
  const quickTaskGlobalMemoryAvailable =
    runtime.userMemorySettings.globalEnabled;
  const quickTaskGlobalMemoryEnabled =
    quickTaskGlobalMemoryAvailable && quickTaskUseGlobalMemory;
  const quickTaskProvider =
    quickTaskSession?.provider ?? state.activeSession.provider;
  const quickTaskModel = quickTaskSession?.model ?? state.activeSession.model;
  const quickTaskImageInputSupported = modelSupportsImageInput(
    quickTaskProvider,
    quickTaskModel,
  );
  const quickTaskImageAttachmentPaths = getImageAttachmentPaths(
    quickTaskContextAttachments,
  );
  const quickTaskImageInputError =
    quickTaskImageAttachmentPaths.length > 0 && !quickTaskImageInputSupported
      ? createImageInputUnsupportedModelMessage(quickTaskProvider, quickTaskModel)
      : null;
  const quickTaskCanSend =
    Boolean(quickTaskDraft.trim()) &&
    !quickTaskImageInputError &&
    !(
      quickTaskSession &&
      getSessionOverviewStatus(quickTaskSession) === "running"
    );
  const aiContextMessageLimit = clampAiContextMessageLimit(
    runtime.userDesktopSettings.aiContextMaxMessages,
  );

  const handleSpeechInputAction = (): void => {
    if (!speechInput.browserSupported) {
      return;
    }

    if (!speechInput.enabled && !speechInput.recording && !speechInput.transcribing) {
      settingsActions.openSettings("voice");
      return;
    }

    speechInput.toggleRecording();
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

  useDesktopTaskProgress({
    activeDesktopTasksRef,
    ignoredDesktopTaskIdsRef,
    updateThinkingTrace,
  });

  useEffect(() => {
    if (!state.hasHydrated || !runtime.userDesktopSettingsLoaded) {
      return;
    }

    const applyRetentionPolicy = (): void => {
      const nextShellState = applySessionRetentionPolicy(state.shellState, {
        inactiveSessionArchiveDays:
          runtime.userDesktopSettings.inactiveSessionArchiveDays,
        archivedSessionRetentionDays:
          runtime.userDesktopSettings.archivedSessionRetentionDays,
      });

      if (nextShellState !== state.shellState) {
        state.applyShellState(nextShellState);
      }
    };

    applyRetentionPolicy();

    const intervalId = window.setInterval(
      applyRetentionPolicy,
      60 * 60 * 1_000,
    );

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    runtime.userDesktopSettings.inactiveSessionArchiveDays,
    runtime.userDesktopSettings.archivedSessionRetentionDays,
    runtime.userDesktopSettingsLoaded,
    state.applyShellState,
    state.hasHydrated,
    state.shellState,
  ]);

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

  const handleOpenWorkspaceFile = (relativePath: string): void => {
    void openWorkspacePath(state.activeSession.workspace, relativePath).catch(
      (error) => {
        console.error("Failed to open workspace path", error);
      },
    );
  };

  const getActiveDesktopTaskIdForSession = useCallback((sessionId: string): string | null => {
    let targetTaskId: string | null = null;

    for (const [
      taskId,
      activeSessionId,
    ] of activeDesktopTasksRef.current.entries()) {
      if (activeSessionId === sessionId) {
        targetTaskId = taskId;
      }
    }

    return targetTaskId;
  }, []);

  const requestTaskCancellation = useCallback(
    (session: ChatSessionRecord): void => {
      const targetTaskId =
        getActiveDesktopTaskIdForSession(session.id) ??
        getLatestRunningTaskId(session);

      if (!targetTaskId) {
        return;
      }

      updateThinkingTrace(session.id, targetTaskId, (trace) => {
        return appendThinkingProgress(trace, {
          task: targetTaskId,
          mode: trace.mode,
          state: "cancelled",
          message: "Cancellation requested.",
          executedTools: [],
          outputSections: [],
          cancellable: true,
        });
      });

      void cancelDesktopTask(targetTaskId).catch((error) => {
        console.error("Failed to cancel desktop task:", error);
      });
    },
    [getActiveDesktopTaskIdForSession, updateThinkingTrace],
  );

  const handleCancel = (): void => {
    requestTaskCancellation(state.activeSession);
  };

  const createQuickTaskSessionSnapshot = useCallback(
    (existingQuickTaskSession: ChatSessionRecord | null): ChatSessionRecord => {
      const baseSession =
        existingQuickTaskSession ??
        createSession({
          id: crypto.randomUUID(),
          specialSession: QUICK_VOICE_SESSION_KIND,
          workspace: state.activeSession.workspace,
          provider: state.activeSession.provider,
          model: state.activeSession.model,
          ...(state.activeSession.profile
            ? { profile: state.activeSession.profile }
            : {}),
          ...(state.activeSession.mode ? { mode: state.activeSession.mode } : {}),
          useGlobalMemory: state.activeSession.useGlobalMemory,
          uiControlEnabled: state.activeSession.uiControlEnabled,
        });
      const nextSession: ChatSessionRecord = {
        ...baseSession,
        specialSession: QUICK_VOICE_SESSION_KIND,
        workspace: baseSession.workspace ?? state.activeSession.workspace,
        provider: baseSession.provider,
        model: baseSession.model,
        sessionMemoryEnabled: false,
        sessionMemory: [],
        updatedAt: Date.now(),
      };

      const profile = baseSession.profile ?? state.activeSession.profile;
      const mode = baseSession.mode ?? state.activeSession.mode;

      if (profile) {
        nextSession.profile = profile;
      } else {
        delete nextSession.profile;
      }

      if (mode) {
        nextSession.mode = mode;
      } else {
        delete nextSession.mode;
      }

      delete nextSession.archivedAt;
      delete nextSession.manualTitle;

      return nextSession;
    },
    [
      state.activeSession.mode,
      state.activeSession.model,
      state.activeSession.profile,
      state.activeSession.provider,
      state.activeSession.uiControlEnabled,
      state.activeSession.useGlobalMemory,
      state.activeSession.workspace,
    ],
  );

  const updateQuickTaskSession = useCallback(
    (updater: (session: ChatSessionRecord) => ChatSessionRecord): void => {
      state.applyShellState((prev) => {
        const existingQuickTaskSession =
          prev.sessions.find(isQuickVoiceSession) ?? null;
        const baseSession = createQuickTaskSessionSnapshot(
          existingQuickTaskSession,
        );
        const nextSession = updater(baseSession);

        if (!existingQuickTaskSession) {
          return {
            ...prev,
            sessions: [nextSession, ...prev.sessions],
          };
        }

        return {
          ...prev,
          sessions: prev.sessions.map((session) =>
            session.id === existingQuickTaskSession.id ? nextSession : session,
          ),
        };
      });
    },
    [createQuickTaskSessionSnapshot, state.applyShellState],
  );

  const buildQuickVoiceSessionSnapshot = useCallback((): ChatSessionRecord => {
    return createQuickTaskSessionSnapshot(quickTaskSession);
  }, [createQuickTaskSessionSnapshot, quickTaskSession]);

  const handleQuickTaskAutopilotChange = useCallback(
    (enabled: boolean): void => {
      updateQuickTaskSession((session) => ({
        ...session,
        mode: enabled ? "machdoch" : "ask",
        updatedAt: Date.now(),
      }));
    },
    [updateQuickTaskSession],
  );

  const handleQuickTaskModelSelection = useCallback(
    (provider: RuntimeProvider, model: string): void => {
      state.applyShellState((prev) => {
        const existingQuickTaskSession =
          prev.sessions.find(isQuickVoiceSession) ?? null;
        const baseSession = createQuickTaskSessionSnapshot(
          existingQuickTaskSession,
        );
        const nextSession: ChatSessionRecord = {
          ...baseSession,
          provider,
          model,
          updatedAt: Date.now(),
        };

        return {
          ...prev,
          lastSelectedProvider: provider,
          lastSelectedModelByProvider: {
            ...prev.lastSelectedModelByProvider,
            [provider]: model,
          },
          sessions: existingQuickTaskSession
            ? prev.sessions.map((session) =>
                session.id === existingQuickTaskSession.id
                  ? nextSession
                  : session,
              )
            : [nextSession, ...prev.sessions],
        };
      });
    },
    [createQuickTaskSessionSnapshot, state.applyShellState],
  );

  const handleQuickTaskGlobalMemoryChange = useCallback(
    (enabled: boolean): void => {
      updateQuickTaskSession((session) => ({
        ...session,
        useGlobalMemory: enabled,
        updatedAt: Date.now(),
      }));
    },
    [updateQuickTaskSession],
  );

  const handleQuickTaskUiControlChange = useCallback(
    (enabled: boolean): void => {
      updateQuickTaskSession((session) => ({
        ...session,
        uiControlEnabled: enabled,
        updatedAt: Date.now(),
      }));
    },
    [updateQuickTaskSession],
  );

  const handleAttachPaths = useCallback(
    async (
      paths: string[],
      target: FileDropTarget,
      options: { updateWorkspaceRoot?: boolean } = {},
    ): Promise<void> => {
      const resolution = await resolveDroppedPaths(paths);
      const attachments = resolution.entries.map(createContextAttachment);
      const shouldUpdateWorkspaceRoot = options.updateWorkspaceRoot !== false;

      if (attachments.length === 0) {
        return;
      }

      if (target === "quick-task") {
        setQuickTaskContextAttachments((currentAttachments) =>
          mergeContextAttachments(currentAttachments, attachments),
        );

        if (shouldUpdateWorkspaceRoot && resolution.workspaceRoot) {
          updateQuickTaskSession((session) => ({
            ...session,
            workspace: resolution.workspaceRoot,
            updatedAt: Date.now(),
          }));
        }

        return;
      }

      composerState.resetDraftHistoryState();
      state.updateActiveSession((session) => ({
        ...session,
        draftContextAttachments: mergeContextAttachments(
          session.draftContextAttachments,
          attachments,
        ),
        updatedAt: Date.now(),
      }));

      if (shouldUpdateWorkspaceRoot && resolution.workspaceRoot) {
        state.updateActiveSession((session) => ({
          ...session,
          workspace: resolution.workspaceRoot,
          updatedAt: Date.now(),
        }));
      }
    },
    [
      composerState,
      state.updateActiveSession,
      updateQuickTaskSession,
    ],
  );

  const handleSelectAttachments = useCallback(
    async (
      target: FileDropTarget,
      selectionKind: AttachmentSelectionKind,
    ): Promise<void> => {
      const targetProvider =
        target === "quick-task"
          ? quickTaskProvider
          : state.activeSession.provider;
      const targetModel =
        target === "quick-task" ? quickTaskModel : state.activeSession.model;

      if (
        selectionKind === "images" &&
        !modelSupportsImageInput(targetProvider, targetModel)
      ) {
        console.error(
          createImageInputUnsupportedModelMessage(targetProvider, targetModel),
        );
        return;
      }

      if (!isDesktop) {
        await handleAttachPaths(
          [
            selectionKind === "folders"
              ? "/mock/context-folder"
              : selectionKind === "images"
                ? "/mock/screenshot.png"
                : "/mock/document.txt",
          ],
          target,
        );
        return;
      }

      const selectingFolders = selectionKind === "folders";
      const selectingImages = selectionKind === "images";

      try {
        const selected = (await open({
          directory: selectingFolders,
          multiple: true,
          title: selectingFolders
            ? "Add Folders as Context"
            : selectingImages
              ? "Add Images as Context"
              : "Add Files as Context",
          ...(selectingImages
            ? {
                filters: [
                  {
                    name: "Images",
                    extensions: getSupportedImageInputExtensions(
                      targetProvider,
                    ),
                  },
                ],
              }
            : {}),
        })) as DialogSelection;

        await handleAttachPaths(normalizeDialogSelection(selected), target);
      } catch (error) {
        console.error("Failed to select context attachments", error);
      }
    },
    [
      handleAttachPaths,
      isDesktop,
      quickTaskModel,
      quickTaskProvider,
      state.activeSession.model,
      state.activeSession.provider,
    ],
  );

  const handlePasteContextImages = useCallback(
    async (target: FileDropTarget, files: File[]): Promise<void> => {
      const targetProvider =
        target === "quick-task"
          ? quickTaskProvider
          : state.activeSession.provider;
      const targetModel =
        target === "quick-task" ? quickTaskModel : state.activeSession.model;

      if (!modelSupportsImageInput(targetProvider, targetModel)) {
        console.error(
          createImageInputUnsupportedModelMessage(targetProvider, targetModel),
        );
        return;
      }

      const supportedFiles = files.flatMap((file) => {
        const mediaType = getClipboardImageMediaType(file);

        if (
          !mediaType ||
          !providerSupportsImageInputMediaType(targetProvider, mediaType)
        ) {
          console.error(
            `Unsupported pasted image format \`${file.type || file.name || "unknown"}\`. Supported extensions for provider \`${targetProvider}\`: ${getSupportedImageInputExtensions(
              targetProvider,
            ).join(", ")}.`,
          );
          return [];
        }

        return [{ file, mediaType }];
      });

      if (supportedFiles.length === 0) {
        return;
      }

      const paths = await Promise.all(
        supportedFiles.map(({ file, mediaType }) =>
          saveClipboardImageAttachment({
            blob: file,
            mediaType,
            fileName: file.name,
          }),
        ),
      );

      await handleAttachPaths(paths, target, { updateWorkspaceRoot: false });
    },
    [
      handleAttachPaths,
      quickTaskModel,
      quickTaskProvider,
      state.activeSession.model,
      state.activeSession.provider,
    ],
  );

  const handleRemoveContextAttachment = useCallback(
    (target: FileDropTarget, attachmentId: string): void => {
      if (target === "quick-task") {
        setQuickTaskContextAttachments((attachments) =>
          attachments.filter((attachment) => attachment.id !== attachmentId),
        );
        return;
      }

      composerState.resetDraftHistoryState();
      state.updateActiveSession((session) => ({
        ...session,
        draftContextAttachments: session.draftContextAttachments.filter(
          (attachment) => attachment.id !== attachmentId,
        ),
        updatedAt: Date.now(),
      }));
    },
    [
      composerState,
      state.updateActiveSession,
    ],
  );

  const handleClearContextAttachments = useCallback(
    (target: FileDropTarget): void => {
      if (target === "quick-task") {
        setQuickTaskContextAttachments([]);
        return;
      }

      composerState.resetDraftHistoryState();
      state.updateActiveSession((session) => {
        if (session.draftContextAttachments.length === 0) {
          return session;
        }

        return {
          ...session,
          draftContextAttachments: [],
          updatedAt: Date.now(),
        };
      });
    },
    [
      composerState,
      state.updateActiveSession,
    ],
  );

  const fileDrop = useSessionFileDrops({
    fileDropTarget: options.fileDropTarget,
    isDesktop,
    onAttachPaths: handleAttachPaths,
  });

  const taskSubmission = useSessionTaskSubmission({
    state,
    runtime,
    voice,
    uiControlAvailability,
    aiContextMessageLimit,
    activeDesktopTasksRef,
    ignoredDesktopTaskIdsRef,
    applySessionMessageLimit,
    updateThinkingTrace,
  });

  const submitQuickVoiceCommand = useCallback(
    (
      transcript: string,
      contextAttachments: ChatSessionContextAttachment[] = [],
    ): void => {
      const normalizedTranscript = transcript.trim();

      if (!normalizedTranscript) {
        return;
      }

      taskSubmission.submitTaskToSession({
        sessionSnapshot: buildQuickVoiceSessionSnapshot(),
        task: normalizedTranscript,
        contextAttachments,
        clearDraft: true,
        activateSession: false,
      });
    },
    [buildQuickVoiceSessionSnapshot, taskSubmission],
  );

  const handleQuickTaskDraftSend = useCallback((): void => {
    const normalizedDraft = quickTaskDraft.trim();

    if (!normalizedDraft || quickTaskImageInputError) {
      return;
    }

    submitQuickVoiceCommand(normalizedDraft, quickTaskContextAttachments);
    setQuickTaskDraft("");
    setQuickTaskContextAttachments([]);
  }, [
    quickTaskContextAttachments,
    quickTaskDraft,
    quickTaskImageInputError,
    submitQuickVoiceCommand,
  ]);

  const handleQuickTaskCancel = useCallback((): void => {
    if (!quickTaskSession) {
      return;
    }

    requestTaskCancellation(quickTaskSession);
  }, [quickTaskSession, requestTaskCancellation]);

  const clearQuickTaskHistory = useCallback((): void => {
    const quickTaskSessionId = quickTaskSession?.id ?? null;

    if (quickTaskSessionId) {
      const quickTaskIds = new Set<string>();
      const latestRunningQuickTaskId = getLatestRunningTaskId(quickTaskSession);

      if (latestRunningQuickTaskId) {
        quickTaskIds.add(latestRunningQuickTaskId);
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
      }

      for (const taskId of quickTaskIds) {
        ignoredDesktopTaskIdsRef.current.add(taskId);
        void cancelDesktopTask(taskId).catch((error) => {
          console.error("Failed to cancel cleared Quick Chat task:", error);
        });
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
          session.promptContextHistory.length > 0 ||
          session.sessionMemory.length > 0;

        if (!hasHistory) {
          return session;
        }

        didClearQuickTaskHistory = true;

        return {
          ...session,
          messages: [],
          promptHistory: [],
          promptContextHistory: [],
          sessionMemoryEnabled: false,
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

    if (!task || activeSessionImageInputError) {
      return;
    }

    taskSubmission.submitTaskToSession({
      sessionSnapshot: state.activeSession,
      task,
      contextAttachments: state.activeSession.draftContextAttachments,
      clearDraft: true,
      activateSession: true,
    });
  };

  return {
    isDesktop,
    submitQuickVoiceCommand,
    clearQuickTaskHistory,
    fileDrop,
    voiceInputOverlay: {
      visible: speechInput.recording || speechInput.transcribing,
      recording: speechInput.recording,
      transcribing: speechInput.transcribing,
      level: speechInput.level,
      statusText: speechInput.statusText,
      statusTone: speechInput.statusTone,
      onAction: handleSpeechInputAction,
    },
    quickTask: {
      session: quickTaskSession,
      visibleMessages: quickTaskVisibleMessages,
      canClearHistory: Boolean(
        quickTaskSession &&
          (quickTaskSession.messages.length > 0 ||
            quickTaskSession.promptHistory.length > 0 ||
            quickTaskSession.promptContextHistory.length > 0 ||
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
      onMinimizeWindow: windowControls.onMinimizeWindow,
      onToggleMaximizeWindow: windowControls.onToggleMaximizeWindow,
      onCloseWindow: windowControls.onCloseWindow,
    },
    openProviderSettings: () => settingsActions.openSettings("providers"),
    sidebar: {
      totalSessions: state.shellState.sessions.length,
      activeSessionId: state.activeSession.id,
      filteredSessions: state.filteredSessions,
      sessionScopeFilter: state.sessionScopeFilter,
      sessionStatusFilter: state.sessionStatusFilter,
      sessionSearchQuery: state.sessionSearchQuery,
      inactiveSessionArchiveDays:
        runtime.userDesktopSettings.inactiveSessionArchiveDays,
      archivedSessionRetentionDays:
        runtime.userDesktopSettings.archivedSessionRetentionDays,
      sessionTagFacets: state.sessionTagFacets,
      sessionTagFilters: state.sessionTagFilters,
      onSessionScopeFilterChange: state.setSessionScopeFilter,
      onSessionStatusFilterChange: state.setSessionStatusFilter,
      onSessionSearchQueryChange: state.setSessionSearchQuery,
      onSessionTagFilterToggle: lifecycleActions.toggleSessionTagFilter,
      onCreateSession: lifecycleActions.createNewSession,
      onActivateSession: state.setActiveSessionId,
      onArchiveSession: lifecycleActions.archiveSession,
      onTogglePinnedSession: lifecycleActions.togglePinnedSession,
      onDuplicateSession: (sessionId: string) =>
        lifecycleActions.cloneSession(sessionId, "duplicate"),
      onExportSessions: lifecycleActions.exportSessions,
      onImportSessions: lifecycleActions.importSessions,
    },
    header: {
      activeSession: state.activeSession,
      currentSessionTitle,
      isRenamingSession: state.isRenamingSession,
      renameValue: state.renameValue,
      canRenameSession: canRenameSession(state.activeSession),
      canDeleteSession: canDeleteSession(state.activeSession),
      canEditSessionMetadata: !isQuickVoiceSession(state.activeSession),
      showClearSessionHistory: isQuickVoiceSession(state.activeSession),
      canClearSessionHistory:
        isQuickVoiceSession(state.activeSession) &&
        (state.activeSession.messages.length > 0 ||
          state.activeSession.promptHistory.length > 0 ||
          state.activeSession.promptContextHistory.length > 0 ||
          state.activeSession.sessionMemory.length > 0),
      activeRunModeLabel: activeRunModeMeta.label,
      activeRunModeBadgeClassName: activeRunModeMeta.badgeClassName,
      isUsingWorkspaceDefaultMode,
      runtimeSnapshot: runtime.runtimeSnapshot,
      runtimeLoading: runtime.runtimeLoading,
      runtimeError: runtime.runtimeError,
      onSessionProfileSelection: handleSessionProfileSelection,
      onTagCommit: lifecycleActions.commitSessionTags,
      onTogglePinnedSession: () =>
        lifecycleActions.togglePinnedSession(state.activeSession.id),
      onBranchSession: () =>
        lifecycleActions.cloneSession(state.activeSession.id, "branch"),
      onRenameValueChange: state.setRenameValue,
      onRenameCommit: handleRenameCommit,
      onRenameCancel: handleRenameCancel,
      onSelectFolder: handleSelectFolder,
      onCreateSession: lifecycleActions.createNewSession,
      onStartRename: () => {
        state.setRenameValue(currentSessionTitle);
        state.setIsRenamingSession(true);
      },
      onClearSessionHistory: clearQuickTaskHistory,
      onDeleteSession: () => lifecycleActions.deleteSession(state.activeSession.id),
    },
    conversation: {
      visibleMessages: state.visibleMessages,
      aiContextMessageLimit,
      bottomRef: state.bottomRef,
      showScrollToNewestButton: state.showScrollToNewestButton,
      onScrollToNewest: state.scrollToNewest,
      onApprovePlan: taskSubmission.handleApprovePlan,
      onRetryTask: taskSubmission.handleRetryTask,
      onContinueTask: taskSubmission.handleContinueTask,
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
      contextAttachments: state.activeSession.draftContextAttachments,
      imageInputSupported: activeSessionImageInputSupported,
      imageInputDisabledReason: activeSessionImageInputSupported
        ? null
        : createImageInputUnsupportedModelMessage(
            state.activeSession.provider,
            state.activeSession.model,
          ),
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
      sendDisabledReason: activeSessionImageInputError,
      onSelectFolder: handleSelectFolder,
      onSessionModelSelection: handleSessionModelSelection,
      onSessionModeSelection: handleSessionModeSelection,
      onSessionMemoryEnabledChange: settingsActions.setSessionMemoryEnabled,
      onUseGlobalMemoryChange: settingsActions.setUseGlobalMemory,
      onUiControlEnabledChange: settingsActions.setUiControlEnabled,
      onSelectContextFiles: () =>
        handleSelectAttachments("active-session", "files"),
      onSelectContextFolders: () =>
        handleSelectAttachments("active-session", "folders"),
      onSelectContextImages: () =>
        handleSelectAttachments("active-session", "images"),
      onPasteContextImages: (files: File[]) =>
        handlePasteContextImages("active-session", files),
      onRemoveContextAttachment: (attachmentId: string) =>
        handleRemoveContextAttachment("active-session", attachmentId),
      onClearContextAttachments: () =>
        handleClearContextAttachments("active-session"),
      onDraftChange: composerState.handleDraftChange,
      onComposerHistoryNavigation: composerState.handleComposerHistoryNavigation,
      onSend: handleSend,
      onCancel: handleCancel,
      isExecuting: getSessionOverviewStatus(state.activeSession) === "running",
    },
    quickTaskComposer: {
      draft: quickTaskDraft,
      chooserProviders: providerChooserState.chooserProviders,
      provider: quickTaskProvider,
      model: quickTaskModel,
      autopilotEnabled: quickTaskEffectiveRunMode === "machdoch",
      globalMemoryAvailable: quickTaskGlobalMemoryAvailable,
      globalMemoryEnabled: quickTaskGlobalMemoryEnabled,
      uiControlAvailable: isUiControlAvailable,
      uiControlEnabled: isUiControlAvailable && quickTaskUiControlEnabled,
      contextAttachments: quickTaskContextAttachments,
      imageInputSupported: quickTaskImageInputSupported,
      imageInputDisabledReason: quickTaskImageInputSupported
        ? null
        : createImageInputUnsupportedModelMessage(
            quickTaskProvider,
            quickTaskModel,
          ),
      canSend: quickTaskCanSend,
      sendDisabledReason: quickTaskImageInputError,
      isExecuting: quickTaskSession
        ? getSessionOverviewStatus(quickTaskSession) === "running"
        : false,
      onModelSelection: handleQuickTaskModelSelection,
      onAutopilotChange: handleQuickTaskAutopilotChange,
      onSelectContextFiles: () =>
        handleSelectAttachments("quick-task", "files"),
      onSelectContextFolders: () =>
        handleSelectAttachments("quick-task", "folders"),
      onSelectContextImages: () =>
        handleSelectAttachments("quick-task", "images"),
      onPasteContextImages: (files: File[]) =>
        handlePasteContextImages("quick-task", files),
      onRemoveContextAttachment: (attachmentId: string) =>
        handleRemoveContextAttachment("quick-task", attachmentId),
      onClearContextAttachments: () =>
        handleClearContextAttachments("quick-task"),
      onGlobalMemoryChange: handleQuickTaskGlobalMemoryChange,
      onUiControlChange: handleQuickTaskUiControlChange,
      onDraftChange: setQuickTaskDraft,
      onSend: handleQuickTaskDraftSend,
      onCancel: handleQuickTaskCancel,
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
      agentLimitsSetup: {
        settings: runtime.userAgentLimitsSettings,
        saving: runtime.agentLimitsSetupSaving,
        message: runtime.agentLimitsSetupMessage,
        onSave: runtime.handleAgentLimitsSettingsSave,
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
        speechInputDeviceId: runtime.userSpeechToTextSettings.inputDeviceId,
        speechInputDevicesSupported: speechInputDevices.supported,
        speechInputDevicesRefreshing: speechInputDevices.refreshing,
        speechInputDeviceSaving: runtime.speechInputDeviceSaving,
        speechInputDevices: speechInputDevices.devices,
        speechInputDeviceMessage: speechInputDevices.errorText
          ? { tone: "error", text: speechInputDevices.errorText }
          : null,
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
        onSpeechInputDeviceChange: runtime.handleSpeechToTextInputDeviceSave,
        onRefreshSpeechInputDevices: speechInputDevices.refresh,
        onAiProviderChange: runtime.handleVoiceActiveProviderSave,
        onAutoSpeakResponsesChange: voice.setAutoSpeakResponses,
        onPreferredVoiceChange: voice.setPreferredVoiceURI,
        onRateChange: voice.setRate,
      },
    },
  };
};
