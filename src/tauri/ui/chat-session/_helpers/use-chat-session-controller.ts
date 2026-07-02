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
  CustomizationDiagnostic,
  DiscoveredInstruction,
  TaskExecutionProgress,
} from "../../../../core/types.js";
import type {
  RalphInputValue,
} from "../../../../core/ralph.js";
import type {
  ReasoningMode,
  RunMode,
} from "../../../../core/runtime-contract.generated.js";
import {
  canDeleteSession,
  canRenameSession,
  applySessionRetentionPolicy,
  createSession,
  createVisibleConversationMessages,
  getLatestRunningTaskId,
  getSessionOverviewStatus,
  getSessionTitle,
  isSessionWorkspaceLocked,
  isQuickVoiceSession,
  MAX_SMART_CONTEXT_PACKS,
  normalizeSessionTags,
  QUICK_VOICE_SESSION_KIND,
  rememberRecentWorkspace,
  removeRecentWorkspace,
  type ChatSessionContextAttachment,
  type ChatSessionMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
  type SmartContextPack,
  trimSessionTaskGroupsToVisibleMessageLimit,
} from "../../chat-session.model";
import {
  type RuntimeProvider,
} from "../../model-catalog";
import {
  cancelDesktopTask,
  createInstruction,
  generateInstruction,
  loadActiveDesktopTasks,
  listInstructions,
  openAttachedPath,
  openExternalUrl,
  openWorkspacePath,
  resolveAttachedImagePreviewSource,
  resolveDroppedPaths,
  runTaskInterview,
  saveInstruction,
  saveClipboardImageAttachment,
  type InstructionMutationInput,
  type InstructionRegistryResult,
  type TaskInterviewResult,
} from "../../runtime";
import {
  DEFAULT_RUNNING_TASK_MESSAGE_ACTION,
  loadRunningTaskMessageAction,
  saveRunningTaskMessageAction,
  type RunningTaskMessageAction,
} from "../../lib/shell-store";
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
} from "../../task-thinking.model";
import { clampAiContextMessageLimit } from "./ai-context-window";
import {
  appendContextAttachmentsToTask,
  appendTranscriptToDraft,
  appendDraftBlock,
  clampQuickVoiceMessageLimit,
  createContextAttachment,
  createContextAttachmentFromReference,
  createContextAttachmentsFromTaskBlock,
  createPromptHistoryUpdate,
  getImageAttachmentPaths,
  isLinkContextAttachment,
  mergeContextAttachments,
  normalizeDialogSelection,
  type AttachmentSelectionKind,
  type DialogSelection,
  type FileDropTarget,
} from "./session-context-attachments";
import {
  applySmartContextPackToComposer,
  cloneContextAttachmentsForPack,
  createSmartContextPackExportPayload,
  createSmartContextPackVariables,
  doesSmartContextPackMatchComposer,
  extractSmartContextPackVariables,
  getSmartContextPacksForWorkspace,
  importSmartContextPacksIntoShellState,
  isSmartContextPackAppliedToDraft,
  type SaveSmartContextPackInput,
} from "./smart-context-packs";
import {
  getEffectiveSessionMode,
  removeSessionModeOverride,
  RUN_MODE_META,
} from "./session-shell";
import {
  createDefaultRalphInputValues,
  validateRalphInputFieldValues,
} from "../../ralph/_helpers/validate-ralph-input-field-values.helper";
import {
  createLocalTaskInterviewPrompt,
  createTaskInterviewContextNotes,
  getTrimmedTaskInterviewAnswerComments,
  type ChatInterviewDialogState,
  type ChatInterviewStartContext,
} from "./chat-interview";
import {
  createExecutionFromTerminalProgress,
  createExecutionMessageContent,
} from "./session-task-continuation";
import {
  createMemorySummaryState,
  createProviderChooserState,
} from "./session-shell-view-model";
import { useChatSessionRuntime } from "./use-chat-session-runtime";
import { useChatSessionSpeechInput } from "./use-chat-session-speech-input";
import { useChatSessionShellState } from "./use-chat-session-shell-state";
import { useChatSessionVoice } from "./use-chat-session-voice";
import {
  useDesktopTaskProgress,
  type HandleDesktopTaskProgress,
} from "./use-desktop-task-progress";
import { useRemoteMissionControl } from "./use-remote-mission-control";
import { useSessionComposerState } from "./use-session-composer-state";
import { useSessionFileDrops } from "./use-session-file-drops";
import { useSessionLifecycle } from "./use-session-lifecycle";
import { useSessionSettingsActions } from "./use-session-settings";
import { useSessionTaskSubmission } from "./use-session-task-submission";
import { useSessionWindowControls } from "./use-session-window-controls";
import { useSpeechInputDevices } from "./use-speech-input-devices";
import type { SettingsStatusMessage } from "../components/settings-dialog-panels/types";

interface QueuedSessionMessage {
  id: string;
  sessionId: string;
  task: string;
  contextAttachments: ChatSessionContextAttachment[];
  createdAt: number;
}

const getMessageTaskId = (message: ChatSessionMessage): string => {
  return message.taskId ?? message.id;
};

const hasUserMessageForTask = (
  session: ChatSessionRecord,
  taskId: string,
): boolean => {
  return session.messages.some(
    (message) => message.role === "user" && getMessageTaskId(message) === taskId,
  );
};

const reorderQueuedMessagesWithinSession = (
  messages: QueuedSessionMessage[],
  messageId: string,
  targetIndex: number,
): QueuedSessionMessage[] => {
  const movingMessage = messages.find((message) => message.id === messageId);

  if (!movingMessage) {
    return messages;
  }

  const sessionMessages = messages.filter(
    (message) => message.sessionId === movingMessage.sessionId,
  );
  const sourceIndex = sessionMessages.findIndex(
    (message) => message.id === messageId,
  );
  const clampedTargetIndex = Math.max(
    0,
    Math.min(targetIndex, sessionMessages.length - 1),
  );

  if (sourceIndex < 0 || sourceIndex === clampedTargetIndex) {
    return messages;
  }

  const reorderedSessionMessages = [...sessionMessages];
  const [removedMessage] = reorderedSessionMessages.splice(sourceIndex, 1);

  if (!removedMessage) {
    return messages;
  }

  reorderedSessionMessages.splice(clampedTargetIndex, 0, removedMessage);

  let nextSessionMessageIndex = 0;

  return messages.map((message) => {
    if (message.sessionId !== movingMessage.sessionId) {
      return message;
    }

    const replacement = reorderedSessionMessages[nextSessionMessageIndex];
    nextSessionMessageIndex += 1;

    return replacement ?? message;
  });
};

interface AttachmentImagePreviewState {
  attachment: ChatSessionContextAttachment;
  source: string | null;
  loading: boolean;
  error: string | null;
}

export interface UseChatSessionControllerOptions {
  isolateActiveSession?: boolean;
  fileDropTarget?: FileDropTarget;
  forwardedDropEventName?: string;
}

const CLIPBOARD_IMAGE_MEDIA_TYPES: readonly AgentModelImageMediaType[] = [
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
];

const getInstructionCommandErrorMessage = (
  error: unknown,
  fallback: string,
): string => {
  return error instanceof Error ? error.message : fallback;
};

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
  const state = useChatSessionShellState({
    isolateActiveSession: options.isolateActiveSession,
  });
  const activeDesktopTasksRef = useRef<Map<string, string>>(new Map());
  const ignoredDesktopTaskIdsRef = useRef<Set<string>>(new Set());
  const desktopTaskProgressHandlersRef = useRef<
    Map<string, HandleDesktopTaskProgress>
  >(new Map());
  const recoveredTaskAssistantTextRef = useRef<Map<string, string>>(new Map());
  const finalizedRecoveredTaskIdsRef = useRef<Set<string>>(new Set());
  const activeTaskRouteHydrationSignatureRef = useRef<string | null>(null);
  const [quickTaskDraft, setQuickTaskDraft] = useState("");
  const [quickTaskContextAttachments, setQuickTaskContextAttachments] =
    useState<ChatSessionContextAttachment[]>([]);
  const [attachmentImagePreview, setAttachmentImagePreview] =
    useState<AttachmentImagePreviewState | null>(null);
  const [runningTaskMessageAction, setRunningTaskMessageAction] =
    useState<RunningTaskMessageAction>(DEFAULT_RUNNING_TASK_MESSAGE_ACTION);
  const [runningTaskMessageActionLoaded, setRunningTaskMessageActionLoaded] =
    useState(false);
  const [queuedSessionMessages, setQueuedSessionMessages] = useState<
    QueuedSessionMessage[]
  >([]);
  const [chatInterviewEnabled, setChatInterviewEnabled] = useState(false);
  const [chatInterview, setChatInterview] =
    useState<ChatInterviewDialogState | null>(null);
  const dispatchingQueuedMessageIdsRef = useRef<Set<string>>(new Set());
  const composerState = useSessionComposerState(state);
  const runtime = useChatSessionRuntime({
    catalogOpen: state.catalogOpen,
    activeSessionProvider: state.activeSession.provider,
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
        state.setDraftValue((currentDraft) =>
          appendTranscriptToDraft(currentDraft, normalizedTranscript),
        );
        return;
      }

      state.updateSessionById(sessionId, (session) => ({
        ...session,
        draft: appendTranscriptToDraft(session.draft, normalizedTranscript),
      }));
    },
    [
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
  const [instructionRegistry, setInstructionRegistry] =
    useState<InstructionRegistryResult | null>(null);
  const [instructionRegistryLoading, setInstructionRegistryLoading] =
    useState(false);
  const [instructionRegistrySaving, setInstructionRegistrySaving] =
    useState(false);
  const [instructionRegistryMessage, setInstructionRegistryMessage] =
    useState<SettingsStatusMessage | null>(null);
  const instructionRegistryRequestIdRef = useRef(0);
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
  const hasRunningSession = useMemo(() => {
    return state.shellState.sessions.some(
      (session) => getSessionOverviewStatus(session) === "running",
    );
  }, [state.shellState.sessions]);
  const activeSessionQueuedMessages = useMemo(() => {
    return queuedSessionMessages.filter(
      (message) => message.sessionId === state.activeSession.id,
    );
  }, [queuedSessionMessages, state.activeSession.id]);
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
  const workspaceDefaultRunMode =
    runtime.runtimeSnapshot?.defaultMode ?? defaultRunMode;
  const effectiveReasoning = runtime.runtimeSnapshot?.reasoning ?? "default";
  const workspaceDefaultReasoning =
    runtime.runtimeSnapshot?.defaultReasoning ?? effectiveReasoning;
  const activeReasoning = state.activeSession.reasoning ?? effectiveReasoning;
  const isUsingWorkspaceDefaultMode = !state.activeSession.mode;
  const isUsingWorkspaceDefaultReasoning = !state.activeSession.reasoning;
  const hasActiveWorkspace = state.activeSession.workspace !== null;
  const workspaceLocked = isSessionWorkspaceLocked(state.activeSession);
  const workspaceContextPacks = useMemo(
    () =>
      getSmartContextPacksForWorkspace(
        state.shellState.contextPacks,
        state.activeSession.workspace,
      ),
    [state.activeSession.workspace, state.shellState.contextPacks],
  );
  const refreshInstructionRegistry = useCallback(async (): Promise<void> => {
    const requestId = instructionRegistryRequestIdRef.current + 1;
    instructionRegistryRequestIdRef.current = requestId;
    setInstructionRegistryLoading(true);

    try {
      const registry = await listInstructions(state.activeSession.workspace);

      if (instructionRegistryRequestIdRef.current !== requestId) {
        return;
      }

      setInstructionRegistry(registry);
      setInstructionRegistryMessage(null);
    } catch (error) {
      if (instructionRegistryRequestIdRef.current !== requestId) {
        return;
      }

      setInstructionRegistryMessage({
        tone: "error",
        text: getInstructionCommandErrorMessage(
          error,
          "Instruction registry could not be loaded.",
        ),
      });
    } finally {
      if (instructionRegistryRequestIdRef.current === requestId) {
        setInstructionRegistryLoading(false);
      }
    }
  }, [state.activeSession.workspace]);

  useEffect(() => {
    if (state.catalogOpen && state.settingsSection === "instructions") {
      void refreshInstructionRegistry();
    }
  }, [refreshInstructionRegistry, state.catalogOpen, state.settingsSection]);

  const handleInstructionManualSave = useCallback(
    async (input: InstructionMutationInput): Promise<void> => {
      setInstructionRegistrySaving(true);
      setInstructionRegistryMessage(null);

      try {
        const result = input.path
          ? await saveInstruction(state.activeSession.workspace, input)
          : await createInstruction(state.activeSession.workspace, input);
        setInstructionRegistryMessage({
          tone: "success",
          text: `${result.created ? "Created" : "Updated"} ${result.scope === "user" ? "global" : "workspace"} instruction "${result.name}".`,
        });
        await refreshInstructionRegistry();
      } catch (error) {
        setInstructionRegistryMessage({
          tone: "error",
          text: getInstructionCommandErrorMessage(
            error,
            "Instruction file could not be saved.",
          ),
        });
      } finally {
        setInstructionRegistrySaving(false);
      }
    },
    [refreshInstructionRegistry, state.activeSession.workspace],
  );

  const handleInstructionGenerate = useCallback(
    async (input: InstructionMutationInput): Promise<void> => {
      setInstructionRegistrySaving(true);
      setInstructionRegistryMessage(null);

      try {
        const result = await generateInstruction(
          state.activeSession.workspace,
          input,
        );
        setInstructionRegistryMessage({
          tone: result.status === "blocked" ? "error" : "success",
          text: result.summary,
        });

        if (result.status !== "blocked") {
          await refreshInstructionRegistry();
        }
      } catch (error) {
        setInstructionRegistryMessage({
          tone: "error",
          text: getInstructionCommandErrorMessage(
            error,
            "Instruction generation could not finish.",
          ),
        });
      } finally {
        setInstructionRegistrySaving(false);
      }
    },
    [refreshInstructionRegistry, state.activeSession.workspace],
  );
  const autoAppliedContextPackIdsRef = useRef<Set<string>>(new Set());
  const matchedContextPackIds = useMemo(
    () => {
      if (
        !state.activeSession.draft.trim() &&
        state.activeSession.draftContextAttachments.length === 0
      ) {
        return [];
      }

      const matchedIds: string[] = [];

      for (const pack of workspaceContextPacks) {
        if (
          doesSmartContextPackMatchComposer(pack, {
            draft: state.activeSession.draft,
            contextAttachments: state.activeSession.draftContextAttachments,
          })
        ) {
          matchedIds.push(pack.id);
        }
      }

      return matchedIds;
    },
    [
      state.activeSession.draft,
      state.activeSession.draftContextAttachments,
      workspaceContextPacks,
    ],
  );
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
  const chatInterviewBusy =
    chatInterview?.status === "loading" || chatInterview?.status === "starting";
  const canSendMessage =
    Boolean(state.activeSession.draft.trim()) &&
    !speechInput.recording &&
    !speechInput.transcribing &&
    !chatInterviewBusy &&
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

  useEffect(() => {
    let cancelled = false;

    void loadRunningTaskMessageAction()
      .then((action) => {
        if (!cancelled) {
          setRunningTaskMessageAction(action);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunningTaskMessageActionLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!runningTaskMessageActionLoaded) {
      return;
    }

    void saveRunningTaskMessageAction(runningTaskMessageAction);
  }, [runningTaskMessageAction, runningTaskMessageActionLoaded]);

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

        if (
          thinkingMessageIndex < 0 &&
          !hasUserMessageForTask(session, taskId)
        ) {
          return session;
        }

        const existingThinkingMessage =
          thinkingMessageIndex >= 0
            ? session.messages[thinkingMessageIndex]
            : undefined;
        const baseTrace =
          existingThinkingMessage?.source?.kind === "thinking"
            ? existingThinkingMessage.source.thinking
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
    if (!state.hasHydrated) {
      return;
    }

    const runningTaskIds = state.shellState.sessions
      .map((session) => getLatestRunningTaskId(session))
      .filter((taskId): taskId is string => Boolean(taskId))
      .sort();
    const hydrationSignature = runningTaskIds.join("\0");

    if (
      runningTaskIds.length === 0 ||
      activeTaskRouteHydrationSignatureRef.current === hydrationSignature
    ) {
      return;
    }

    let cancelled = false;

    void loadActiveDesktopTasks().then((activeTasks) => {
      if (cancelled || !activeTasks) {
        return;
      }

      activeTaskRouteHydrationSignatureRef.current = hydrationSignature;
      const activeTaskIds = new Set(
        activeTasks
          .map((task) => task.id.trim())
          .filter((taskId) => taskId.length > 0),
      );

      if (activeTaskIds.size === 0) {
        return;
      }

      for (const session of state.shellState.sessions) {
        const runningTaskId = getLatestRunningTaskId(session);

        if (
          !runningTaskId ||
          !activeTaskIds.has(runningTaskId) ||
          activeDesktopTasksRef.current.has(runningTaskId)
        ) {
          continue;
        }

        activeDesktopTasksRef.current.set(runningTaskId, session.id);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [state.hasHydrated, state.shellState.sessions]);

  const handleUnhandledDesktopTaskProgress = useCallback(
    (
      sessionId: string,
      taskId: string,
      progress: TaskExecutionProgress,
    ): void => {
      const assistantText = progress.assistantText?.trim();

      if (assistantText) {
        recoveredTaskAssistantTextRef.current.set(taskId, assistantText);
      }

      if (finalizedRecoveredTaskIdsRef.current.has(taskId)) {
        return;
      }

      const execution = createExecutionFromTerminalProgress(
        progress,
        recoveredTaskAssistantTextRef.current.get(taskId) ?? "",
      );

      if (!execution) {
        return;
      }

      finalizedRecoveredTaskIdsRef.current.add(taskId);
      recoveredTaskAssistantTextRef.current.delete(taskId);

      state.updateSessionById(sessionId, (session) => {
        const hasExecutionMessage = session.messages.some(
          (message) =>
            message.taskId === taskId &&
            message.role === "agent" &&
            message.source?.kind === "execution",
        );

        if (hasExecutionMessage) {
          return session;
        }

        if (!hasUserMessageForTask(session, taskId)) {
          return session;
        }

        const timestamp = Date.now();

        return applySessionMessageLimit({
          ...session,
          updatedAt: timestamp,
          messages: [
            ...session.messages,
            {
              id: crypto.randomUUID(),
              taskId,
              role: "agent",
              content: createExecutionMessageContent(execution),
              createdAt: timestamp,
              source: {
                kind: "execution",
                execution,
              },
            },
          ],
        });
      });

      activeDesktopTasksRef.current.delete(taskId);
    },
    [applySessionMessageLimit, state.updateSessionById],
  );

  const resolveSessionIdForDesktopTask = useCallback(
    (taskId: string): string | null => {
      for (const session of state.shellState.sessions) {
        if (getLatestRunningTaskId(session) === taskId) {
          return session.id;
        }
      }

      return null;
    },
    [state.shellState.sessions],
  );

  useDesktopTaskProgress({
    activeDesktopTasksRef,
    ignoredDesktopTaskIdsRef,
    onUnhandledProgress: handleUnhandledDesktopTaskProgress,
    progressHandlersRef: desktopTaskProgressHandlersRef,
    resolveSessionIdForTask: resolveSessionIdForDesktopTask,
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

  const applyWorkspaceSelection = useCallback(
    (workspace: string | null): void => {
      const normalizedWorkspace = workspace?.trim() || null;

      state.applyShellState((prev) => {
        const targetSession = prev.sessions.find(
          (session) => session.id === state.activeSessionId,
        );

        if (!targetSession || isSessionWorkspaceLocked(targetSession)) {
          return prev;
        }

        return {
          ...prev,
          recentWorkspaces: normalizedWorkspace
            ? rememberRecentWorkspace(prev.recentWorkspaces, normalizedWorkspace)
            : prev.recentWorkspaces,
          sessions: prev.sessions.map((session) =>
            session.id === state.activeSessionId
              ? {
                  ...session,
                  workspace: normalizedWorkspace,
                  updatedAt: Date.now(),
                }
              : session,
          ),
        };
      });
    },
    [state.activeSessionId, state.applyShellState],
  );

  const removeWorkspaceFromHistory = useCallback(
    (workspace: string): void => {
      state.applyShellState((prev) => ({
        ...prev,
        recentWorkspaces: removeRecentWorkspace(prev.recentWorkspaces, workspace),
      }));
    },
    [state.applyShellState],
  );

  const handleSelectFolder = async (): Promise<void> => {
    if (isSessionWorkspaceLocked(state.activeSession)) {
      return;
    }

    if (!isDesktop) {
      applyWorkspaceSelection("/mock/workspace/path");
      return;
    }

    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Select Workspace Folder",
      });

      if (selected && typeof selected === "string") {
        applyWorkspaceSelection(selected);
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

  const handleSessionReasoningSelection = (
    reasoning: ReasoningMode | null,
  ): void => {
    state.applyShellState((prev) => {
      const nextUpdatedAt = Date.now();
      const nextSessions = prev.sessions.map((session) => {
        if (session.id !== state.activeSessionId) {
          return session;
        }

        const nextSession: ChatSessionRecord = {
          ...session,
          updatedAt: nextUpdatedAt,
        };

        if (reasoning) {
          nextSession.reasoning = reasoning;
        } else {
          delete nextSession.reasoning;
        }

        return nextSession;
      });
      const nextState: ShellPersistedState = {
        ...prev,
        sessions: nextSessions,
      };

      if (reasoning) {
        nextState.lastSelectedReasoning = reasoning;
      } else {
        delete nextState.lastSelectedReasoning;
      }

      return nextState;
    });
  };

  const openWorkspaceFile = (
    workspaceRoot: string | null | undefined,
    relativePath: string,
  ): void => {
    void openWorkspacePath(workspaceRoot, relativePath).catch((error) => {
      console.error("Failed to open workspace path", error);
    });
  };

  const handleOpenWorkspaceFile = (relativePath: string): void => {
    openWorkspaceFile(state.activeSession.workspace, relativePath);
  };

  const handleOpenQuickTaskWorkspaceFile = (relativePath: string): void => {
    openWorkspaceFile(
      quickTaskSession?.workspace ?? state.activeSession.workspace,
      relativePath,
    );
  };

  const handleOpenAttachment = (
    attachment: ChatSessionContextAttachment,
    workspaceRoot = state.activeSession.workspace,
  ): void => {
    if (attachment.kind === "image") {
      setAttachmentImagePreview({
        attachment,
        source: null,
        loading: true,
        error: null,
      });

      void resolveAttachedImagePreviewSource(
        attachment.path,
        workspaceRoot,
      )
        .then((source) => {
          setAttachmentImagePreview((current) => {
            if (
              !current ||
              current.attachment.id !== attachment.id ||
              current.attachment.path !== attachment.path
            ) {
              return current;
            }

            return {
              ...current,
              source,
              loading: false,
              error: null,
            };
          });
        })
        .catch((error) => {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to resolve attached image preview.";

          console.error("Failed to preview attached image", error);
          setAttachmentImagePreview((current) => {
            if (
              !current ||
              current.attachment.id !== attachment.id ||
              current.attachment.path !== attachment.path
            ) {
              return current;
            }

            return {
              ...current,
              source: null,
              loading: false,
              error: message,
            };
          });
        });
      return;
    }

    if (isLinkContextAttachment(attachment)) {
      void openExternalUrl(attachment.path).catch((error) => {
        console.error("Failed to open attached link", error);
      });
      return;
    }

    void openAttachedPath(attachment.path, workspaceRoot).catch(
      (error) => {
        console.error("Failed to open attached path", error);
      },
    );
  };

  const handleCloseAttachmentImagePreview = (): void => {
    setAttachmentImagePreview(null);
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
          ...(state.activeSession.mode ? { mode: state.activeSession.mode } : {}),
          ...(state.activeSession.reasoning
            ? { reasoning: state.activeSession.reasoning }
            : {}),
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

      const mode = baseSession.mode ?? state.activeSession.mode;
      const reasoning = baseSession.reasoning ?? state.activeSession.reasoning;

      if (mode) {
        nextSession.mode = mode;
      } else {
        delete nextSession.mode;
      }

      if (reasoning) {
        nextSession.reasoning = reasoning;
      } else {
        delete nextSession.reasoning;
      }

      delete nextSession.archivedAt;
      delete nextSession.manualTitle;

      return nextSession;
    },
    [
      state.activeSession.mode,
      state.activeSession.model,
      state.activeSession.provider,
      state.activeSession.reasoning,
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
        state.updateActiveSession((session) =>
          isSessionWorkspaceLocked(session)
            ? session
            : {
                ...session,
                workspace: resolution.workspaceRoot,
                updatedAt: Date.now(),
              },
        );
      }
    },
    [
      composerState,
      state.updateActiveSession,
      updateQuickTaskSession,
    ],
  );

  const handleAttachReferences = useCallback(
    (references: string[], target: FileDropTarget): void => {
      const attachments = references.flatMap((reference) => {
        const attachment = createContextAttachmentFromReference(reference);

        return attachment ? [attachment] : [];
      });

      if (attachments.length === 0) {
        return;
      }

      if (target === "quick-task") {
        setQuickTaskContextAttachments((currentAttachments) =>
          mergeContextAttachments(currentAttachments, attachments),
        );
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
    },
    [
      composerState,
      state.updateActiveSession,
    ],
  );

  const handleAppendDroppedText = useCallback(
    (text: string, target: FileDropTarget): void => {
      const normalizedText = text.trim();

      if (!normalizedText) {
        return;
      }

      if (target === "quick-task") {
        setQuickTaskDraft((currentDraft) =>
          appendDraftBlock(currentDraft, normalizedText),
        );
        return;
      }

      composerState.resetDraftHistoryState();
      state.setDraftValue((currentDraft) =>
        appendDraftBlock(currentDraft, normalizedText),
      );
    },
    [
      composerState,
      state.setDraftValue,
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
    async (files: File[], target: FileDropTarget): Promise<void> => {
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

  const handleSaveContextPack = useCallback(
    (input: SaveSmartContextPackInput): void => {
      const name = input.name.replace(/\s+/gu, " ").trim();

      if (!name) {
        return;
      }

      const instructions = input.instructions.trim();
      const prompt = input.includePrompt ? state.activeSession.draft.trim() : "";
      const contextAttachments = input.includeAttachments
        ? cloneContextAttachmentsForPack(
            state.activeSession.draftContextAttachments,
          )
        : [];
      const provider = input.includeModel
        ? state.activeSession.provider
        : undefined;
      const model = input.includeModel ? state.activeSession.model : undefined;
      const mode = input.includeMode ? activeRunMode : undefined;
      const reasoning = input.includeReasoning ? activeReasoning : undefined;

      if (
        !instructions &&
        !prompt &&
        contextAttachments.length === 0 &&
        !provider &&
        !mode &&
        !reasoning
      ) {
        return;
      }

      state.applyShellState((prev) => {
        const now = Date.now();
        const pack: SmartContextPack = {
          id: crypto.randomUUID(),
          workspace: state.activeSession.workspace,
          name,
          instructions,
          prompt,
          contextAttachments,
          variables: createSmartContextPackVariables(input.variables),
          trigger: {
            phrases: input.triggerPhrases,
            pathPatterns: input.triggerPathPatterns,
            autoApply: input.autoApply,
          },
          ...(provider ? { provider } : {}),
          ...(provider && model ? { model } : {}),
          ...(mode ? { mode } : {}),
          ...(reasoning ? { reasoning } : {}),
          createdAt: now,
          updatedAt: now,
          useCount: 0,
        };

        return {
          ...prev,
          contextPacks: [pack, ...prev.contextPacks].slice(
            0,
            MAX_SMART_CONTEXT_PACKS,
          ),
        };
      });
    },
    [
      activeRunMode,
      activeReasoning,
      state.activeSession.draft,
      state.activeSession.draftContextAttachments,
      state.activeSession.model,
      state.activeSession.provider,
      state.activeSession.workspace,
      state.applyShellState,
    ],
  );

  const handleApplyContextPack = useCallback(
    async (
      packId: string,
      variableValues: Record<string, string> = {},
    ): Promise<void> => {
      const pack = workspaceContextPacks.find(
        (contextPack) => contextPack.id === packId,
      );

      if (!pack) {
        return;
      }

      let contextAttachments = pack.contextAttachments;

      if (pack.contextAttachments.length > 0) {
        try {
          const resolution = await resolveDroppedPaths(
            pack.contextAttachments.map((attachment) => attachment.path),
          );
          contextAttachments = resolution.entries.map(createContextAttachment);
        } catch (error) {
          console.error("Failed to revalidate context pack paths", error);
        }
      }

      const packForApplication: SmartContextPack = {
        ...pack,
        contextAttachments,
      };
      const application = applySmartContextPackToComposer(
        state.activeSession.draft,
        state.activeSession.draftContextAttachments,
        packForApplication,
        variableValues,
      );
      const savedProvider = pack.provider;
      const savedModel = pack.model;
      const savedModelSelection =
        savedProvider !== undefined &&
        savedModel !== undefined &&
        providerChooserState.chooserProviders.includes(savedProvider)
          ? { provider: savedProvider, model: savedModel }
          : null;

      composerState.resetDraftHistoryState();
      state.setDraftValue(application.draft);

      state.applyShellState((prev) => {
        const now = Date.now();
        const nextState: ShellPersistedState = {
          ...prev,
          contextPacks: prev.contextPacks.map((contextPack) =>
            contextPack.id === pack.id
              ? {
                  ...contextPack,
                  lastUsedAt: now,
                  useCount: contextPack.useCount + 1,
                }
              : contextPack,
          ),
          sessions: prev.sessions.map((session) => {
            if (session.id !== state.activeSession.id) {
              return session;
            }

            const nextSession: ChatSessionRecord = {
              ...session,
              draft: application.draft,
              draftContextAttachments: application.contextAttachments,
              updatedAt: now,
            };

            if (savedModelSelection) {
              nextSession.provider = savedModelSelection.provider;
              nextSession.model = savedModelSelection.model;
            }

            if (pack.mode) {
              nextSession.mode = pack.mode;
            }

            if (pack.reasoning) {
              nextSession.reasoning = pack.reasoning;
            }

            return nextSession;
          }),
        };

        if (savedModelSelection) {
          nextState.lastSelectedProvider = savedModelSelection.provider;
          nextState.lastSelectedModelByProvider = {
            ...prev.lastSelectedModelByProvider,
            [savedModelSelection.provider]: savedModelSelection.model,
          };
        }

        if (pack.mode) {
          nextState.lastSelectedMode = pack.mode;
        }

        if (pack.reasoning) {
          nextState.lastSelectedReasoning = pack.reasoning;
        }

        return nextState;
      });
    },
    [
      composerState,
      providerChooserState.chooserProviders,
      state.activeSession.draft,
      state.activeSession.draftContextAttachments,
      state.activeSession.id,
      state.applyShellState,
      state.setDraftValue,
      workspaceContextPacks,
    ],
  );

  const handleDeleteContextPack = useCallback(
    (packId: string): void => {
      state.applyShellState((prev) => ({
        ...prev,
        contextPacks: prev.contextPacks.filter((pack) => pack.id !== packId),
      }));
    },
    [state.applyShellState],
  );

  const handleExportContextPacks = useCallback((): void => {
    if (workspaceContextPacks.length === 0) {
      return;
    }

    const payload = createSmartContextPackExportPayload(workspaceContextPacks);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);

    anchor.href = url;
    anchor.download = `machdoch-context-packs-${date}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }, [workspaceContextPacks]);

  const handleImportContextPacks = useCallback(
    (file: File): void => {
      void file
        .text()
        .then((text) => JSON.parse(text) as unknown)
        .then((payload) => {
          state.applyShellState((prev) =>
            importSmartContextPacksIntoShellState(
              prev,
              payload,
              state.activeSession.workspace,
            ),
          );
        })
        .catch((error) => {
          console.error("Failed to import context packs:", error);
        });
    },
    [state.activeSession.workspace, state.applyShellState],
  );

  const handleSaveMessageAsContextPack = useCallback(
    (message: ChatSessionMessage): void => {
      if (message.role !== "user") {
        return;
      }

      const prompt = message.content.trim();

      if (!prompt) {
        return;
      }

      const contextAttachments =
        message.contextAttachments?.length
          ? message.contextAttachments
          : createContextAttachmentsFromTaskBlock(
              message.content,
              `message-pack-context-${message.id}`,
            );
      const name =
        prompt.replace(/\s+/gu, " ").slice(0, 48).trim() || "Context pack";

      state.applyShellState((prev) => {
        const now = Date.now();
        const pack: SmartContextPack = {
          id: crypto.randomUUID(),
          workspace: state.activeSession.workspace,
          name,
          instructions: "",
          prompt,
          contextAttachments: cloneContextAttachmentsForPack(contextAttachments),
          variables: createSmartContextPackVariables(
            extractSmartContextPackVariables(prompt),
          ),
          trigger: {
            phrases: [],
            pathPatterns: [],
            autoApply: false,
          },
          provider: state.activeSession.provider,
          model: state.activeSession.model,
          mode: activeRunMode,
          createdAt: now,
          updatedAt: now,
          useCount: 0,
        };

        return {
          ...prev,
          contextPacks: [pack, ...prev.contextPacks].slice(
            0,
            MAX_SMART_CONTEXT_PACKS,
          ),
        };
      });
    },
    [
      activeRunMode,
      state.activeSession.model,
      state.activeSession.provider,
      state.activeSession.workspace,
      state.applyShellState,
    ],
  );

  useEffect(() => {
    autoAppliedContextPackIdsRef.current.clear();
  }, [state.activeSession.id, state.activeSession.workspace]);

  useEffect(() => {
    if (!state.activeSession.draft.trim() && matchedContextPackIds.length === 0) {
      return;
    }

    const autoApplyPack = workspaceContextPacks.find((pack) => {
      return (
        pack.trigger.autoApply &&
        pack.variables.length === 0 &&
        !autoAppliedContextPackIdsRef.current.has(pack.id) &&
        matchedContextPackIds.includes(pack.id) &&
        !isSmartContextPackAppliedToDraft(state.activeSession.draft, pack)
      );
    });

    if (!autoApplyPack) {
      return;
    }

    autoAppliedContextPackIdsRef.current.add(autoApplyPack.id);
    void handleApplyContextPack(autoApplyPack.id).catch((error) => {
      autoAppliedContextPackIdsRef.current.delete(autoApplyPack.id);
      console.error("Failed to auto-apply context pack", error);
    });
  }, [
    handleApplyContextPack,
    matchedContextPackIds,
    state.activeSession.draft,
    workspaceContextPacks,
  ]);

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
    onAttachReferences: handleAttachReferences,
    onAppendText: handleAppendDroppedText,
    onAttachImageFiles: handlePasteContextImages,
    forwardedDropEventName: options.forwardedDropEventName,
  });

  const taskSubmission = useSessionTaskSubmission({
    state,
    runtime,
    voice,
    uiControlAvailability,
    aiContextMessageLimit,
    activeDesktopTasksRef,
    ignoredDesktopTaskIdsRef,
    progressHandlersRef: desktopTaskProgressHandlersRef,
    applySessionMessageLimit,
    updateThinkingTrace,
  });

  const clearActiveSessionComposer = useCallback((): void => {
    composerState.resetDraftHistoryState();
    state.setDraftValue("");
    state.updateActiveSession((session) => {
      if (
        session.draft.length === 0 &&
        session.draftContextAttachments.length === 0
      ) {
        return session;
      }

      return {
        ...session,
        draft: "",
        draftContextAttachments: [],
        updatedAt: Date.now(),
      };
    });
  }, [
    composerState,
    state.setDraftValue,
    state.updateActiveSession,
  ]);

  const queueActiveSessionMessage = useCallback(
    (placement: "front" | "back"): QueuedSessionMessage | null => {
      const task = state.activeSession.draft.trim();

      if (!task || activeSessionImageInputError) {
        return null;
      }

      const queuedMessage: QueuedSessionMessage = {
        id: crypto.randomUUID(),
        sessionId: state.activeSession.id,
        task,
        contextAttachments: state.activeSession.draftContextAttachments.map(
          (attachment) => ({ ...attachment }),
        ),
        createdAt: Date.now(),
      };

      setQueuedSessionMessages((current) =>
        placement === "front"
          ? [queuedMessage, ...current]
          : [...current, queuedMessage],
      );
      clearActiveSessionComposer();

      return queuedMessage;
    },
    [
      activeSessionImageInputError,
      clearActiveSessionComposer,
      state.activeSession,
    ],
  );

  const appendSteeringMessageToRunningTask = useCallback((): boolean => {
    const task = state.activeSession.draft.trim();

    if (!task || activeSessionImageInputError) {
      return false;
    }

    const targetTaskId =
      getActiveDesktopTaskIdForSession(state.activeSession.id) ??
      getLatestRunningTaskId(state.activeSession);

    if (!targetTaskId) {
      return false;
    }

    const createdAt = Date.now();
    const contextAttachments =
      state.activeSession.draftContextAttachments.map((attachment) => ({
        ...attachment,
      }));

    state.updateActiveSession((session) => {
      const promptHistory = createPromptHistoryUpdate(
        session,
        task,
        contextAttachments,
      );

      return applySessionMessageLimit({
        ...session,
        updatedAt: createdAt,
        draft: "",
        draftContextAttachments: [],
        promptHistory: promptHistory.promptHistory,
        promptContextHistory: promptHistory.promptContextHistory,
      });
    });

    state.setDraftValue("");
    composerState.resetDraftHistoryState();
    updateThinkingTrace(state.activeSession.id, targetTaskId, (trace) => {
      const progress: TaskExecutionProgress = {
        task: trace.task ?? "",
        mode: trace.mode,
        state: "executing",
        message: "Steering note received.",
        executedTools: [],
        outputSections: [],
        cancellable: true,
        timelineEvent: {
          kind: "state",
          phase: "started",
          label: "Steering note",
          detail: appendContextAttachmentsToTask(task, contextAttachments),
          tone: "info",
        },
      };

      return appendThinkingProgress(trace, progress);
    });

    return true;
  }, [
    activeSessionImageInputError,
    applySessionMessageLimit,
    composerState,
    getActiveDesktopTaskIdForSession,
    state.activeSession,
    state.setDraftValue,
    state.updateActiveSession,
    updateThinkingTrace,
  ]);

  const dispatchNextQueuedMessageForSession = useCallback(
    (session: ChatSessionRecord): void => {
      const nextQueuedMessage = queuedSessionMessages.find(
        (message) =>
          message.sessionId === session.id && message.task.trim().length > 0,
      );

      if (
        !nextQueuedMessage ||
        dispatchingQueuedMessageIdsRef.current.has(nextQueuedMessage.id)
      ) {
        return;
      }

      dispatchingQueuedMessageIdsRef.current.add(nextQueuedMessage.id);
      const didSubmit = taskSubmission.submitTaskToSession({
        sessionSnapshot: session,
        task: nextQueuedMessage.task,
        contextAttachments: nextQueuedMessage.contextAttachments,
        clearDraft: false,
        activateSession: true,
        visibleMessageContent: nextQueuedMessage.task,
        promptHistoryContent: nextQueuedMessage.task,
      });

      if (didSubmit) {
        setQueuedSessionMessages((current) =>
          current.filter(
            (message) =>
              message.id !== nextQueuedMessage.id &&
              !(
                message.sessionId === session.id &&
                message.task.trim().length === 0
              ),
          ),
        );
      }

      dispatchingQueuedMessageIdsRef.current.delete(nextQueuedMessage.id);
    },
    [queuedSessionMessages, taskSubmission],
  );

  useEffect(() => {
    if (queuedSessionMessages.length === 0) {
      return;
    }

    for (const session of state.shellState.sessions) {
      if (getSessionOverviewStatus(session) === "running") {
        continue;
      }

      dispatchNextQueuedMessageForSession(session);
    }
  }, [
    dispatchNextQueuedMessageForSession,
    queuedSessionMessages.length,
    state.shellState.sessions,
  ]);

  const handleQueuedMessageChange = useCallback(
    (messageId: string, content: string): void => {
      setQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId ? { ...message, task: content } : message,
        ),
      );
    },
    [],
  );

  const handleQueuedMessageMove = useCallback(
    (messageId: string, direction: -1 | 1): void => {
      setQueuedSessionMessages((current) => {
        const movingMessage = current.find((message) => message.id === messageId);

        if (!movingMessage) {
          return current;
        }

        const sessionIndex = current
          .filter((message) => message.sessionId === movingMessage.sessionId)
          .findIndex((message) => message.id === messageId);

        return reorderQueuedMessagesWithinSession(
          current,
          messageId,
          sessionIndex + direction,
        );
      });
    },
    [],
  );

  const handleQueuedMessageReorder = useCallback(
    (messageId: string, targetIndex: number): void => {
      setQueuedSessionMessages((current) =>
        reorderQueuedMessagesWithinSession(current, messageId, targetIndex),
      );
    },
    [],
  );

  const handleQueuedMessageRemove = useCallback((messageId: string): void => {
    setQueuedSessionMessages((current) =>
      current.filter((message) => message.id !== messageId),
    );
  }, []);

  const handleAttachQueuedMessagePaths = useCallback(
    async (messageId: string, paths: string[]): Promise<void> => {
      const resolution = await resolveDroppedPaths(paths);
      const attachments = resolution.entries.map(createContextAttachment);

      if (attachments.length === 0) {
        return;
      }

      setQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                contextAttachments: mergeContextAttachments(
                  message.contextAttachments,
                  attachments,
                ),
              }
            : message,
        ),
      );
    },
    [],
  );

  const handleSelectQueuedMessageAttachments = useCallback(
    async (
      messageId: string,
      selectionKind: AttachmentSelectionKind,
    ): Promise<void> => {
      const queuedMessage = queuedSessionMessages.find(
        (message) => message.id === messageId,
      );

      if (!queuedMessage) {
        return;
      }

      const targetSession =
        state.shellState.sessions.find(
          (session) => session.id === queuedMessage.sessionId,
        ) ?? state.activeSession;
      const selectingFolders = selectionKind === "folders";
      const selectingImages = selectionKind === "images";

      if (
        selectingImages &&
        !modelSupportsImageInput(targetSession.provider, targetSession.model)
      ) {
        console.error(
          createImageInputUnsupportedModelMessage(
            targetSession.provider,
            targetSession.model,
          ),
        );
        return;
      }

      if (!isDesktop) {
        await handleAttachQueuedMessagePaths(messageId, [
          selectingFolders
            ? "/mock/context-folder"
            : selectingImages
              ? "/mock/screenshot.png"
              : "/mock/document.txt",
        ]);
        return;
      }

      try {
        const selected = (await open({
          directory: selectingFolders,
          multiple: true,
          title: selectingFolders
            ? "Add Folders to Queued Message"
            : selectingImages
              ? "Add Images to Queued Message"
              : "Add Files to Queued Message",
          ...(selectingImages
            ? {
                filters: [
                  {
                    name: "Images",
                    extensions: getSupportedImageInputExtensions(
                      targetSession.provider,
                    ),
                  },
                ],
              }
            : {}),
        })) as DialogSelection;

        await handleAttachQueuedMessagePaths(
          messageId,
          normalizeDialogSelection(selected),
        );
      } catch (error) {
        console.error("Failed to select queued message attachments", error);
      }
    },
    [
      handleAttachQueuedMessagePaths,
      isDesktop,
      queuedSessionMessages,
      state.activeSession,
      state.shellState.sessions,
    ],
  );

  const handleQueuedMessageRemoveContextAttachment = useCallback(
    (messageId: string, attachmentId: string): void => {
      setQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? {
                ...message,
                contextAttachments: message.contextAttachments.filter(
                  (attachment) => attachment.id !== attachmentId,
                ),
              }
            : message,
        ),
      );
    },
    [],
  );

  const handleQueuedMessageClearContextAttachments = useCallback(
    (messageId: string): void => {
      setQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId &&
          message.contextAttachments.length > 0
            ? {
                ...message,
                contextAttachments: [],
              }
            : message,
        ),
      );
    },
    [],
  );

  const handleRemoteRenameSession = useCallback(
    (sessionId: string, title: string): void => {
      const normalizedTitle = title.trim();

      if (!normalizedTitle) {
        return;
      }

      state.updateSessionById(sessionId, (session) => {
        if (!canRenameSession(session)) {
          return session;
        }

        return {
          ...session,
          manualTitle: normalizedTitle,
          updatedAt: Date.now(),
        };
      });
    },
    [state.updateSessionById],
  );

  const handleRemoteTagSession = useCallback(
    (sessionId: string, tags: string[]): void => {
      const normalizedTags = normalizeSessionTags(tags);

      state.updateSessionById(sessionId, (session) => ({
        ...session,
        tags: normalizedTags,
        updatedAt: Date.now(),
      }));
    },
    [state.updateSessionById],
  );

  const handleRemoteClearSessionHistory = useCallback(
    (sessionId: string): void => {
      const taskIds = new Set<string>();

      for (const [taskId, activeSessionId] of activeDesktopTasksRef.current.entries()) {
        if (activeSessionId !== sessionId) {
          continue;
        }

        taskIds.add(taskId);
        activeDesktopTasksRef.current.delete(taskId);
      }

      const targetSession = state.shellState.sessions.find(
        (session) => session.id === sessionId,
      );
      const latestRunningTaskId = targetSession
        ? getLatestRunningTaskId(targetSession)
        : null;

      if (latestRunningTaskId) {
        taskIds.add(latestRunningTaskId);
      }

      for (const taskId of taskIds) {
        ignoredDesktopTaskIdsRef.current.add(taskId);
        void cancelDesktopTask(taskId).catch((error) => {
          console.error("Failed to cancel remote-cleared session task:", error);
        });
      }

      state.updateSessionById(sessionId, (session) => ({
        ...session,
        messages: [],
        promptHistory: [],
        promptContextHistory: [],
        sessionMemory: [],
        updatedAt: Date.now(),
      }));
    },
    [
      activeDesktopTasksRef,
      ignoredDesktopTaskIdsRef,
      state.shellState.sessions,
      state.updateSessionById,
    ],
  );

  const handleRemoteUpdateSessionDraft = useCallback(
    (sessionId: string, draft: string): void => {
      state.updateSessionById(sessionId, (session) => ({
        ...session,
        draft,
        updatedAt: Date.now(),
      }));
    },
    [state.updateSessionById],
  );

  const handleRemoteSetSessionModel = useCallback(
    (sessionId: string, provider: RuntimeProvider, model: string): void => {
      if (!providerChooserState.chooserProviders.includes(provider)) {
        return;
      }

      state.applyShellState((prev) => ({
        ...prev,
        lastSelectedProvider: provider,
        lastSelectedModelByProvider: {
          ...prev.lastSelectedModelByProvider,
          [provider]: model,
        },
        sessions: prev.sessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                provider,
                model,
                updatedAt: Date.now(),
              }
            : session,
        ),
      }));
    },
    [providerChooserState.chooserProviders, state.applyShellState],
  );

  const handleRemoteSetSessionMode = useCallback(
    (sessionId: string, mode: RunMode | null): void => {
      state.applyShellState((prev) => ({
        ...prev,
        ...(mode ? { lastSelectedMode: mode } : {}),
        sessions: prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          const nextSession = mode
            ? { ...session, mode }
            : removeSessionModeOverride(session);

          return {
            ...nextSession,
            updatedAt: Date.now(),
          };
        }),
      }));
    },
    [state.applyShellState],
  );

  const handleRemoteSetSessionReasoning = useCallback(
    (sessionId: string, reasoning: ReasoningMode | null): void => {
      state.applyShellState((prev) => {
        const nextState: ShellPersistedState = {
          ...prev,
          sessions: prev.sessions.map((session) => {
            if (session.id !== sessionId) {
              return session;
            }

            const nextSession: ChatSessionRecord = {
              ...session,
              updatedAt: Date.now(),
            };

            if (reasoning) {
              nextSession.reasoning = reasoning;
            } else {
              delete nextSession.reasoning;
            }

            return nextSession;
          }),
        };

        if (reasoning) {
          nextState.lastSelectedReasoning = reasoning;
        } else {
          delete nextState.lastSelectedReasoning;
        }

        return nextState;
      });
    },
    [state.applyShellState],
  );

  const handleRemoteSetSessionFlag = useCallback(
    (
      sessionId: string,
      key: "sessionMemoryEnabled" | "useGlobalMemory" | "uiControlEnabled",
      enabled: boolean,
    ): void => {
      state.updateSessionById(sessionId, (session) => ({
        ...session,
        [key]: enabled,
        updatedAt: Date.now(),
      }));
    },
    [state.updateSessionById],
  );

  const handleRemoteRemoveContextAttachment = useCallback(
    (sessionId: string, attachmentId: string): void => {
      state.updateSessionById(sessionId, (session) => ({
        ...session,
        draftContextAttachments: session.draftContextAttachments.filter(
          (attachment) => attachment.id !== attachmentId,
        ),
        updatedAt: Date.now(),
      }));
    },
    [state.updateSessionById],
  );

  const handleRemoteClearContextAttachments = useCallback(
    (sessionId: string): void => {
      state.updateSessionById(sessionId, (session) => ({
        ...session,
        draftContextAttachments: [],
        updatedAt: Date.now(),
      }));
    },
    [state.updateSessionById],
  );

  const handleRemoteApplyContextPack = useCallback(
    (sessionId: string, packId: string): void => {
      const pack = workspaceContextPacks.find(
        (contextPack) => contextPack.id === packId,
      );

      if (!pack) {
        return;
      }

      state.applyShellState((prev) => {
        const now = Date.now();
        const savedProvider = pack.provider;
        const savedModel = pack.model;
        const savedModelSelection =
          savedProvider !== undefined &&
          savedModel !== undefined &&
          providerChooserState.chooserProviders.includes(savedProvider)
            ? { provider: savedProvider, model: savedModel }
            : null;

        const nextState: ShellPersistedState = {
          ...prev,
          contextPacks: prev.contextPacks.map((contextPack) =>
            contextPack.id === pack.id
              ? {
                  ...contextPack,
                  lastUsedAt: now,
                  useCount: contextPack.useCount + 1,
                }
              : contextPack,
          ),
          sessions: prev.sessions.map((session) => {
            if (session.id !== sessionId) {
              return session;
            }

            const application = applySmartContextPackToComposer(
              session.draft,
              session.draftContextAttachments,
              pack,
              {},
            );
            const nextSession: ChatSessionRecord = {
              ...session,
              draft: application.draft,
              draftContextAttachments: application.contextAttachments,
              updatedAt: now,
            };

            if (savedModelSelection) {
              nextSession.provider = savedModelSelection.provider;
              nextSession.model = savedModelSelection.model;
            }

            if (pack.mode) {
              nextSession.mode = pack.mode;
            }

            if (pack.reasoning) {
              nextSession.reasoning = pack.reasoning;
            }

            return nextSession;
          }),
        };

        if (savedModelSelection) {
          nextState.lastSelectedProvider = savedModelSelection.provider;
          nextState.lastSelectedModelByProvider = {
            ...prev.lastSelectedModelByProvider,
            [savedModelSelection.provider]: savedModelSelection.model,
          };
        }

        if (pack.mode) {
          nextState.lastSelectedMode = pack.mode;
        }

        if (pack.reasoning) {
          nextState.lastSelectedReasoning = pack.reasoning;
        }

        return nextState;
      });
    },
    [
      providerChooserState.chooserProviders,
      state.applyShellState,
      workspaceContextPacks,
    ],
  );

  const remoteMissionControl = useRemoteMissionControl({
    shellState: state.shellState,
    activeSession: state.activeSession,
    visibleMessages: state.visibleMessages,
    runtimeSnapshot: runtime.runtimeSnapshot,
    runtimeLoading: runtime.runtimeLoading,
    runtimeError: runtime.runtimeError,
    hasAnyProvider: providerChooserState.hasAnyProvider,
    chooserProviders: providerChooserState.chooserProviders,
    defaultMode: defaultRunMode,
    defaultReasoning: workspaceDefaultReasoning,
    activeRunMode,
    activeReasoning,
    composerWorkspaceLabel: memorySummaryState.composerWorkspaceLabel,
    isGlobalMemoryAvailable: memorySummaryState.isGlobalMemoryAvailable,
    isGlobalMemoryActive: memorySummaryState.isGlobalMemoryActive,
    isUiControlAvailable,
    uiControlDescription,
    canSendMessage,
    sendDisabledReason: activeSessionImageInputError,
    workspaceContextPacks,
    matchedContextPackIds,
    quickTaskSession,
    quickTaskDraft,
    quickTaskProvider,
    quickTaskModel,
    quickTaskAutopilotEnabled: quickTaskEffectiveRunMode === "machdoch",
    quickTaskGlobalMemoryEnabled,
    quickTaskUiControlEnabled: isUiControlAvailable && quickTaskUiControlEnabled,
    quickTaskAttachmentCount: quickTaskContextAttachments.length,
    quickTaskStatus: quickTaskSession
      ? getSessionOverviewStatus(quickTaskSession)
      : "empty",
    quickTaskIsExecuting: quickTaskSession
      ? getSessionOverviewStatus(quickTaskSession) === "running"
      : false,
    voiceSupported: voice.supported,
    speakingMessageId: voice.speakingMessageId,
    speechInputSupported: speechInput.browserSupported,
    speechInputEnabled: speechInput.enabled,
    speechInputStatus: speechInput.statusText,
    activeDesktopTasksRef,
    submitTaskToSession: taskSubmission.submitTaskToSession,
    onRetryTask: taskSubmission.handleRetryTask,
    onContinueTask: taskSubmission.handleContinueTask,
    onCancelSessionTask: requestTaskCancellation,
    onCreateSession: () => lifecycleActions.createNewSession(),
    onActivateSession: state.setActiveSessionId,
    onArchiveSession: lifecycleActions.archiveSession,
    onTogglePinnedSession: lifecycleActions.togglePinnedSession,
    onDuplicateSession: (sessionId: string) =>
      lifecycleActions.cloneSession(sessionId, "duplicate"),
    onBranchSession: (sessionId: string) =>
      lifecycleActions.cloneSession(sessionId, "branch"),
    onDeleteSession: lifecycleActions.deleteSession,
    onRenameSession: handleRemoteRenameSession,
    onTagSession: handleRemoteTagSession,
    onClearSessionHistory: handleRemoteClearSessionHistory,
    onUpdateSessionDraft: handleRemoteUpdateSessionDraft,
    onSetSessionModel: handleRemoteSetSessionModel,
    onSetSessionMode: handleRemoteSetSessionMode,
    onSetSessionReasoning: handleRemoteSetSessionReasoning,
    onSetSessionMemory: (sessionId: string, enabled: boolean) =>
      handleRemoteSetSessionFlag(sessionId, "sessionMemoryEnabled", enabled),
    onSetGlobalMemory: (sessionId: string, enabled: boolean) =>
      handleRemoteSetSessionFlag(sessionId, "useGlobalMemory", enabled),
    onSetUiControl: (sessionId: string, enabled: boolean) =>
      handleRemoteSetSessionFlag(sessionId, "uiControlEnabled", enabled),
    onRemoveContextAttachment: handleRemoteRemoveContextAttachment,
    onClearContextAttachments: handleRemoteClearContextAttachments,
    onApplyContextPack: handleRemoteApplyContextPack,
    onDeleteContextPack: handleDeleteContextPack,
    onSaveMessageAsContextPack: handleSaveMessageAsContextPack,
    onSpeakMessage: voice.speakMessage,
    onStopSpeaking: voice.stopSpeaking,
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
    const currentQuickTaskSession = quickTaskSession;
    const quickTaskSessionId = currentQuickTaskSession?.id ?? null;

    if (currentQuickTaskSession && quickTaskSessionId) {
      const quickTaskIds = new Set<string>();
      const latestRunningQuickTaskId = getLatestRunningTaskId(
        currentQuickTaskSession,
      );

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

  const submitTaskFromInterview = (
    context: ChatInterviewStartContext,
    finalPrompt: string,
  ): void => {
    const submitted = taskSubmission.submitTaskToSession({
      sessionSnapshot: context.sessionSnapshot,
      task: finalPrompt,
      contextAttachments: context.contextAttachments,
      clearDraft: true,
      activateSession: true,
      visibleMessageContent: context.task,
      promptHistoryContent: context.task,
    });

    if (submitted) {
      setChatInterview(null);
      return;
    }

    setChatInterview((current) =>
      current?.context === context
        ? {
            ...current,
            status: "blocked",
            summary: "The task could not start because the session is already running.",
            error: "The task could not start because the session is already running.",
          }
        : current,
    );
  };

  const applyChatInterviewResult = async (
    context: ChatInterviewStartContext,
    taskId: string,
    result: TaskInterviewResult,
  ): Promise<void> => {
    const fields = result.fields ?? [];
    const nextValues = createDefaultRalphInputValues(fields);
    const findings = result.session.findings ?? [];
    const assumptions = result.session.assumptions ?? [];
    const relevantFiles = result.session.relevantFiles ?? [];

    if (result.status === "questions") {
      setChatInterview((current) =>
        current?.taskId === taskId
          ? {
              ...current,
              status: "ready",
              session: result.session,
              fields,
              values: nextValues,
              answerComments: {},
              expandedCommentFieldIds: [],
              skippedFieldIds: [],
              validationErrors: {},
              summary: result.summary,
              findings,
              assumptions,
              relevantFiles,
              provider: result.provider,
              model: result.model,
              error: undefined,
            }
          : current,
      );
      return;
    }

    if (result.status === "blocked") {
      setChatInterview((current) =>
        current?.taskId === taskId
          ? {
              ...current,
              status: "blocked",
              session: result.session,
              fields,
              values: nextValues,
              answerComments: {},
              expandedCommentFieldIds: [],
              skippedFieldIds: [],
              validationErrors: {},
              summary: result.summary,
              findings,
              assumptions,
              relevantFiles,
              provider: result.provider,
              model: result.model,
              error: result.summary,
            }
          : current,
      );
      return;
    }

    const finalPrompt =
      result.finalPrompt ??
      createLocalTaskInterviewPrompt(context, result.session, [], {});

    setChatInterview((current) =>
      current?.taskId === taskId
        ? {
            ...current,
            status: "starting",
            session: result.session,
            fields: [],
            values: {},
            answerComments: {},
            expandedCommentFieldIds: [],
            skippedFieldIds: [],
            validationErrors: {},
            summary: result.summary,
            findings,
            assumptions,
            relevantFiles,
            finalPrompt,
            provider: result.provider,
            model: result.model,
          }
        : current,
    );
    submitTaskFromInterview(context, finalPrompt);
  };

  const requestChatInterviewRound = async (
    context: ChatInterviewStartContext,
    session?: ChatInterviewDialogState["session"],
    answers?: Record<string, RalphInputValue>,
    answerComments?: Record<string, string>,
  ): Promise<void> => {
    const taskId = `task-interview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    setChatInterview((current) => ({
      context,
      status: "loading",
      session: session ?? current?.session,
      fields: current?.fields ?? [],
      values: current?.values ?? {},
      answerComments: current?.answerComments ?? {},
      expandedCommentFieldIds: current?.expandedCommentFieldIds ?? [],
      skippedFieldIds: current?.skippedFieldIds ?? [],
      validationErrors: {},
      summary: session ? "Reviewing answers" : "Preparing questions",
      findings: current?.findings ?? [],
      assumptions: current?.assumptions ?? [],
      relevantFiles: current?.relevantFiles ?? [],
      taskId,
    }));

    try {
      const result = await runTaskInterview(context.sessionSnapshot.workspace, {
        prompt: context.task,
        mode: context.mode,
        provider: context.provider,
        model: context.model,
        contextNotes: createTaskInterviewContextNotes(
          context,
          aiContextMessageLimit,
        ),
        ...(context.reasoning ? { reasoning: context.reasoning } : {}),
        maxTurns: 5,
        taskId,
        ...(session ? { session } : {}),
        ...(answers ? { answers } : {}),
        ...(answerComments && Object.keys(answerComments).length > 0
          ? { answerComments }
          : {}),
      });

      await applyChatInterviewResult(context, taskId, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      setChatInterview((current) =>
        current?.taskId === taskId
          ? {
              ...current,
              status: "blocked",
              summary: errorMessage,
              error: errorMessage,
            }
          : current,
      );
    }
  };

  const startChatInterview = (task: string): void => {
    const context: ChatInterviewStartContext = {
      sessionSnapshot: state.activeSession,
      task,
      contextAttachments: state.activeSession.draftContextAttachments.map(
        (attachment) => ({ ...attachment }),
      ),
      mode: activeRunMode,
      provider: state.activeSession.provider,
      model: state.activeSession.model,
      ...(state.activeSession.reasoning
        ? { reasoning: state.activeSession.reasoning }
        : {}),
    };

    void requestChatInterviewRound(context);
  };

  const updateChatInterviewValue = (
    fieldId: string,
    value: RalphInputValue,
  ): void => {
    setChatInterview((current) =>
      current
        ? {
            ...current,
            values: {
              ...current.values,
              [fieldId]: value,
            },
            skippedFieldIds: current.skippedFieldIds.filter((id) => id !== fieldId),
            validationErrors: {
              ...current.validationErrors,
              [fieldId]: "",
            },
          }
        : current,
    );
  };

  const updateChatInterviewComment = (
    fieldId: string,
    comment: string,
  ): void => {
    setChatInterview((current) =>
      current
        ? {
            ...current,
            answerComments: {
              ...current.answerComments,
              [fieldId]: comment,
            },
          }
        : current,
    );
  };

  const toggleChatInterviewComment = (fieldId: string): void => {
    setChatInterview((current) =>
      current
        ? {
            ...current,
            expandedCommentFieldIds: current.expandedCommentFieldIds.includes(fieldId)
              ? current.expandedCommentFieldIds.filter((id) => id !== fieldId)
              : [...current.expandedCommentFieldIds, fieldId],
          }
        : current,
    );
  };

  const skipChatInterviewField = (fieldId: string): void => {
    setChatInterview((current) =>
      current
        ? {
            ...current,
            values: {
              ...current.values,
              [fieldId]: null,
            },
            skippedFieldIds: current.skippedFieldIds.includes(fieldId)
              ? current.skippedFieldIds
              : [...current.skippedFieldIds, fieldId],
            validationErrors: {
              ...current.validationErrors,
              [fieldId]: "",
            },
          }
        : current,
    );
  };

  const submitChatInterviewAnswers = async (): Promise<void> => {
    if (!chatInterview?.session || chatInterview.status !== "ready") {
      return;
    }

    const validationErrors = validateRalphInputFieldValues(
      chatInterview.fields,
      chatInterview.values,
    );

    if (Object.keys(validationErrors).length > 0) {
      setChatInterview((current) =>
        current ? { ...current, validationErrors } : current,
      );
      return;
    }

    const answerComments = getTrimmedTaskInterviewAnswerComments(
      chatInterview.answerComments,
    );

    await requestChatInterviewRound(
      chatInterview.context,
      chatInterview.session,
      chatInterview.values,
      answerComments,
    );
  };

  const startTaskFromChatInterviewNow = (): void => {
    if (!chatInterview) {
      return;
    }

    const validationErrors = validateRalphInputFieldValues(
      chatInterview.fields,
      chatInterview.values,
    );

    if (Object.keys(validationErrors).length > 0) {
      setChatInterview((current) =>
        current ? { ...current, validationErrors } : current,
      );
      return;
    }

    const answerComments = getTrimmedTaskInterviewAnswerComments(
      chatInterview.answerComments,
    );
    const finalPrompt =
      chatInterview.finalPrompt ??
      createLocalTaskInterviewPrompt(
        chatInterview.context,
        chatInterview.session,
        chatInterview.fields,
        chatInterview.values,
        answerComments,
      );

    setChatInterview((current) =>
      current
        ? {
            ...current,
            status: "starting",
            summary: "Starting task with interview context.",
            finalPrompt,
          }
        : current,
    );
    submitTaskFromInterview(chatInterview.context, finalPrompt);
  };

  const handleSend = (): void => {
    const task = state.activeSession.draft.trim();

    if (!task || activeSessionImageInputError) {
      return;
    }

    if (getSessionOverviewStatus(state.activeSession) === "running") {
      switch (runningTaskMessageAction) {
        case "steer":
          appendSteeringMessageToRunningTask();
          return;
        case "stop-and-send": {
          const queuedMessage = queueActiveSessionMessage("front");

          if (queuedMessage) {
            requestTaskCancellation(state.activeSession);
          }
          return;
        }
        case "queue":
          queueActiveSessionMessage("back");
          return;
      }
    }

    if (chatInterviewEnabled) {
      startChatInterview(task);
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

  const instructionRegistryInstructions: DiscoveredInstruction[] =
    instructionRegistry?.instructions ?? [];
  const instructionRegistryDiagnostics: CustomizationDiagnostic[] =
    instructionRegistry?.diagnostics ?? [];

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
      workspaceRoot: quickTaskSession?.workspace ?? state.activeSession.workspace,
      onOpenWorkspaceFile: handleOpenQuickTaskWorkspaceFile,
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
    hasRunningSession,
    titlebar: {
      providerStatuses: providerChooserState.activeProviderStats,
      onMinimizeWindow: windowControls.onMinimizeWindow,
      onToggleMaximizeWindow: windowControls.onToggleMaximizeWindow,
      onCloseWindow: windowControls.onCloseWindow,
    },
    missionControl: remoteMissionControl,
    openProviderSettings: () => settingsActions.openSettings("providers"),
    sidebar: {
      totalSessions: state.shellState.sessions.length,
      activeSessionId: state.activeSession.id,
      filteredSessions: state.filteredSessions,
      sessionScopeFilter: state.sessionScopeFilter,
      sessionStatusFilters: state.sessionStatusFilters,
      sessionSearchQuery: state.sessionSearchQuery,
      sessionProjectFilter: state.sessionProjectFilter,
      inactiveSessionArchiveDays:
        runtime.userDesktopSettings.inactiveSessionArchiveDays,
      archivedSessionRetentionDays:
        runtime.userDesktopSettings.archivedSessionRetentionDays,
      sessionProjectFacets: state.sessionProjectFacets,
      sessionTagFacets: state.sessionTagFacets,
      sessionTagFilters: state.sessionTagFilters,
      onSessionScopeFilterChange: state.setSessionScopeFilter,
      onSessionStatusFiltersChange: state.setSessionStatusFilters,
      onSessionSearchQueryChange: state.setSessionSearchQuery,
      onSessionProjectFilterChange: state.setSessionProjectFilter,
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
      workspaceRoot: state.activeSession.workspace,
      aiContextMessageLimit,
      bottomRef: state.bottomRef,
      showScrollToNewestButton: state.showScrollToNewestButton,
      onScrollToNewest: state.scrollToNewest,
      onRetryTask: taskSubmission.handleRetryTask,
      onContinueTask: taskSubmission.handleContinueTask,
      onSaveMessageAsContextPack: handleSaveMessageAsContextPack,
      onOpenWorkspaceFile: handleOpenWorkspaceFile,
      onOpenAttachment: handleOpenAttachment,
      voicePlayback: {
        supported: voice.supported,
        speakingMessageId: voice.speakingMessageId,
        onSpeakMessage: voice.speakMessage,
        onStopSpeaking: voice.stopSpeaking,
      },
    },
    attachmentImagePreview: {
      preview: attachmentImagePreview,
      onOpenChange: (open: boolean) => {
        if (!open) {
          handleCloseAttachmentImagePreview();
        }
      },
    },
    chatInterview: {
      state: chatInterview,
      onClose: () => setChatInterview(null),
      onValueChange: updateChatInterviewValue,
      onToggleComment: toggleChatInterviewComment,
      onCommentChange: updateChatInterviewComment,
      onSkipField: skipChatInterviewField,
      onStartNow: startTaskFromChatInterviewNow,
      onSubmitAnswers: () => void submitChatInterviewAnswers(),
    },
    composer: {
      activeSession: state.activeSession,
      chooserProviders: providerChooserState.chooserProviders,
      activeRunMode,
      activeRunModeMeta,
      defaultRunMode,
      defaultReasoning: workspaceDefaultReasoning,
      activeReasoning,
      isUsingWorkspaceDefaultMode,
      isUsingWorkspaceDefaultReasoning,
      hasActiveWorkspace,
      workspaceLocked,
      recentWorkspaces: state.shellState.recentWorkspaces,
      composerWorkspaceLabel: memorySummaryState.composerWorkspaceLabel,
      sessionMemoryDescription: memorySummaryState.sessionMemoryDescription,
      globalMemoryDescription: memorySummaryState.globalMemoryDescription,
      uiControlDescription,
      isGlobalMemoryAvailable: memorySummaryState.isGlobalMemoryAvailable,
      isGlobalMemoryActive: memorySummaryState.isGlobalMemoryActive,
      isUiControlAvailable,
      interviewEnabled: chatInterviewEnabled,
      interviewDisabled: !isDesktop || chatInterviewBusy,
      interviewDescription: isDesktop
        ? "Ask focused precheck questions before starting the task."
        : "Task interviews are available in the desktop app.",
      contextAttachments: state.activeSession.draftContextAttachments,
      contextPacks: workspaceContextPacks,
      matchedContextPackIds,
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
      runningTaskMessageAction,
      queuedMessages: activeSessionQueuedMessages.map((message) => ({
        id: message.id,
        content: message.task,
        attachments: message.contextAttachments,
        createdAt: message.createdAt,
      })),
      onSelectFolder: handleSelectFolder,
      onWorkspaceSelection: applyWorkspaceSelection,
      onWorkspaceRemoval: removeWorkspaceFromHistory,
      onSessionModelSelection: handleSessionModelSelection,
      onSessionModeSelection: handleSessionModeSelection,
      onSessionReasoningSelection: handleSessionReasoningSelection,
      onSessionMemoryEnabledChange: settingsActions.setSessionMemoryEnabled,
      onUseGlobalMemoryChange: settingsActions.setUseGlobalMemory,
      onUiControlEnabledChange: settingsActions.setUiControlEnabled,
      onInterviewEnabledChange: setChatInterviewEnabled,
      onSelectContextFiles: () =>
        handleSelectAttachments("active-session", "files"),
      onSelectContextFolders: () =>
        handleSelectAttachments("active-session", "folders"),
      onSelectContextImages: () =>
        handleSelectAttachments("active-session", "images"),
      onPasteContextImages: (files: File[]) =>
        handlePasteContextImages(files, "active-session"),
      onOpenContextAttachment: handleOpenAttachment,
      onRemoveContextAttachment: (attachmentId: string) =>
        handleRemoveContextAttachment("active-session", attachmentId),
      onClearContextAttachments: () =>
        handleClearContextAttachments("active-session"),
      onSaveContextPack: handleSaveContextPack,
      onApplyContextPack: handleApplyContextPack,
      onDeleteContextPack: handleDeleteContextPack,
      onExportContextPacks: handleExportContextPacks,
      onImportContextPacks: handleImportContextPacks,
      onDraftChange: composerState.handleDraftChange,
      onComposerHistoryNavigation: composerState.handleComposerHistoryNavigation,
      onRunningTaskMessageActionChange: setRunningTaskMessageAction,
      onQueuedMessageChange: handleQueuedMessageChange,
      onQueuedMessageMove: handleQueuedMessageMove,
      onQueuedMessageReorder: handleQueuedMessageReorder,
      onQueuedMessageRemove: handleQueuedMessageRemove,
      onQueuedMessageSelectContextAttachments:
        handleSelectQueuedMessageAttachments,
      onQueuedMessageRemoveContextAttachment:
        handleQueuedMessageRemoveContextAttachment,
      onQueuedMessageClearContextAttachments:
        handleQueuedMessageClearContextAttachments,
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
        handlePasteContextImages(files, "quick-task"),
      onOpenContextAttachment: (attachment: ChatSessionContextAttachment) =>
        handleOpenAttachment(
          attachment,
          quickTaskSession?.workspace ?? state.activeSession.workspace,
        ),
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
      workspaceSetup: {
        workspaceRoot: state.activeSession.workspace,
        workspaceLabel: memorySummaryState.composerWorkspaceLabel,
        defaultMode: workspaceDefaultRunMode,
        effectiveMode: defaultRunMode,
        defaultReasoning: workspaceDefaultReasoning,
        effectiveReasoning,
        reasoningProvider: state.activeSession.provider,
        reasoningModel: state.activeSession.model,
        saving: runtime.workspaceSetupSaving,
        message: runtime.workspaceSetupMessage,
        onDefaultModeChange: runtime.handleWorkspaceDefaultModeSave,
        onReasoningModeChange: runtime.handleWorkspaceReasoningModeSave,
      },
      instructionsSetup: {
        workspaceRoot: state.activeSession.workspace,
        instructions: instructionRegistryInstructions,
        diagnostics: instructionRegistryDiagnostics,
        loading: instructionRegistryLoading,
        saving: instructionRegistrySaving,
        message: instructionRegistryMessage,
        onRefresh: refreshInstructionRegistry,
        onManualSave: handleInstructionManualSave,
        onGenerate: handleInstructionGenerate,
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
      mcpSetup: {
        scope: runtime.mcpConfigScope,
        document: runtime.mcpConfigDocument,
        draft: runtime.mcpConfigDraft,
        presets: runtime.mcpConfigPresets,
        workspaceAvailable: runtime.mcpConfigWorkspaceAvailable,
        loading: runtime.mcpConfigLoading,
        saving: runtime.mcpConfigSaving,
        discoveryServerId: runtime.mcpDiscoveryServerId,
        discoveryBusy: runtime.mcpDiscoveryBusy,
        discoveryOutput: runtime.mcpDiscoveryOutput,
        oauthServerId: runtime.mcpOAuthServerId,
        oauthCallback: runtime.mcpOAuthCallback,
        oauthBusy: runtime.mcpOAuthBusy,
        message: runtime.mcpConfigMessage,
        onScopeChange: runtime.handleMcpConfigScopeChange,
        onDraftChange: runtime.handleMcpConfigDraftChange,
        onSave: runtime.handleMcpConfigSave,
        onPresetInsert: runtime.handleMcpPresetInsert,
        onDiscoveryServerIdChange: runtime.handleMcpDiscoveryServerIdChange,
        onDiscoverServer: runtime.handleMcpDiscoverServer,
        onRefreshDiscoveryCache: runtime.handleMcpRefreshDiscoveryCache,
        onListDiscoveryCache: runtime.handleMcpListDiscoveryCache,
        onOAuthServerIdChange: runtime.handleMcpOAuthServerIdChange,
        onOAuthCallbackChange: runtime.handleMcpOAuthCallbackChange,
        onStartOAuth: runtime.handleMcpOAuthStart,
        onFinishOAuth: runtime.handleMcpOAuthFinish,
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
        reviewModelSettings: runtime.userReviewModelSettings,
        providerAvailability: runtime.globalProviders ?? [],
        saving: runtime.agentLimitsSetupSaving,
        message: runtime.agentLimitsSetupMessage,
        onSave: runtime.handleAgentLimitsSettingsSave,
        onReviewModelSave: runtime.handleReviewModelSettingsSave,
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
          ? { tone: "error" as const, text: speechInputDevices.errorText }
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
