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
  TaskExecutionResult,
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
  canDuplicateSession,
  canPinSession,
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
  recoverInactiveRunningTasks,
  rememberRecentWorkspace,
  removeRecentWorkspace,
  type ChatSessionContextAttachment,
  type ChatSessionMessage,
  type ChatSessionMessagePromptEnhancement,
  type ChatSessionQueuedMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
  type SmartContextPack,
  trimSessionTaskGroupsToVisibleMessageLimit,
} from "../../chat-session.model";
import {
  type RuntimeProvider,
} from "../../model-catalog";
import { normalizeReasoningModeForProvider } from "../../reasoning-options";
import {
  cancelDesktopTask,
  createInstruction,
  generateInstruction,
  loadActiveDesktopTaskIds,
  loadActiveDesktopTasks,
  loadRecentDesktopTaskResults,
  listInstructions,
  openAttachedPath,
  openExternalUrl,
  openWorkspacePath,
  readAttachedFilePreview,
  readWorkspaceFilePreview,
  resolveAttachedFilePreviewSource,
  resolveAttachedImagePreviewSource,
  resolveDroppedPaths,
  resolveWorkspaceFilePreviewSource,
  runDesktopTask,
  runTaskInterview,
  saveInstruction,
  saveClipboardImageAttachment,
  syncChatCompletionIndicator,
  type InstructionMutationInput,
  type RecentDesktopTaskResult,
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
  beginCrossWindowOperation,
  completeCrossWindowOperation,
  releaseCrossWindowOperation,
} from "../../lib/cross-window-operation";
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
  filterSmartContextPacksByScope,
  getSmartContextPacksForWorkspace,
  importSmartContextPacksIntoShellState,
  isSmartContextPackAppliedToDraft,
  type SaveSmartContextPackInput,
  type SmartContextPackScope,
  type SmartContextPackScopeFilter,
} from "./smart-context-packs";
import {
  createConversationContextFromSession,
  getEffectiveSessionMode,
  removeSessionModeOverride,
  RUN_MODE_META,
} from "./session-shell";
import {
  createPromptEnhancementTask,
  extractEnhancedPrompt,
  PROMPT_ENHANCEMENT_LABELS,
  type ActivePromptEnhancementMode,
  type PromptEnhancementMode,
} from "./prompt-enhancement";
import { normalizeSessionReasoningOverride } from "./session-reasoning";
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
  extractChatInputNeededPlaceholders,
  replaceChatInputNeededPlaceholders,
  type ChatInputNeededPlaceholder,
} from "./chat-input-needed-placeholders";
import {
  createExecutionFromTerminalProgress,
  createExecutionMessageContent,
  formatTaskExecutionError,
  isRecoveredTaskCrashMessage,
} from "./session-task-continuation";
import {
  createMemorySummaryState,
  createProviderChooserState,
} from "./session-shell-view-model";
import { isChatCompletionIndicatorActive } from "./chat-completion-indicator";
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
import {
  useSessionTaskSubmission,
  type ComposerClearGuard,
  type SessionOperationConflictSubmission,
} from "./use-session-task-submission";
import { useSessionWindowControls } from "./use-session-window-controls";
import { useSpeechInputDevices } from "./use-speech-input-devices";
import {
  getFilePreviewFileName,
  getFilePreviewRenderKind,
  resolveFilePreviewSyntax,
} from "./file-preview-language";
import type { FilePreviewMode } from "../components/file-preview-dialog";
import type { SettingsStatusMessage } from "../components/settings-dialog-panels/types";

type ChatInputNeededSubmission =
  | {
      kind: "active-session";
      sessionSnapshot: ChatSessionRecord;
      task: string;
      contextAttachments: ChatSessionContextAttachment[];
      runningAction: RunningTaskMessageAction | null;
      composerClearGuard: ComposerClearGuard;
    }
  | {
      kind: "quick-task";
      task: string;
      contextAttachments: ChatSessionContextAttachment[];
    };

interface ChatInputNeededState {
  submission: ChatInputNeededSubmission;
  placeholders: ChatInputNeededPlaceholder[];
  valuesByLookupKey: Record<string, string>;
  currentIndex: number;
}

interface ComposerStatusMessage {
  text: string;
  tone: "success" | "error" | "info" | null;
}

type PromptEnhancementPendingPlacement = "composer-blocker" | "message";

interface PromptEnhancementPendingState {
  taskId: string;
  sessionId: string;
  mode: ActivePromptEnhancementMode;
  prompt: string;
  contextAttachments: ChatSessionContextAttachment[];
  placement: PromptEnhancementPendingPlacement;
  startedAt: number;
  composerClearGuard?: ComposerClearGuard;
}

interface PromptEnhancementPreviewState {
  id: string;
  sessionId: string;
  content: string;
  originalContent?: string;
  contextAttachments: ChatSessionContextAttachment[];
}

const getMessageTaskId = (message: ChatSessionMessage): string => {
  return message.taskId ?? message.id;
};

const createComposerClearGuard = (
  session: Pick<
    ChatSessionRecord,
    | "draft"
    | "draftContextAttachments"
    | "composerUpdatedAt"
    | "draftUpdatedAt"
    | "draftAttachmentsUpdatedAt"
  >,
): ComposerClearGuard => ({
  draft: session.draft,
  contextAttachments: session.draftContextAttachments.map((attachment) => ({
    ...attachment,
  })),
  ...(session.composerUpdatedAt !== undefined
    ? { composerUpdatedAt: session.composerUpdatedAt }
    : {}),
  ...(session.draftUpdatedAt !== undefined
    ? { draftUpdatedAt: session.draftUpdatedAt }
    : {}),
  ...(session.draftAttachmentsUpdatedAt !== undefined
    ? { draftAttachmentsUpdatedAt: session.draftAttachmentsUpdatedAt }
    : {}),
});

const areComposerAttachmentsEqual = (
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
  guard: ComposerClearGuard,
): boolean => {
  return (
    session.draft === guard.draft &&
    areComposerAttachmentsEqual(
      session.draftContextAttachments,
      guard.contextAttachments,
    ) &&
    (session.draftUpdatedAt ?? session.composerUpdatedAt) ===
      (guard.draftUpdatedAt ?? guard.composerUpdatedAt) &&
    (session.draftAttachmentsUpdatedAt ?? session.composerUpdatedAt) ===
      (guard.draftAttachmentsUpdatedAt ?? guard.composerUpdatedAt)
  );
};

const createPromptEnhancementThinkingTrace = (
  pending: PromptEnhancementPendingState,
): ReturnType<typeof createInitialThinkingTrace> => {
  const modeLabel = PROMPT_ENHANCEMENT_LABELS[pending.mode];

  return appendThinkingProgress(
    createInitialThinkingTrace("ask", pending.startedAt),
    {
      task: pending.prompt,
      mode: "ask",
      state: "executing",
      message: `${modeLabel} is refining the request before task execution.`,
      executedTools: [],
      outputSections: [],
      cancellable: true,
      timelineEvent: {
        kind: "state",
        phase: "started",
        label: "Enhancing prompt",
        detail: `${modeLabel} is refining the request before task execution.`,
        tone: "info",
      },
    },
    pending.startedAt,
  );
};

const createPromptEnhancementSessionMessages = (
  pending: PromptEnhancementPendingState,
): ChatSessionMessage[] => {
  const contextAttachments = pending.contextAttachments.map((attachment) => ({
    ...attachment,
  }));

  return [
    {
      id: `${pending.taskId}-user`,
      taskId: pending.taskId,
      role: "user",
      content: pending.prompt,
      createdAt: pending.startedAt,
      ...(contextAttachments.length > 0 ? { contextAttachments } : {}),
    },
    {
      id: `${pending.taskId}-thinking`,
      taskId: pending.taskId,
      role: "agent",
      content: "",
      createdAt: pending.startedAt,
      source: {
        kind: "thinking",
        thinking: createPromptEnhancementThinkingTrace(pending),
      },
    },
  ];
};

const PROMPT_ENHANCEMENT_WEB_SEARCH_UNAVAILABLE_REASON =
  "Configure an active web search provider in settings before using web-search enhancement.";

const getPromptEnhancementErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const createMessagePromptEnhancement = (
  content: string,
  originalContent: string | undefined,
): ChatSessionMessagePromptEnhancement | undefined => {
  const normalizedContent = content.trim();
  const normalizedOriginalContent = originalContent?.trim();

  if (
    !normalizedOriginalContent ||
    normalizedOriginalContent === normalizedContent
  ) {
    return undefined;
  }

  return { originalContent: normalizedOriginalContent };
};

const waitForPromptEnhancementPreviewFrame = (): Promise<void> => {
  if (typeof window === "undefined") {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
};

const isPromptEnhancementWebSearchAvailable = (
  snapshot: ReturnType<typeof useChatSessionRuntime>["runtimeSnapshot"],
): boolean => {
  const webSearch = snapshot?.webSearch;

  return Boolean(
    webSearch &&
      webSearch.activeProvider !== "none" &&
      webSearch.providerAvailability.some(
        (entry) =>
          entry.provider === webSearch.activeProvider && entry.configured,
      ),
  );
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
  messages: ChatSessionQueuedMessage[],
  messageId: string,
  targetIndex: number,
): ChatSessionQueuedMessage[] => {
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

  const reorderedAt = Date.now();

  return messages.map((message) => {
    if (message.sessionId !== movingMessage.sessionId) {
      return message;
    }

    const replacement = reorderedSessionMessages[nextSessionMessageIndex];
    nextSessionMessageIndex += 1;

    return replacement
      ? {
          ...replacement,
          orderRank: nextSessionMessageIndex - 1,
          orderUpdatedAt: reorderedAt,
        }
      : message;
  });
};

interface AttachmentImagePreviewState {
  attachment: ChatSessionContextAttachment;
  source: string | null;
  loading: boolean;
  error: string | null;
}

type FilePreviewTarget =
  | {
      kind: "attachment";
      attachment: ChatSessionContextAttachment;
      workspaceRoot: string | null | undefined;
    }
  | {
      kind: "workspace";
      workspaceRoot: string | null | undefined;
      relativePath: string;
    };

interface FilePreviewState {
  id: string;
  target: FilePreviewTarget;
  title: string;
  path: string;
  mode: FilePreviewMode;
  loading: boolean;
  error: string | null;
  source: string | null;
  content: string | null;
  language: ReturnType<typeof resolveFilePreviewSyntax>["language"];
  languageLabel: string;
  truncated: boolean;
  lossy: boolean;
}

export interface UseChatSessionControllerOptions {
  isolateActiveSession?: boolean;
  persistActiveSession?: boolean;
  trackSessionReads?: boolean;
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
const ACTIVE_DESKTOP_TASK_RECONCILE_INTERVAL_MS = 15_000;
const ACTIVE_DESKTOP_TASK_MISSING_GRACE_MS = 45_000;
const ACTIVE_DESKTOP_TASK_MISSING_CONFIRMATION_COUNT = 3;
const INACTIVE_DESKTOP_TASK_RECOVERY_ROUTE_TTL_MS = 2 * 60_000;
const dispatchingQueuedMessageIds = new Set<string>();

type InactiveDesktopTaskObservation = {
  firstMissingAt: number;
  missCount: number;
};

type InactiveDesktopTaskRecoveryRoute = {
  sessionId: string;
  expiresAt: number;
};

const TERMINAL_PROGRESS_STATE_BY_STATUS = {
  planned: "planned",
  executed: "completed",
  blocked: "blocked",
  cancelled: "cancelled",
  unsupported: "unsupported",
} satisfies Record<TaskExecutionResult["status"], TaskExecutionProgress["state"]>;

const createTerminalThinkingProgressFromExecution = (
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
    persistActiveSession: options.persistActiveSession,
    trackSessionReads: options.trackSessionReads,
  });
  const shellStateRef = useRef(state.shellState);
  shellStateRef.current = state.shellState;
  const activeSessionIdRef = useRef(state.activeSessionId);
  activeSessionIdRef.current = state.activeSessionId;
  const activeDesktopTasksRef = useRef<Map<string, string>>(new Map());
  const interviewComposerClearGuardsRef = useRef(
    new WeakMap<ChatInterviewStartContext, ComposerClearGuard>(),
  );
  const chatInterviewRequestRevisionRef = useRef(0);
  const attachmentMutationVersionsRef = useRef<Map<string, number>>(new Map());
  const invalidateAttachmentMutation = useCallback((key: string): void => {
    attachmentMutationVersionsRef.current.set(
      key,
      (attachmentMutationVersionsRef.current.get(key) ?? 0) + 1,
    );
  }, []);
  const ignoredDesktopTaskIdsRef = useRef<Set<string>>(new Set());
  const sessionOperationConflictHandlerRef = useRef<
    (submission: SessionOperationConflictSubmission) => boolean
  >(() => false);
  const inactiveDesktopTaskObservationsRef = useRef<
    Map<string, InactiveDesktopTaskObservation>
  >(new Map());
  const inactiveDesktopTaskRecoveryRoutesRef = useRef<
    Map<string, InactiveDesktopTaskRecoveryRoute>
  >(new Map());
  const desktopTaskProgressHandlersRef = useRef<
    Map<string, HandleDesktopTaskProgress>
  >(new Map());
  const recoveredTaskAssistantTextRef = useRef<Map<string, string>>(new Map());
  const finalizedRecoveredTaskIdsRef = useRef<Set<string>>(new Set());
  const activeTaskRouteHydrationSignatureRef = useRef<string | null>(null);
  const [attachmentImagePreview, setAttachmentImagePreview] =
    useState<AttachmentImagePreviewState | null>(null);
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [runningTaskMessageAction, setRunningTaskMessageAction] =
    useState<RunningTaskMessageAction>(DEFAULT_RUNNING_TASK_MESSAGE_ACTION);
  const [runningTaskMessageActionLoaded, setRunningTaskMessageActionLoaded] =
    useState(false);
  const [chatInterviewEnabled, setChatInterviewEnabled] = useState(false);
  const [promptEnhancementMode, setPromptEnhancementMode] =
    useState<PromptEnhancementMode>("off");
  const [promptEnhancementStatus, setPromptEnhancementStatus] =
    useState<ComposerStatusMessage | null>(null);
  const [promptEnhancementPendingTasks, setPromptEnhancementPendingTasks] =
    useState<PromptEnhancementPendingState[]>([]);
  const [promptEnhancementPreview, setPromptEnhancementPreview] =
    useState<PromptEnhancementPreviewState | null>(null);
  const [chatInterview, setChatInterview] =
    useState<ChatInterviewDialogState | null>(null);
  const [chatInputNeeded, setChatInputNeeded] =
    useState<ChatInputNeededState | null>(null);
  const queuedSessionMessages = state.shellState.queuedSessionMessages;
  const blockedQueuedTaskIdsSignature = useMemo(
    () =>
      queuedSessionMessages
        .flatMap((message) =>
          message.blockedByTaskId
            ? [`${message.id}:${message.blockedByTaskId}`]
            : [],
        )
        .sort()
        .join("\0"),
    [queuedSessionMessages],
  );
  const updateQueuedSessionMessages = useCallback(
    (
      updater: (
        messages: ChatSessionQueuedMessage[],
      ) => ChatSessionQueuedMessage[],
    ): void => {
      state.applyShellState((prev) => {
        const nextQueuedMessages = updater(prev.queuedSessionMessages);

        if (nextQueuedMessages === prev.queuedSessionMessages) {
          return prev;
        }

        const nextMessageIds = new Set(
          nextQueuedMessages.map((message) => message.id),
        );
        const removedMessageIds = prev.queuedSessionMessages
          .filter((message) => !nextMessageIds.has(message.id))
          .map((message) => message.id);
        const queuedMessageTombstones = {
          ...prev.queuedMessageTombstones,
        };
        const deletedAt = Date.now();

        for (const messageId of removedMessageIds) {
          queuedMessageTombstones[messageId] = deletedAt;
        }

        return {
          ...prev,
          queuedSessionMessages: nextQueuedMessages,
          queuedMessageTombstones: Object.fromEntries(
            Object.entries(queuedMessageTombstones)
              .sort((left, right) => right[1] - left[1])
              .slice(0, 2_048),
          ),
        };
      });
    },
    [state.applyShellState],
  );
  const composerState = useSessionComposerState(state);
  const activeComposerSession = useMemo<ChatSessionRecord>(
    () => ({
      ...state.activeSession,
      draft: composerState.activeDraft,
      draftContextAttachments: composerState.activeContextAttachments,
    }),
    [
      composerState.activeContextAttachments,
      composerState.activeDraft,
      state.activeSession,
    ],
  );
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
        composerState.commitHistoryPreview();
        state.setDraftValue((currentDraft) =>
          appendTranscriptToDraft(currentDraft, normalizedTranscript),
        );
        return;
      }

      state.updateSessionById(sessionId, (session) => {
        const updatedAt = Date.now();

        return {
          ...session,
          draft: appendTranscriptToDraft(session.draft, normalizedTranscript),
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [
      composerState.commitHistoryPreview,
      state.activeSession.id,
      state.setDraftValue,
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
  const handleCreateSession = useCallback((): void => {
    const sessionId = activeSessionIdRef.current;
    composerState.resetDraftHistoryState();
    invalidateAttachmentMutation(`session:${sessionId}`);
    lifecycleActions.createNewSession();
  }, [
    composerState.resetDraftHistoryState,
    invalidateAttachmentMutation,
    lifecycleActions,
  ]);
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
  const runningTaskIdsSignature = useMemo(() => {
    return state.shellState.sessions
      .map((session) => getLatestRunningTaskId(session))
      .filter((taskId): taskId is string => Boolean(taskId))
      .sort()
      .join("\0");
  }, [state.shellState.sessions]);
  const activeSessionQueuedMessages = useMemo(() => {
    return queuedSessionMessages.filter(
      (message) => message.sessionId === state.activeSession.id,
    );
  }, [queuedSessionMessages, state.activeSession.id]);
  const quickTaskSession = useMemo(() => {
    return state.shellState.sessions.find(isQuickVoiceSession) ?? null;
  }, [state.shellState.sessions]);
  const quickTaskDraft = quickTaskSession?.draft ?? "";
  const quickTaskContextAttachments =
    quickTaskSession?.draftContextAttachments ?? [];
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
  const normalizedEffectiveReasoning = normalizeReasoningModeForProvider(
    effectiveReasoning,
    state.activeSession.provider,
    state.activeSession.model,
  );
  const workspaceDefaultReasoning = normalizeReasoningModeForProvider(
    runtime.runtimeSnapshot?.defaultReasoning ?? effectiveReasoning,
    state.activeSession.provider,
    state.activeSession.model,
  );
  const activeSessionReasoningOverride = normalizeSessionReasoningOverride(
    state.activeSession.reasoning,
    state.activeSession.provider,
    state.activeSession.model,
  );
  const activeReasoning =
    activeSessionReasoningOverride ?? normalizedEffectiveReasoning;
  const isUsingWorkspaceDefaultMode = !state.activeSession.mode;
  const isUsingWorkspaceDefaultReasoning = !activeSessionReasoningOverride;
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
        !activeComposerSession.draft.trim() &&
        activeComposerSession.draftContextAttachments.length === 0
      ) {
        return [];
      }

      const matchedIds: string[] = [];

      for (const pack of workspaceContextPacks) {
        if (
          doesSmartContextPackMatchComposer(pack, {
            draft: activeComposerSession.draft,
            contextAttachments:
              activeComposerSession.draftContextAttachments,
          })
        ) {
          matchedIds.push(pack.id);
        }
      }

      return matchedIds;
    },
    [
      activeComposerSession.draft,
      activeComposerSession.draftContextAttachments,
      workspaceContextPacks,
    ],
  );
  const activeSessionImageInputSupported = modelSupportsImageInput(
    state.activeSession.provider,
    state.activeSession.model,
  );
  const activeSessionImageAttachmentPaths = getImageAttachmentPaths(
    activeComposerSession.draftContextAttachments,
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
  const promptEnhancementBusy = promptEnhancementPendingTasks.length > 0;
  const chatCompletionIndicatorActive = useMemo(
    () =>
      isChatCompletionIndicatorActive({
        shellState: state.shellState,
        hasHydrated: state.hasHydrated,
        promptEnhancementBusy,
        chatInterviewBusy,
      }),
    [
      chatInterviewBusy,
      promptEnhancementBusy,
      state.hasHydrated,
      state.shellState,
    ],
  );
  useEffect(() => {
    if (!isDesktop || !state.hasHydrated) {
      return;
    }

    void syncChatCompletionIndicator(chatCompletionIndicatorActive).catch(
      (error) => {
        console.error("Failed to sync chat completion indicator", error);
      },
    );
  }, [chatCompletionIndicatorActive, isDesktop, state.hasHydrated]);
  const promptEnhancementWebSearchAvailable =
    isPromptEnhancementWebSearchAvailable(runtime.runtimeSnapshot);
  const promptEnhancementUnavailableReason =
    promptEnhancementMode === "web-search" &&
    !promptEnhancementWebSearchAvailable
      ? PROMPT_ENHANCEMENT_WEB_SEARCH_UNAVAILABLE_REASON
      : null;
  const activePromptEnhancementPending =
    promptEnhancementPendingTasks.find(
      (pending) => pending.sessionId === state.activeSession.id,
    ) ?? null;
  const activeSessionPromptEnhancementBusy =
    activePromptEnhancementPending !== null;
  const activeSessionSendDisabledReason =
    activeSessionPromptEnhancementBusy
      ? "Prompt enhancement is still running."
      : (promptEnhancementUnavailableReason ?? activeSessionImageInputError);
  const canSendMessage =
    Boolean(activeComposerSession.draft.trim()) &&
    !speechInput.recording &&
    !speechInput.transcribing &&
    !chatInterviewBusy &&
    !activeSessionPromptEnhancementBusy &&
    !promptEnhancementUnavailableReason &&
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
  const handlePromptEnhancementModeChange = useCallback(
    (mode: PromptEnhancementMode): void => {
      setPromptEnhancementMode(mode);
      setPromptEnhancementStatus(null);
    },
    [],
  );

  useEffect(() => {
    shellStateRef.current = state.shellState;
    activeSessionIdRef.current = state.activeSessionId;
  }, [state.activeSessionId, state.shellState]);

  const shouldActivateSubmittedSession = useCallback((sessionId: string): boolean => {
    return activeSessionIdRef.current === sessionId;
  }, []);

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
              id: `${taskId}-thinking`,
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

  const applyCompletedDesktopTaskResult = useCallback(
    (result: RecentDesktopTaskResult): boolean => {
      const taskId = result.id.trim();

      if (!taskId) {
        return false;
      }

      let didApplyResult = false;

      state.applyShellState((prev) => {
        const timestamp =
          Number.isFinite(result.finishedAt) && result.finishedAt > 0
            ? result.finishedAt
            : Date.now();
        const sessions = prev.sessions.map((session) => {
          if (getLatestRunningTaskId(session) !== taskId) {
            return session;
          }

          const hasTerminalMessage = session.messages.some((message) => {
            return (
              getMessageTaskId(message) === taskId &&
              message.role === "agent" &&
              message.source?.kind === "execution"
            );
          });

          if (hasTerminalMessage) {
            return session;
          }

          didApplyResult = true;
          const messagesWithoutRecoveredCrash = session.messages.filter(
            (message) =>
              getMessageTaskId(message) !== taskId ||
              !isRecoveredTaskCrashMessage(message),
          );

          if (result.outcome.status === "failed") {
            return applySessionMessageLimit({
              ...session,
              updatedAt: timestamp,
              messages: [
                ...messagesWithoutRecoveredCrash,
                {
                  id: `${taskId}-agent`,
                  taskId,
                  role: "agent",
                  content: formatTaskExecutionError(result.outcome.error),
                  createdAt: timestamp,
                },
              ],
            });
          }

          const execution = result.outcome.response.execution;
          const terminalProgress =
            createTerminalThinkingProgressFromExecution(execution);
          const nextMessages = messagesWithoutRecoveredCrash.map((message) => {
            if (
              getMessageTaskId(message) !== taskId ||
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

          return applySessionMessageLimit({
            ...session,
            updatedAt: timestamp,
            messages: [
              ...nextMessages,
              {
                id: `${taskId}-execution`,
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

        if (!didApplyResult) {
          return prev;
        }

        return {
          ...prev,
          sessions,
        };
      });

      if (didApplyResult) {
        activeDesktopTasksRef.current.delete(taskId);
        ignoredDesktopTaskIdsRef.current.delete(taskId);
        inactiveDesktopTaskObservationsRef.current.delete(taskId);
        inactiveDesktopTaskRecoveryRoutesRef.current.delete(taskId);
      }

      return didApplyResult;
    },
    [
      applySessionMessageLimit,
      state.applyShellState,
    ],
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

  useEffect(() => {
    if (!state.hasHydrated || !runningTaskIdsSignature) {
      return;
    }

    let disposed = false;
    let reconcileInFlight = false;

    const reconcileInactiveRunningTasks = async (): Promise<void> => {
      if (reconcileInFlight) {
        return;
      }

      reconcileInFlight = true;

      try {
        const activeTaskIds = await loadActiveDesktopTaskIds();

        if (disposed || activeTaskIds === null) {
          return;
        }

        const activeTaskIdSet = new Set(
          activeTaskIds
            .map((taskId) => taskId.trim())
            .filter((taskId) => taskId.length > 0),
        );
        const runningTaskIds = shellStateRef.current.sessions
          .map((session) => getLatestRunningTaskId(session))
          .filter((taskId): taskId is string => taskId !== null);
        const currentInactiveRunningTaskIds = runningTaskIds.filter(
          (taskId) => !activeTaskIdSet.has(taskId),
        );

        for (const taskId of runningTaskIds) {
          if (activeTaskIdSet.has(taskId)) {
            inactiveDesktopTaskObservationsRef.current.delete(taskId);
            inactiveDesktopTaskRecoveryRoutesRef.current.delete(taskId);
          }
        }

        if (currentInactiveRunningTaskIds.length === 0) {
          return;
        }

        const completedResults = await loadRecentDesktopTaskResults(
          currentInactiveRunningTaskIds,
        );

        if (disposed) {
          return;
        }

        const completedResultTaskIds = new Set<string>();

        if (completedResults) {
          for (const result of completedResults) {
            if (applyCompletedDesktopTaskResult(result)) {
              completedResultTaskIds.add(result.id.trim());
            }
          }
        }

        const now = Date.now();
        const confirmedInactiveTaskIds: string[] = [];

        for (const taskId of currentInactiveRunningTaskIds) {
          if (activeTaskIdSet.has(taskId) || completedResultTaskIds.has(taskId)) {
            continue;
          }

          const currentSession = shellStateRef.current.sessions.find(
            (session) => getLatestRunningTaskId(session) === taskId,
          );

          if (!currentSession) {
            inactiveDesktopTaskObservationsRef.current.delete(taskId);
            continue;
          }

          const previousObservation =
            inactiveDesktopTaskObservationsRef.current.get(taskId);
          const observation: InactiveDesktopTaskObservation = previousObservation
            ? {
                firstMissingAt: previousObservation.firstMissingAt,
                missCount: previousObservation.missCount + 1,
              }
            : {
                firstMissingAt: now,
                missCount: 1,
              };

          inactiveDesktopTaskObservationsRef.current.set(taskId, observation);

          if (
            observation.missCount >=
              ACTIVE_DESKTOP_TASK_MISSING_CONFIRMATION_COUNT &&
            now - observation.firstMissingAt >=
              ACTIVE_DESKTOP_TASK_MISSING_GRACE_MS
          ) {
            confirmedInactiveTaskIds.push(taskId);
          }
        }

        if (confirmedInactiveTaskIds.length === 0) {
          return;
        }

        const confirmedInactiveTaskIdSet = new Set(confirmedInactiveTaskIds);

        state.applyShellState((prev) => {
          const inactiveRunningTaskIds = prev.sessions
            .map((session) => getLatestRunningTaskId(session))
            .filter((taskId): taskId is string => {
              return (
                taskId !== null &&
                !activeTaskIdSet.has(taskId) &&
                confirmedInactiveTaskIdSet.has(taskId)
              );
            });

          if (inactiveRunningTaskIds.length === 0) {
            return prev;
          }

          const nextState = recoverInactiveRunningTasks(
            prev,
            activeTaskIdSet,
            Date.now(),
          );

          if (nextState === prev) {
            return prev;
          }

          for (const taskId of inactiveRunningTaskIds) {
            const session = prev.sessions.find(
              (entry) => getLatestRunningTaskId(entry) === taskId,
            );

            activeDesktopTasksRef.current.delete(taskId);
            inactiveDesktopTaskObservationsRef.current.delete(taskId);

            if (session) {
              inactiveDesktopTaskRecoveryRoutesRef.current.set(taskId, {
                sessionId: session.id,
                expiresAt:
                  Date.now() + INACTIVE_DESKTOP_TASK_RECOVERY_ROUTE_TTL_MS,
              });
            }
          }

          return nextState;
        });
      } finally {
        reconcileInFlight = false;
      }
    };

    void reconcileInactiveRunningTasks();
    const intervalId = window.setInterval(() => {
      void reconcileInactiveRunningTasks();
    }, ACTIVE_DESKTOP_TASK_RECONCILE_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [
    applyCompletedDesktopTaskResult,
    runningTaskIdsSignature,
    state.applyShellState,
    state.hasHydrated,
  ]);

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
        const messagesWithoutRecoveredCrash = session.messages.filter(
          (message) =>
            getMessageTaskId(message) !== taskId ||
            !isRecoveredTaskCrashMessage(message),
        );

        return applySessionMessageLimit({
          ...session,
          updatedAt: timestamp,
          messages: [
            ...messagesWithoutRecoveredCrash,
            {
              id: `${taskId}-execution`,
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
      inactiveDesktopTaskObservationsRef.current.delete(taskId);
      inactiveDesktopTaskRecoveryRoutesRef.current.delete(taskId);
    },
    [applySessionMessageLimit, state.updateSessionById],
  );

  const resolveSessionIdForDesktopTask = useCallback(
    (taskId: string): string | null => {
      const inactiveRoute =
        inactiveDesktopTaskRecoveryRoutesRef.current.get(taskId);

      if (inactiveRoute) {
        if (inactiveRoute.expiresAt > Date.now()) {
          return inactiveRoute.sessionId;
        }

        inactiveDesktopTaskRecoveryRoutesRef.current.delete(taskId);
      }

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
    state.applyShellState((prev) => {
      const nextState: ShellPersistedState = {
        ...prev,
        lastSelectedProvider: provider,
        lastSelectedModelByProvider: {
          ...prev.lastSelectedModelByProvider,
          [provider]: model,
        },
        sessions: prev.sessions.map((session) => {
          if (session.id !== state.activeSessionId) {
            return session;
          }

          const nextSession: ChatSessionRecord = {
            ...session,
            provider,
            model,
            updatedAt: Date.now(),
          };
          const nextReasoning = normalizeSessionReasoningOverride(
            session.reasoning,
            provider,
            model,
          );

          if (nextReasoning) {
            nextSession.reasoning = nextReasoning;
          } else {
            delete nextSession.reasoning;
          }

          return nextSession;
        }),
      };
      const nextLastSelectedReasoning = normalizeSessionReasoningOverride(
        prev.lastSelectedReasoning,
        provider,
        model,
      );

      if (nextLastSelectedReasoning) {
        nextState.lastSelectedReasoning = nextLastSelectedReasoning;
      } else {
        delete nextState.lastSelectedReasoning;
      }

      return nextState;
    });
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
      const normalizedReasoning = normalizeSessionReasoningOverride(
        reasoning,
        state.activeSession.provider,
        state.activeSession.model,
      );
      const nextSessions = prev.sessions.map((session) => {
        if (session.id !== state.activeSessionId) {
          return session;
        }

        const nextSession: ChatSessionRecord = {
          ...session,
          updatedAt: nextUpdatedAt,
        };

        if (normalizedReasoning) {
          nextSession.reasoning = normalizedReasoning;
        } else {
          delete nextSession.reasoning;
        }

        return nextSession;
      });
      const nextState: ShellPersistedState = {
        ...prev,
        sessions: nextSessions,
      };

      if (normalizedReasoning) {
        nextState.lastSelectedReasoning = normalizedReasoning;
      } else {
        delete nextState.lastSelectedReasoning;
      }

      return nextState;
    });
  };

  const openWorkspaceFileExternally = (
    workspaceRoot: string | null | undefined,
    relativePath: string,
  ): void => {
    void openWorkspacePath(workspaceRoot, relativePath).catch((error) => {
      console.error("Failed to open workspace path", error);
    });
  };

  const openAttachedPathExternally = (
    path: string,
    workspaceRoot: string | null | undefined,
  ): void => {
    void openAttachedPath(path, workspaceRoot).catch((error) => {
      console.error("Failed to open attached path", error);
    });
  };

  const createFilePreviewState = (target: FilePreviewTarget): FilePreviewState => {
    const path =
      target.kind === "attachment" ? target.attachment.path : target.relativePath;
    const title =
      target.kind === "attachment"
        ? target.attachment.name
        : getFilePreviewFileName(target.relativePath);
    const syntax = resolveFilePreviewSyntax(title || path);

    return {
      id: `file-preview-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      target,
      title: title || path,
      path,
      mode: getFilePreviewRenderKind(title || path),
      loading: true,
      error: null,
      source: null,
      content: null,
      language: syntax.language,
      languageLabel: syntax.label,
      truncated: false,
      lossy: false,
    };
  };

  const loadFilePreviewSource = async (
    target: FilePreviewTarget,
  ): Promise<string> => {
    if (target.kind === "attachment") {
      return resolveAttachedFilePreviewSource(
        target.attachment.path,
        target.workspaceRoot,
      );
    }

    return resolveWorkspaceFilePreviewSource(
      target.workspaceRoot,
      target.relativePath,
    );
  };

  const loadFilePreviewContent = async (
    target: FilePreviewTarget,
  ): Promise<{
    content: string;
    truncated: boolean;
    lossy: boolean;
  }> => {
    if (target.kind === "attachment") {
      return readAttachedFilePreview(
        target.attachment.path,
        target.workspaceRoot,
      );
    }

    return readWorkspaceFilePreview(target.workspaceRoot, target.relativePath);
  };

  const showFilePreview = (target: FilePreviewTarget): void => {
    const nextPreview = createFilePreviewState(target);

    setAttachmentImagePreview(null);
    setFilePreview(nextPreview);

    if (nextPreview.mode === "image" || nextPreview.mode === "pdf") {
      void loadFilePreviewSource(target)
        .then((source) => {
          setFilePreview((current) =>
            current?.id === nextPreview.id
              ? {
                  ...current,
                  source,
                  loading: false,
                  error: null,
                }
              : current,
          );
        })
        .catch((error) => {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to resolve file preview.";

          console.error("Failed to resolve file preview", error);
          setFilePreview((current) =>
            current?.id === nextPreview.id
              ? {
                  ...current,
                  source: null,
                  loading: false,
                  error: message,
                }
              : current,
          );
        });
      return;
    }

    void loadFilePreviewContent(target)
      .then((result) => {
        setFilePreview((current) =>
          current?.id === nextPreview.id
            ? {
                ...current,
                content: result.content,
                truncated: result.truncated,
                lossy: result.lossy,
                loading: false,
                error: null,
              }
            : current,
        );
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Failed to read file preview.";

        console.error("Failed to read file preview", error);
        setFilePreview((current) =>
          current?.id === nextPreview.id
            ? {
                ...current,
                content: null,
                loading: false,
                error: message,
              }
            : current,
        );
      });
  };

  const handleOpenWorkspaceFile = (relativePath: string): void => {
    showFilePreview({
      kind: "workspace",
      workspaceRoot: state.activeSession.workspace,
      relativePath,
    });
  };

  const handleOpenQuickTaskWorkspaceFile = (relativePath: string): void => {
    showFilePreview({
      kind: "workspace",
      workspaceRoot: quickTaskSession?.workspace ?? state.activeSession.workspace,
      relativePath,
    });
  };

  const handleOpenAttachment = (
    attachment: ChatSessionContextAttachment,
    workspaceRoot = state.activeSession.workspace,
  ): void => {
    if (attachment.kind === "image") {
      setFilePreview(null);
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
      setFilePreview(null);
      void openExternalUrl(attachment.path).catch((error) => {
        console.error("Failed to open attached link", error);
      });
      return;
    }

    if (attachment.kind === "file") {
      showFilePreview({
        kind: "attachment",
        attachment,
        workspaceRoot,
      });
      return;
    }

    setFilePreview(null);
    openAttachedPathExternally(attachment.path, workspaceRoot);
  };

  const handleCloseAttachmentImagePreview = (): void => {
    setAttachmentImagePreview(null);
  };

  const handleCloseFilePreview = (): void => {
    setFilePreview(null);
  };

  const handleOpenFilePreviewExternally = (): void => {
    if (!filePreview) {
      return;
    }

    if (filePreview.target.kind === "workspace") {
      openWorkspaceFileExternally(
        filePreview.target.workspaceRoot,
        filePreview.target.relativePath,
      );
      return;
    }

    openAttachedPathExternally(
      filePreview.target.attachment.path,
      filePreview.target.workspaceRoot,
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

      const pendingPromptEnhancement =
        promptEnhancementPendingTasks.find(
          (pending) =>
            pending.sessionId === session.id &&
            pending.taskId === targetTaskId,
        ) ?? null;

      if (pendingPromptEnhancement) {
        ignoredDesktopTaskIdsRef.current.add(targetTaskId);
        activeDesktopTasksRef.current.delete(targetTaskId);
        setPromptEnhancementStatus(null);
        setPromptEnhancementPendingTasks((current) =>
          current.filter((pending) => pending.taskId !== targetTaskId),
        );
        state.updateSessionById(pendingPromptEnhancement.sessionId, (current) => {
          const nextMessages = current.messages.filter(
            (message) =>
              getMessageTaskId(message) !== pendingPromptEnhancement.taskId,
          );
          const shouldRestoreComposer = Boolean(
            pendingPromptEnhancement.composerClearGuard &&
              isComposerClearGuardCurrent(
                current,
                pendingPromptEnhancement.composerClearGuard,
              ),
          );

          if (
            nextMessages.length === current.messages.length &&
            !shouldRestoreComposer
          ) {
            return current;
          }

          const updatedAt = Date.now();

          return applySessionMessageLimit({
            ...current,
            messages: nextMessages,
            ...(shouldRestoreComposer
              ? {
                  draft: pendingPromptEnhancement.prompt,
                  draftContextAttachments:
                    pendingPromptEnhancement.contextAttachments.map(
                      (attachment) => ({ ...attachment }),
                    ),
                }
              : {}),
            ...(shouldRestoreComposer
              ? { composerUpdatedAt: updatedAt }
              : {}),
            updatedAt,
          });
        });
      } else {
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
      }

      void cancelDesktopTask(targetTaskId).catch((error) => {
        console.error("Failed to cancel desktop task:", error);
      });
    },
    [
      applySessionMessageLimit,
      getActiveDesktopTaskIdForSession,
      promptEnhancementPendingTasks,
      state.activeSession.id,
      state.setDraftValue,
      state.updateSessionById,
      updateThinkingTrace,
    ],
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
          ...(activeSessionReasoningOverride
            ? { reasoning: activeSessionReasoningOverride }
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
      const reasoning = normalizeSessionReasoningOverride(
        baseSession.reasoning ?? activeSessionReasoningOverride,
        nextSession.provider,
        nextSession.model,
      );

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
      activeSessionReasoningOverride,
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

  const setQuickTaskDraft = useCallback(
    (update: string | ((currentDraft: string) => string)): void => {
      updateQuickTaskSession((session) => {
        const draft =
          typeof update === "function" ? update(session.draft) : update;

        if (draft === session.draft) {
          return session;
        }

        const updatedAt = Date.now();

        return {
          ...session,
          draft,
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [updateQuickTaskSession],
  );

  const setQuickTaskContextAttachments = useCallback(
    (
      update:
        | ChatSessionContextAttachment[]
        | ((
            currentAttachments: ChatSessionContextAttachment[],
          ) => ChatSessionContextAttachment[]),
    ): void => {
      updateQuickTaskSession((session) => {
        const draftContextAttachments =
          typeof update === "function"
            ? update(session.draftContextAttachments)
            : update;

        if (draftContextAttachments === session.draftContextAttachments) {
          return session;
        }

        const updatedAt = Date.now();

        return {
          ...session,
          draftContextAttachments,
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [updateQuickTaskSession],
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
      options: {
        updateWorkspaceRoot?: boolean;
        targetSessionId?: string;
        attachmentMutationVersion?: number;
      } = {},
    ): Promise<void> => {
      if (target === "active-session") {
        composerState.commitHistoryPreview();
      }

      const targetSessionId =
        target === "active-session"
          ? options.targetSessionId ?? activeSessionIdRef.current
          : null;
      const attachmentMutationKey =
        target === "quick-task"
          ? "quick-task"
          : `session:${targetSessionId ?? "missing"}`;
      const attachmentMutationVersion =
        options.attachmentMutationVersion ??
        attachmentMutationVersionsRef.current.get(attachmentMutationKey) ??
        0;
      const resolution = await resolveDroppedPaths(paths);
      const attachments = resolution.entries.map(createContextAttachment);
      const shouldUpdateWorkspaceRoot = options.updateWorkspaceRoot !== false;

      if (
        attachments.length === 0 ||
        (attachmentMutationVersionsRef.current.get(attachmentMutationKey) ?? 0) !==
          attachmentMutationVersion
      ) {
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

      if (!targetSessionId) {
        return;
      }

      if (activeSessionIdRef.current === targetSessionId) {
        composerState.resetDraftHistoryState();
      }

      state.updateSessionById(targetSessionId, (session) => {
        const updatedAt = Date.now();

        return {
          ...session,
          draftContextAttachments: mergeContextAttachments(
            session.draftContextAttachments,
            attachments,
          ),
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });

      if (shouldUpdateWorkspaceRoot && resolution.workspaceRoot) {
        state.updateSessionById(targetSessionId, (session) =>
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
      composerState.commitHistoryPreview,
      composerState.resetDraftHistoryState,
      state.updateSessionById,
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

      composerState.commitHistoryPreview();
      state.updateActiveSession((session) => {
        const updatedAt = Date.now();

        return {
          ...session,
          draftContextAttachments: mergeContextAttachments(
            session.draftContextAttachments,
            attachments,
          ),
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [composerState.commitHistoryPreview, state.updateActiveSession],
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

      composerState.commitHistoryPreview();
      state.setDraftValue((currentDraft) =>
        appendDraftBlock(currentDraft, normalizedText),
      );
    },
    [composerState.commitHistoryPreview, state.setDraftValue],
  );

  const handleSelectAttachments = useCallback(
    async (
      target: FileDropTarget,
      selectionKind: AttachmentSelectionKind,
    ): Promise<void> => {
      if (target === "active-session") {
        composerState.commitHistoryPreview();
      }

      const targetSessionId =
        target === "active-session" ? activeSessionIdRef.current : undefined;
      const attachmentMutationKey =
        target === "quick-task"
          ? "quick-task"
          : `session:${targetSessionId ?? "missing"}`;
      const attachmentMutationVersion =
        attachmentMutationVersionsRef.current.get(attachmentMutationKey) ?? 0;
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
          { targetSessionId, attachmentMutationVersion },
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

        await handleAttachPaths(normalizeDialogSelection(selected), target, {
          targetSessionId,
          attachmentMutationVersion,
        });
      } catch (error) {
        console.error("Failed to select context attachments", error);
      }
    },
    [
      composerState.commitHistoryPreview,
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
      if (target === "active-session") {
        composerState.commitHistoryPreview();
      }

      const targetSessionId =
        target === "active-session" ? activeSessionIdRef.current : undefined;
      const attachmentMutationKey =
        target === "quick-task"
          ? "quick-task"
          : `session:${targetSessionId ?? "missing"}`;
      const attachmentMutationVersion =
        attachmentMutationVersionsRef.current.get(attachmentMutationKey) ?? 0;
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

      await handleAttachPaths(paths, target, {
        updateWorkspaceRoot: false,
        targetSessionId,
        attachmentMutationVersion,
      });
    },
    [
      composerState.commitHistoryPreview,
      handleAttachPaths,
      quickTaskModel,
      quickTaskProvider,
      state.activeSession.model,
      state.activeSession.provider,
    ],
  );

  const handleSaveContextPack = useCallback(
    (input: SaveSmartContextPackInput): void => {
      const name = (input.name ?? "").replace(/\s+/gu, " ").trim();

      if (!name) {
        return;
      }

      const instructions = input.instructions?.trim() ?? "";
      const prompt = input.prompt?.trim() ?? "";
      const contextAttachments = cloneContextAttachmentsForPack(
        input.contextAttachments ?? [],
      );
      const provider = input.provider;
      const model = provider ? input.model?.trim() : undefined;
      const mode = input.mode;
      const reasoning = input.reasoning;

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
        const existingPack = input.id
          ? prev.contextPacks.find((contextPack) => contextPack.id === input.id)
          : undefined;
        const pack: SmartContextPack = {
          id: existingPack?.id ?? crypto.randomUUID(),
          workspace:
            input.scope === "global" ? null : state.activeSession.workspace,
          name,
          instructions,
          prompt,
          contextAttachments,
          variables: createSmartContextPackVariables(input.variables ?? []),
          trigger: {
            phrases: input.triggerPhrases ?? [],
            pathPatterns: input.triggerPathPatterns ?? [],
            autoApply: input.autoApply ?? false,
          },
          ...(provider ? { provider } : {}),
          ...(provider && model ? { model } : {}),
          ...(mode ? { mode } : {}),
          ...(reasoning ? { reasoning } : {}),
          createdAt: existingPack?.createdAt ?? now,
          updatedAt: now,
          ...(existingPack?.lastUsedAt !== undefined
            ? { lastUsedAt: existingPack.lastUsedAt }
            : {}),
          useCount: existingPack?.useCount ?? 0,
        };

        if (existingPack) {
          return {
            ...prev,
            contextPacks: prev.contextPacks.map((contextPack) =>
              contextPack.id === existingPack.id ? pack : contextPack,
            ),
          };
        }

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

      composerState.commitHistoryPreview();
      const targetSessionId = state.activeSession.id;
      const targetUserMessageSignature = JSON.stringify(
        state.activeSession.messages
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      );
      const packRevisionSignature = JSON.stringify(pack);
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
      const savedProvider = pack.provider;
      const savedModel = pack.model;
      const savedModelSelection =
        savedProvider !== undefined &&
        savedModel !== undefined &&
        providerChooserState.chooserProviders.includes(savedProvider)
          ? { provider: savedProvider, model: savedModel }
          : null;
      let didApplyPack = false;

        state.applyShellState((prev) => {
        const currentPack = prev.contextPacks.find(
          (contextPack) => contextPack.id === pack.id,
        );
        const currentSession = prev.sessions.find(
          (session) => session.id === targetSessionId,
        );

        if (
          !currentPack ||
          JSON.stringify(currentPack) !== packRevisionSignature ||
          !currentSession ||
          JSON.stringify(
            currentSession.messages
              .filter((message) => message.role === "user")
              .map((message) => message.id),
          ) !== targetUserMessageSignature
        ) {
          return prev;
        }

        didApplyPack = true;
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
            if (session.id !== targetSessionId) {
              return session;
            }

            const application = applySmartContextPackToComposer(
              session.draft,
              session.draftContextAttachments,
              packForApplication,
              variableValues,
            );
            const nextSession: ChatSessionRecord = {
              ...session,
              draft: application.draft,
              draftContextAttachments: application.contextAttachments,
              composerUpdatedAt: now,
              updatedAt: now,
            };

            if (savedModelSelection) {
              nextSession.provider = savedModelSelection.provider;
              nextSession.model = savedModelSelection.model;
            }

            if (pack.mode) {
              nextSession.mode = pack.mode;
            }

            const nextReasoning = normalizeSessionReasoningOverride(
              pack.reasoning ?? nextSession.reasoning,
              nextSession.provider,
              nextSession.model,
            );

            if (nextReasoning) {
              nextSession.reasoning = nextReasoning;
            } else {
              delete nextSession.reasoning;
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

        if (pack.reasoning || savedModelSelection) {
          const reasoningProvider =
            savedModelSelection?.provider ?? prev.lastSelectedProvider;
          const reasoningModel =
            savedModelSelection?.model ??
            prev.lastSelectedModelByProvider[reasoningProvider];
          const nextLastSelectedReasoning = normalizeSessionReasoningOverride(
            pack.reasoning ?? prev.lastSelectedReasoning,
            reasoningProvider,
            reasoningModel,
          );

          if (nextLastSelectedReasoning) {
            nextState.lastSelectedReasoning = nextLastSelectedReasoning;
          } else {
            delete nextState.lastSelectedReasoning;
          }
        }

        return nextState;
      });

      if (didApplyPack && activeSessionIdRef.current === targetSessionId) {
        composerState.resetDraftHistoryState();
      }
    },
    [
      composerState.commitHistoryPreview,
      composerState.resetDraftHistoryState,
      providerChooserState.chooserProviders,
      state.activeSession.id,
      state.applyShellState,
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

  const handleExportContextPacks = useCallback(
    (scopeFilter: SmartContextPackScopeFilter): void => {
      const packsToExport = filterSmartContextPacksByScope(
        workspaceContextPacks,
        scopeFilter,
      );

      if (packsToExport.length === 0) {
        return;
      }

      const payload = createSmartContextPackExportPayload(packsToExport);
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const date = new Date().toISOString().slice(0, 10);
      const scopeSuffix =
        scopeFilter === "all" ? "" : `-${scopeFilter}`;

      anchor.href = url;
      anchor.download = `machdoch-context-packs${scopeSuffix}-${date}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    [workspaceContextPacks],
  );

  const handleImportContextPacks = useCallback(
    (file: File, scope: SmartContextPackScope): void => {
      if (scope === "workspace" && !state.activeSession.workspace) {
        return;
      }

      void file
        .text()
        .then((text) => JSON.parse(text) as unknown)
        .then((payload) => {
          state.applyShellState((prev) =>
            importSmartContextPacksIntoShellState(
              prev,
              payload,
              state.activeSession.workspace,
              scope,
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
    if (!activeComposerSession.draft.trim() && matchedContextPackIds.length === 0) {
      return;
    }

    const autoApplyPack = workspaceContextPacks.find((pack) => {
      return (
        pack.trigger.autoApply &&
        pack.variables.length === 0 &&
        !autoAppliedContextPackIdsRef.current.has(pack.id) &&
        matchedContextPackIds.includes(pack.id) &&
        !isSmartContextPackAppliedToDraft(activeComposerSession.draft, pack)
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
    activeComposerSession.draft,
    workspaceContextPacks,
  ]);

  const handleRemoveContextAttachment = useCallback(
    (target: FileDropTarget, attachmentId: string): void => {
      if (target === "quick-task") {
        const mutationKey = "quick-task";
        attachmentMutationVersionsRef.current.set(
          mutationKey,
          (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
        );
        setQuickTaskContextAttachments((attachments) =>
          attachments.filter((attachment) => attachment.id !== attachmentId),
        );
        return;
      }

      const targetSessionId = activeSessionIdRef.current;
      const mutationKey = `session:${targetSessionId}`;
      attachmentMutationVersionsRef.current.set(
        mutationKey,
        (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
      );
      composerState.commitHistoryPreview();
      state.updateSessionById(targetSessionId, (session) => {
        const updatedAt = Date.now();

        return {
          ...session,
          draftContextAttachments: session.draftContextAttachments.filter(
            (attachment) => attachment.id !== attachmentId,
          ),
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [
      composerState.commitHistoryPreview,
      state.updateSessionById,
    ],
  );

  const handleClearContextAttachments = useCallback(
    (target: FileDropTarget): void => {
      if (target === "quick-task") {
        const mutationKey = "quick-task";
        attachmentMutationVersionsRef.current.set(
          mutationKey,
          (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
        );
        setQuickTaskContextAttachments([]);
        return;
      }

      const targetSessionId = activeSessionIdRef.current;
      const mutationKey = `session:${targetSessionId}`;
      attachmentMutationVersionsRef.current.set(
        mutationKey,
        (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
      );
      composerState.commitHistoryPreview();
      state.updateSessionById(targetSessionId, (session) => {
        if (session.draftContextAttachments.length === 0) {
          return session;
        }

        const updatedAt = Date.now();

        return {
          ...session,
          draftContextAttachments: [],
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [
      composerState.commitHistoryPreview,
      state.updateSessionById,
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

  const clearSessionComposerInput = useCallback(
    (
      sessionId: string,
      expectedComposer?: ComposerClearGuard,
    ): ComposerClearGuard | null => {
      let clearedComposer: ComposerClearGuard | null = null;

      if (sessionId === state.activeSession.id) {
        composerState.resetDraftHistoryState();
      }

      state.updateSessionById(sessionId, (session) => {
        if (
          expectedComposer &&
          !isComposerClearGuardCurrent(session, expectedComposer)
        ) {
          return session;
        }

        if (
          session.draft.length === 0 &&
          session.draftContextAttachments.length === 0
        ) {
          clearedComposer = createComposerClearGuard(session);
          return session;
        }

        const updatedAt = Date.now();
        const nextSession: ChatSessionRecord = {
          ...session,
          draft: "",
          draftContextAttachments: [],
          composerUpdatedAt: updatedAt,
          updatedAt,
        };

        clearedComposer = createComposerClearGuard(nextSession);
        return nextSession;
      });

      if (clearedComposer) {
        state.applyShellState((currentState) => {
          const clearedSession = currentState.sessions.find(
            (session) => session.id === sessionId,
          );

          if (clearedSession) {
            clearedComposer = createComposerClearGuard(clearedSession);
          }

          return currentState;
        });
        invalidateAttachmentMutation(`session:${sessionId}`);
      }

      return clearedComposer;
    },
    [
      composerState.resetDraftHistoryState,
      invalidateAttachmentMutation,
      state.applyShellState,
      state.activeSession.id,
      state.updateSessionById,
    ],
  );

  const restoreSessionComposerInput = useCallback(
    (input: {
      sessionId: string;
      prompt: string;
      contextAttachments: ChatSessionContextAttachment[];
      composerClearGuard: ComposerClearGuard;
    }): void => {
      state.updateSessionById(input.sessionId, (session) => {
        if (!isComposerClearGuardCurrent(session, input.composerClearGuard)) {
          return session;
        }

        const updatedAt = Date.now();

        return {
          ...session,
          draft: input.prompt,
          draftContextAttachments: input.contextAttachments.map(
            (attachment) => ({ ...attachment }),
          ),
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [state.updateSessionById],
  );

  const restorePromptEnhancementComposer = useCallback(
    (pending: PromptEnhancementPendingState): void => {
      state.updateSessionById(pending.sessionId, (session) => {
        const nextMessages = session.messages.filter(
          (message) => getMessageTaskId(message) !== pending.taskId,
        );
        const shouldRestoreComposer = Boolean(
          pending.composerClearGuard &&
            isComposerClearGuardCurrent(session, pending.composerClearGuard),
        );

        if (
          nextMessages.length === session.messages.length &&
          !shouldRestoreComposer
        ) {
          return session;
        }

        const updatedAt = Date.now();

        return applySessionMessageLimit({
          ...session,
          messages: nextMessages,
          ...(shouldRestoreComposer
            ? {
                draft: pending.prompt,
                draftContextAttachments: pending.contextAttachments.map(
                  (attachment) => ({ ...attachment }),
                ),
              }
            : {}),
          ...(shouldRestoreComposer
            ? { composerUpdatedAt: updatedAt }
            : {}),
          updatedAt,
        });
      });

    },
    [
      applySessionMessageLimit,
      state.updateSessionById,
    ],
  );

  const showPromptEnhancementSessionPlaceholder = useCallback(
    (pending: PromptEnhancementPendingState): void => {
      state.updateSessionById(pending.sessionId, (session) => {
        if (
          session.messages.some(
            (message) => getMessageTaskId(message) === pending.taskId,
          )
        ) {
          return session;
        }

        return applySessionMessageLimit({
          ...session,
          updatedAt: pending.startedAt,
          messages: [
            ...session.messages,
            ...createPromptEnhancementSessionMessages(pending),
          ],
        });
      });
    },
    [applySessionMessageLimit, state.updateSessionById],
  );

  const removePromptEnhancementSessionPlaceholder = useCallback(
    (pending: PromptEnhancementPendingState): void => {
      state.updateSessionById(pending.sessionId, (session) => {
        const nextMessages = session.messages.filter(
          (message) => getMessageTaskId(message) !== pending.taskId,
        );

        if (nextMessages.length === session.messages.length) {
          return session;
        }

        return applySessionMessageLimit({
          ...session,
          updatedAt: Date.now(),
          messages: nextMessages,
        });
      });
    },
    [applySessionMessageLimit, state.updateSessionById],
  );

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
    onComposerCleared: (sessionId) =>
      invalidateAttachmentMutation(`session:${sessionId}`),
    onSessionOperationConflict: (submission) =>
      sessionOperationConflictHandlerRef.current(submission),
  });

  const enhancePromptForSubmission = useCallback(
    async (
      submission: Extract<ChatInputNeededSubmission, { kind: "active-session" }>,
      prompt: string,
      placement: PromptEnhancementPendingPlacement,
    ): Promise<string> => {
      const normalizedPrompt = prompt.trim();

      if (!normalizedPrompt || promptEnhancementMode === "off") {
        return normalizedPrompt;
      }

      if (
        promptEnhancementMode === "web-search" &&
        !promptEnhancementWebSearchAvailable
      ) {
        const error = PROMPT_ENHANCEMENT_WEB_SEARCH_UNAVAILABLE_REASON;
        setPromptEnhancementStatus({ tone: "error", text: error });
        throw new Error(error);
      }

      const activeMode = promptEnhancementMode as ActivePromptEnhancementMode;
      const taskId = `prompt-enhancement-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const sessionSnapshot = submission.sessionSnapshot;
      const reasoning = normalizeSessionReasoningOverride(
        sessionSnapshot.reasoning,
        sessionSnapshot.provider,
        sessionSnapshot.model,
      );
      const pending: PromptEnhancementPendingState = {
        taskId,
        sessionId: sessionSnapshot.id,
        mode: activeMode,
        prompt: normalizedPrompt,
        contextAttachments: submission.contextAttachments.map((attachment) => ({
          ...attachment,
        })),
        placement,
        startedAt: Date.now(),
      };
      const imagePaths = getImageAttachmentPaths(submission.contextAttachments);

      activeDesktopTasksRef.current.set(taskId, sessionSnapshot.id);
      setPromptEnhancementStatus(null);
      setPromptEnhancementPreview((current) =>
        current?.sessionId === sessionSnapshot.id ? null : current,
      );
      setPromptEnhancementPendingTasks((current) => [...current, pending]);
      showPromptEnhancementSessionPlaceholder(pending);

      if (placement === "message") {
        const clearedComposer = clearSessionComposerInput(
          sessionSnapshot.id,
          submission.composerClearGuard,
        );

        if (clearedComposer) {
          pending.composerClearGuard = clearedComposer;
          submission.composerClearGuard = clearedComposer;
        }
      }

      try {
        const taskRun = await runDesktopTask(
          sessionSnapshot.workspace,
          createPromptEnhancementTask({
            mode: activeMode,
            prompt: normalizedPrompt,
            contextAttachments: submission.contextAttachments,
          }),
          {
            conversationContext: createConversationContextFromSession(
              sessionSnapshot,
              runtime.userMemorySettings.globalEnabled,
              uiControlAvailability,
              aiContextMessageLimit,
            ),
            mode: "ask",
            provider: sessionSnapshot.provider,
            model: sessionSnapshot.model,
            ...(reasoning ? { reasoning } : {}),
            ...(imagePaths.length > 0 ? { imagePaths } : {}),
            sessionId: sessionSnapshot.id,
            taskId,
          },
        );

        if (ignoredDesktopTaskIdsRef.current.has(taskId)) {
          throw new Error("cancelled");
        }

        const responseText =
          taskRun.execution.response?.markdown ?? taskRun.execution.summary;
        const enhancedPrompt = extractEnhancedPrompt(responseText);

        if (!enhancedPrompt) {
          throw new Error("Prompt enhancement did not return an enhanced prompt.");
        }

        if (taskRun.execution.status === "blocked") {
          throw new Error(taskRun.execution.reason ?? taskRun.execution.summary);
        }

        setPromptEnhancementStatus(null);

        return enhancedPrompt;
      } catch (error) {
        const message = getPromptEnhancementErrorMessage(error);
        const wasCancelled = /\bcancell?ed\b|\bcancellation\b/iu.test(message);

        if (placement === "message") {
          removePromptEnhancementSessionPlaceholder(pending);
          restorePromptEnhancementComposer(pending);
        }

        setPromptEnhancementStatus(
          wasCancelled
            ? null
            : {
                tone: "error",
                text: `Prompt enhancement failed: ${message}`,
              },
        );
        throw error instanceof Error ? error : new Error(message);
      } finally {
        activeDesktopTasksRef.current.delete(taskId);
        ignoredDesktopTaskIdsRef.current.delete(taskId);
        removePromptEnhancementSessionPlaceholder(pending);
        setPromptEnhancementPendingTasks((current) =>
          current.filter((entry) => entry.taskId !== taskId),
        );
      }
    },
    [
      aiContextMessageLimit,
      clearSessionComposerInput,
      promptEnhancementMode,
      promptEnhancementWebSearchAvailable,
      removePromptEnhancementSessionPlaceholder,
      restorePromptEnhancementComposer,
      runtime.userMemorySettings.globalEnabled,
      showPromptEnhancementSessionPlaceholder,
      uiControlAvailability,
    ],
  );

  const requestChatInputNeededValues = useCallback(
    (submission: ChatInputNeededSubmission): boolean => {
      const placeholders = extractChatInputNeededPlaceholders(submission.task);

      if (placeholders.length === 0) {
        return false;
      }

      setChatInputNeeded({
        submission,
        placeholders,
        valuesByLookupKey: {},
        currentIndex: 0,
      });

      return true;
    },
    [],
  );

  const queueActiveSessionMessage = useCallback(
    (
      placement: "front" | "back",
      input?: {
        sessionId: string;
        task: string;
        visibleMessageContent?: string;
        promptHistoryContent?: string;
        promptEnhancement?: ChatSessionMessagePromptEnhancement;
        blockedByTaskId?: string;
        contextAttachments: ChatSessionContextAttachment[];
        composerClearGuard?: ComposerClearGuard;
        clearComposer?: boolean;
      },
    ): ChatSessionQueuedMessage | null => {
      const task = (input?.task ?? state.activeSession.draft).trim();
      const sessionId = input?.sessionId ?? state.activeSession.id;
      const targetSession = shellStateRef.current.sessions.find(
        (session) => session.id === sessionId,
      );
      const contextAttachments = (
        input?.contextAttachments ?? state.activeSession.draftContextAttachments
      ).map((attachment) => ({ ...attachment }));
      const hasUnsupportedImage = Boolean(
        targetSession &&
          getImageAttachmentPaths(contextAttachments).length > 0 &&
          !modelSupportsImageInput(targetSession.provider, targetSession.model),
      );

      if (!task || !targetSession || hasUnsupportedImage) {
        return null;
      }

      const now = Date.now();
      const sessionOrderRanks = shellStateRef.current.queuedSessionMessages
        .filter((message) => message.sessionId === sessionId)
        .map((message) => message.orderRank);
      const orderRank =
        placement === "front"
          ? Math.min(0, ...sessionOrderRanks) - 1
          : Math.max(-1, ...sessionOrderRanks) + 1;
      const queuedMessage: ChatSessionQueuedMessage = {
        id: crypto.randomUUID(),
        sessionId,
        task,
        ...(input?.visibleMessageContent?.trim()
          ? { visibleMessageContent: input.visibleMessageContent.trim() }
          : {}),
        ...(input?.promptHistoryContent?.trim()
          ? { promptHistoryContent: input.promptHistoryContent.trim() }
          : {}),
        ...(input?.promptEnhancement ? { promptEnhancement: input.promptEnhancement } : {}),
        ...(input?.blockedByTaskId
          ? { blockedByTaskId: input.blockedByTaskId }
          : {}),
        contextAttachments,
        contentUpdatedAt: now,
        attachmentsUpdatedAt: now,
        attachmentTombstones: {},
        blockerUpdatedAt: now,
        orderRank,
        orderUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      updateQueuedSessionMessages((current) =>
        placement === "front"
          ? [queuedMessage, ...current]
          : [...current, queuedMessage],
      );
      if (input?.clearComposer !== false) {
        clearSessionComposerInput(
          queuedMessage.sessionId,
          input?.composerClearGuard,
        );
      }

      return queuedMessage;
    },
    [
      clearSessionComposerInput,
      state.activeSession,
      updateQueuedSessionMessages,
    ],
  );

  const handleSessionOperationConflict = useCallback(
    (submission: SessionOperationConflictSubmission): boolean => {
      const { activeTaskId, ...queuedSubmission } = submission;
      const queuedMessage = queueActiveSessionMessage("back", {
        ...queuedSubmission,
        blockedByTaskId: activeTaskId,
        clearComposer: false,
      });

      if (!queuedMessage) {
        return false;
      }

      activeDesktopTasksRef.current.set(activeTaskId, submission.sessionId);
      return true;
    },
    [queueActiveSessionMessage],
  );
  sessionOperationConflictHandlerRef.current = handleSessionOperationConflict;

  useEffect(() => {
    if (!blockedQueuedTaskIdsSignature) {
      return;
    }

    let disposed = false;
    let reconcileInFlight = false;

    const reconcileSessionOperationConflicts = async (): Promise<void> => {
      if (disposed || reconcileInFlight) {
        return;
      }

      reconcileInFlight = true;

      try {
        const activeTasks = await loadActiveDesktopTasks();

        if (disposed || activeTasks === null) {
          return;
        }

        const activeTaskIds = new Set(activeTasks.map((task) => task.id));
        const blockedMessages =
          shellStateRef.current.queuedSessionMessages.filter(
            (message) => message.blockedByTaskId,
          );

        for (const blockedMessage of blockedMessages) {
          const taskId = blockedMessage.blockedByTaskId;

          if (!taskId) {
            continue;
          }

          if (activeTaskIds.has(taskId)) {
            activeDesktopTasksRef.current.set(
              taskId,
              blockedMessage.sessionId,
            );
            continue;
          }

          if (
            activeDesktopTasksRef.current.get(taskId) ===
            blockedMessage.sessionId
          ) {
            activeDesktopTasksRef.current.delete(taskId);
          }
        }

        const now = Date.now();
        updateQueuedSessionMessages((current) => {
          let changed = false;
          const nextMessages = current.map((message) => {
            if (
              !message.blockedByTaskId ||
              activeTaskIds.has(message.blockedByTaskId)
            ) {
              return message;
            }

            const nextMessage = {
              ...message,
              blockerUpdatedAt: now,
              updatedAt: now,
            };
            delete nextMessage.blockedByTaskId;
            changed = true;
            return nextMessage;
          });

          return changed ? nextMessages : current;
        });
      } finally {
        reconcileInFlight = false;
      }
    };

    void reconcileSessionOperationConflicts();
    const intervalId = window.setInterval(() => {
      void reconcileSessionOperationConflicts();
    }, 2_000);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [blockedQueuedTaskIdsSignature, updateQueuedSessionMessages]);

  const appendSteeringMessageToRunningTask = useCallback(
    (input?: {
      sessionSnapshot: ChatSessionRecord;
      task: string;
      contextAttachments: ChatSessionContextAttachment[];
      composerClearGuard?: ComposerClearGuard;
    }): boolean => {
      const submittedSessionSnapshot = input?.sessionSnapshot ?? state.activeSession;
      const sessionSnapshot =
        shellStateRef.current.sessions.find(
          (session) => session.id === submittedSessionSnapshot.id,
        ) ?? null;
      const task = (input?.task ?? state.activeSession.draft).trim();

      if (!sessionSnapshot || !task) {
        return false;
      }

      const contextAttachments = (
        input?.contextAttachments ?? state.activeSession.draftContextAttachments
      ).map((attachment) => ({
        ...attachment,
      }));
      const hasUnsupportedImage =
        getImageAttachmentPaths(contextAttachments).length > 0 &&
        !modelSupportsImageInput(
          sessionSnapshot.provider,
          sessionSnapshot.model,
        );

      if (hasUnsupportedImage) {
        return false;
      }

      const targetTaskId =
        getActiveDesktopTaskIdForSession(sessionSnapshot.id) ??
        getLatestRunningTaskId(sessionSnapshot);

      if (!targetTaskId) {
        return false;
      }

      const now = Date.now();
      const orderRank =
        Math.max(
          -1,
          ...shellStateRef.current.queuedSessionMessages
            .filter((message) => message.sessionId === sessionSnapshot.id)
            .map((message) => message.orderRank),
        ) + 1;
      const queuedMessage: ChatSessionQueuedMessage = {
        id: crypto.randomUUID(),
        sessionId: sessionSnapshot.id,
        task,
        visibleMessageContent: task,
        promptHistoryContent: task,
        contextAttachments,
        contentUpdatedAt: now,
        attachmentsUpdatedAt: now,
        attachmentTombstones: {},
        blockerUpdatedAt: now,
        orderRank,
        orderUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      updateQueuedSessionMessages((current) => [queuedMessage, ...current]);
      clearSessionComposerInput(
        sessionSnapshot.id,
        input?.composerClearGuard,
      );

      updateThinkingTrace(sessionSnapshot.id, targetTaskId, (trace) => {
        const progress: TaskExecutionProgress = {
          task: trace.task ?? "",
          mode: trace.mode,
          state: "executing",
          message:
            "Live steering is unavailable for this runtime; the note was queued as the next follow-up.",
          executedTools: [],
          outputSections: [],
          cancellable: true,
          timelineEvent: {
            kind: "state",
            phase: "started",
            label: "Follow-up queued",
            detail: appendContextAttachmentsToTask(task, contextAttachments),
            tone: "info",
          },
        };

        return appendThinkingProgress(trace, progress);
      });

      return true;
    },
    [
      clearSessionComposerInput,
      getActiveDesktopTaskIdForSession,
      state.activeSession,
      updateThinkingTrace,
      updateQueuedSessionMessages,
    ],
  );

  const dispatchNextQueuedMessageForSession = useCallback(
    (session: ChatSessionRecord): void => {
      const nextQueuedMessage = queuedSessionMessages.find(
        (message) =>
          message.sessionId === session.id && message.task.trim().length > 0,
      );

      if (
        !nextQueuedMessage ||
        Boolean(nextQueuedMessage.blockedByTaskId) ||
        dispatchingQueuedMessageIds.has(nextQueuedMessage.id)
      ) {
        return;
      }

      dispatchingQueuedMessageIds.add(nextQueuedMessage.id);
      void beginCrossWindowOperation(
        `queued-message:${nextQueuedMessage.id}`,
      )
        .then(async (lease) => {
          if (!lease) {
            return;
          }

          try {
            const latestQueuedMessage =
              shellStateRef.current.queuedSessionMessages.find(
                (message) => message.id === nextQueuedMessage.id,
              );
            const latestSession = shellStateRef.current.sessions.find(
              (entry) => entry.id === session.id,
            );
            const latestQueuedHead =
              shellStateRef.current.queuedSessionMessages.find(
                (message) =>
                  message.sessionId === session.id &&
                  message.task.trim().length > 0,
              );

            if (
              !latestQueuedMessage ||
              !latestSession ||
              latestQueuedHead?.id !== latestQueuedMessage.id ||
              getSessionOverviewStatus(latestSession) === "running"
            ) {
              await releaseCrossWindowOperation(lease);
              return;
            }

            const didSubmit = taskSubmission.submitTaskToSession({
              sessionSnapshot: latestSession,
              task: latestQueuedMessage.task,
              contextAttachments: latestQueuedMessage.contextAttachments,
              clearDraft: false,
              activateSession: shouldActivateSubmittedSession(latestSession.id),
              visibleMessageContent:
                latestQueuedMessage.visibleMessageContent ??
                latestQueuedMessage.task,
              promptHistoryContent:
                latestQueuedMessage.promptHistoryContent ??
                latestQueuedMessage.task,
              ...(latestQueuedMessage.promptEnhancement
                ? { promptEnhancement: latestQueuedMessage.promptEnhancement }
                : {}),
            });

            if (!didSubmit) {
              await releaseCrossWindowOperation(lease);
              return;
            }

            updateQueuedSessionMessages((current) =>
              current.filter(
                (message) =>
                  message.id !== latestQueuedMessage.id &&
                  !(
                    message.sessionId === latestSession.id &&
                    message.task.trim().length === 0
                  ),
              ),
            );
            await completeCrossWindowOperation(lease);
          } catch (error) {
            await releaseCrossWindowOperation(lease);
            throw error;
          }
        })
        .catch((error) => {
          console.error("Failed to dispatch queued message", error);
        })
        .finally(() => {
          dispatchingQueuedMessageIds.delete(nextQueuedMessage.id);
        });
    },
    [
      queuedSessionMessages,
      shouldActivateSubmittedSession,
      taskSubmission,
      updateQueuedSessionMessages,
    ],
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
      updateQueuedSessionMessages((current) =>
        current.map((message) => {
          if (message.id !== messageId) {
            return message;
          }

          const updatedAt = Date.now();
          const currentMessage = { ...message };
          delete currentMessage.promptEnhancement;

          return {
            ...currentMessage,
            task: content,
            visibleMessageContent: content,
            promptHistoryContent: content,
            contentUpdatedAt: updatedAt,
            updatedAt,
          };
        }),
      );
    },
    [updateQueuedSessionMessages],
  );

  const handleQueuedMessageMove = useCallback(
    (messageId: string, direction: -1 | 1): void => {
      updateQueuedSessionMessages((current) => {
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
    [updateQueuedSessionMessages],
  );

  const handleQueuedMessageReorder = useCallback(
    (messageId: string, targetIndex: number): void => {
      updateQueuedSessionMessages((current) =>
        reorderQueuedMessagesWithinSession(current, messageId, targetIndex),
      );
    },
    [updateQueuedSessionMessages],
  );

  const handleQueuedMessageRemove = useCallback((messageId: string): void => {
    const mutationKey = `queued:${messageId}`;
    attachmentMutationVersionsRef.current.set(
      mutationKey,
      (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
    );
    updateQueuedSessionMessages((current) =>
      current.filter((message) => message.id !== messageId),
    );
  }, [updateQueuedSessionMessages]);

  const handleAttachQueuedMessagePaths = useCallback(
    async (
      messageId: string,
      paths: string[],
      expectedMutationVersion?: number,
    ): Promise<void> => {
      const mutationKey = `queued:${messageId}`;
      const mutationVersion =
        expectedMutationVersion ??
        attachmentMutationVersionsRef.current.get(mutationKey) ??
        0;
      const resolution = await resolveDroppedPaths(paths);
      const attachments = resolution.entries.map(createContextAttachment);

      if (
        attachments.length === 0 ||
        (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) !==
          mutationVersion
      ) {
        return;
      }

      updateQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? (() => {
                const updatedAt = Date.now();
                return {
                ...message,
                contextAttachments: mergeContextAttachments(
                  message.contextAttachments,
                  attachments,
                ),
                attachmentsUpdatedAt: updatedAt,
                updatedAt,
              };
              })()
            : message,
        ),
      );
    },
    [updateQueuedSessionMessages],
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

      const mutationKey = `queued:${messageId}`;
      const mutationVersion =
        attachmentMutationVersionsRef.current.get(mutationKey) ?? 0;

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
        await handleAttachQueuedMessagePaths(
          messageId,
          [
            selectingFolders
              ? "/mock/context-folder"
              : selectingImages
                ? "/mock/screenshot.png"
                : "/mock/document.txt",
          ],
          mutationVersion,
        );
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
          mutationVersion,
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
      const mutationKey = `queued:${messageId}`;
      attachmentMutationVersionsRef.current.set(
        mutationKey,
        (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
      );
      updateQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId
            ? (() => {
                const updatedAt = Date.now();
                return {
                ...message,
                contextAttachments: message.contextAttachments.filter(
                  (attachment) => attachment.id !== attachmentId,
                ),
                attachmentTombstones: {
                  ...message.attachmentTombstones,
                  [attachmentId]: updatedAt,
                },
                attachmentsUpdatedAt: updatedAt,
                updatedAt,
              };
              })()
            : message,
        ),
      );
    },
    [updateQueuedSessionMessages],
  );

  const handleQueuedMessageClearContextAttachments = useCallback(
    (messageId: string): void => {
      const mutationKey = `queued:${messageId}`;
      attachmentMutationVersionsRef.current.set(
        mutationKey,
        (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
      );
      updateQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId &&
          message.contextAttachments.length > 0
            ? (() => {
                const updatedAt = Date.now();
                return {
                ...message,
                contextAttachments: [],
                attachmentTombstones: {
                  ...message.attachmentTombstones,
                  ...Object.fromEntries(
                    message.contextAttachments.map((attachment) => [
                      attachment.id,
                      updatedAt,
                    ]),
                  ),
                },
                attachmentsUpdatedAt: updatedAt,
                updatedAt,
              };
              })()
            : message,
        ),
      );
    },
    [updateQueuedSessionMessages],
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

        if (session.manualTitle === normalizedTitle) {
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

      state.updateSessionById(sessionId, (session) => {
        if (
          session.tags.length === normalizedTags.length &&
          session.tags.every((tag, index) => tag === normalizedTags[index])
        ) {
          return session;
        }

        return {
          ...session,
          tags: normalizedTags,
          updatedAt: Date.now(),
        };
      });
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

      state.updateSessionById(sessionId, (session) => {
        const updatedAt = Date.now();

        return {
          ...session,
          messages: [],
          promptHistory: [],
          promptContextHistory: [],
          sessionMemory: [],
          historyClearedAt: updatedAt,
          updatedAt,
        };
      });
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
      state.updateSessionById(sessionId, (session) => {
        if (session.draft === draft) {
          return session;
        }

        const updatedAt = Date.now();

        return {
          ...session,
          draft,
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [state.updateSessionById],
  );

  const handleRemoteSetSessionModel = useCallback(
    (sessionId: string, provider: RuntimeProvider, model: string): void => {
      if (!providerChooserState.chooserProviders.includes(provider)) {
        return;
      }

      state.applyShellState((prev) => {
        let sessionChanged = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          if (session.provider === provider && session.model === model) {
            return session;
          }

          sessionChanged = true;
          return {
            ...session,
            provider,
            model,
            updatedAt: Date.now(),
          };
        });
        const selectionChanged =
          prev.lastSelectedProvider !== provider ||
          prev.lastSelectedModelByProvider[provider] !== model;

        if (!sessionChanged && !selectionChanged) {
          return prev;
        }

        return {
          ...prev,
          lastSelectedProvider: provider,
          lastSelectedModelByProvider: {
            ...prev.lastSelectedModelByProvider,
            [provider]: model,
          },
          sessions,
        };
      });
    },
    [providerChooserState.chooserProviders, state.applyShellState],
  );

  const handleRemoteSetSessionMode = useCallback(
    (sessionId: string, mode: RunMode | null): void => {
      state.applyShellState((prev) => {
        let sessionChanged = false;
        const sessions = prev.sessions.map((session) => {
          if (session.id !== sessionId) {
            return session;
          }

          if (
            (mode && session.mode === mode) ||
            (!mode && session.mode === undefined)
          ) {
            return session;
          }

          sessionChanged = true;
          const nextSession = mode
            ? { ...session, mode }
            : removeSessionModeOverride(session);

          return {
            ...nextSession,
            updatedAt: Date.now(),
          };
        });
        const selectionChanged = Boolean(
          mode && prev.lastSelectedMode !== mode,
        );

        if (!sessionChanged && !selectionChanged) {
          return prev;
        }

        return {
          ...prev,
          ...(mode ? { lastSelectedMode: mode } : {}),
          sessions,
        };
      });
    },
    [state.applyShellState],
  );

  const handleRemoteSetSessionReasoning = useCallback(
    (sessionId: string, reasoning: ReasoningMode | null): void => {
      state.applyShellState((prev) => {
        let normalizedReasoning: ReasoningMode | undefined;
        let sessionFound = false;
        let sessionChanged = false;
        const sessions = prev.sessions.map((session) => {
            if (session.id !== sessionId) {
              return session;
            }

            sessionFound = true;
            normalizedReasoning = normalizeSessionReasoningOverride(
              reasoning,
              session.provider,
              session.model,
            );

            if (session.reasoning === normalizedReasoning) {
              return session;
            }

            sessionChanged = true;
            const nextSession: ChatSessionRecord = {
              ...session,
              updatedAt: Date.now(),
            };

            if (normalizedReasoning) {
              nextSession.reasoning = normalizedReasoning;
            } else {
              delete nextSession.reasoning;
            }

            return nextSession;
          });

        if (!sessionFound) {
          return prev;
        }

        const selectionChanged = normalizedReasoning
          ? prev.lastSelectedReasoning !== normalizedReasoning
          : prev.lastSelectedReasoning !== undefined;

        if (!sessionChanged && !selectionChanged) {
          return prev;
        }

        const nextState: ShellPersistedState = {
          ...prev,
          sessions,
        };

        if (normalizedReasoning) {
          nextState.lastSelectedReasoning = normalizedReasoning;
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
      state.updateSessionById(sessionId, (session) => {
        if (session[key] === enabled) {
          return session;
        }

        return {
          ...session,
          [key]: enabled,
          updatedAt: Date.now(),
        };
      });
    },
    [state.updateSessionById],
  );

  const handleRemoteRemoveContextAttachment = useCallback(
    (sessionId: string, attachmentId: string): void => {
      let removed = false;
      state.updateSessionById(sessionId, (session) => {
        if (
          !session.draftContextAttachments.some(
            (attachment) => attachment.id === attachmentId,
          )
        ) {
          return session;
        }

        removed = true;
        const updatedAt = Date.now();

        return {
          ...session,
          draftContextAttachments: session.draftContextAttachments.filter(
            (attachment) => attachment.id !== attachmentId,
          ),
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });

      if (removed) {
        invalidateAttachmentMutation(`session:${sessionId}`);
      }
    },
    [invalidateAttachmentMutation, state.updateSessionById],
  );

  const handleRemoteClearContextAttachments = useCallback(
    (sessionId: string): void => {
      let cleared = false;
      state.updateSessionById(sessionId, (session) => {
        if (session.draftContextAttachments.length === 0) {
          return session;
        }

        cleared = true;
        const updatedAt = Date.now();

        return {
          ...session,
          draftContextAttachments: [],
          composerUpdatedAt: updatedAt,
          updatedAt,
        };
      });

      if (cleared) {
        invalidateAttachmentMutation(`session:${sessionId}`);
      }
    },
    [invalidateAttachmentMutation, state.updateSessionById],
  );

  const handleRemoteApplyContextPack = useCallback(
    (sessionId: string, packId: string): boolean => {
      let applied = false;

      state.applyShellState((prev) => {
        const targetSession = prev.sessions.find(
          (session) => session.id === sessionId,
        );

        if (!targetSession) {
          return prev;
        }

        const pack = getSmartContextPacksForWorkspace(
          prev.contextPacks,
          targetSession.workspace,
        ).find((contextPack) => contextPack.id === packId);

        if (!pack) {
          return prev;
        }

        applied = true;

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
              composerUpdatedAt: now,
              updatedAt: now,
            };

            if (savedModelSelection) {
              nextSession.provider = savedModelSelection.provider;
              nextSession.model = savedModelSelection.model;
            }

            if (pack.mode) {
              nextSession.mode = pack.mode;
            }

            const nextReasoning = normalizeSessionReasoningOverride(
              pack.reasoning ?? nextSession.reasoning,
              nextSession.provider,
              nextSession.model,
            );

            if (nextReasoning) {
              nextSession.reasoning = nextReasoning;
            } else {
              delete nextSession.reasoning;
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

        if (pack.reasoning || savedModelSelection) {
          const reasoningProvider =
            savedModelSelection?.provider ?? prev.lastSelectedProvider;
          const reasoningModel =
            savedModelSelection?.model ??
            prev.lastSelectedModelByProvider[reasoningProvider];
          const nextLastSelectedReasoning = normalizeSessionReasoningOverride(
            pack.reasoning ?? prev.lastSelectedReasoning,
            reasoningProvider,
            reasoningModel,
          );

          if (nextLastSelectedReasoning) {
            nextState.lastSelectedReasoning = nextLastSelectedReasoning;
          } else {
            delete nextState.lastSelectedReasoning;
          }
        }

        return nextState;
      });

      return applied;
    },
    [
      providerChooserState.chooserProviders,
      state.applyShellState,
    ],
  );

  const handleQueueRemoteSessionFollowUp = useCallback(
    (sessionId: string, task: string): boolean =>
      queueActiveSessionMessage("back", {
        sessionId,
        task,
        contextAttachments: [],
        clearComposer: false,
      }) !== null,
    [queueActiveSessionMessage],
  );

  const remoteMissionControl = useRemoteMissionControl({
    hasHydrated: state.hasHydrated,
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
    sendDisabledReason: activeSessionSendDisabledReason,
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
    flushPersistence: state.flushPersistence,
    onMarkRemoteCommandHandled: (commandId: string) => {
      state.applyShellState((prev) => {
        if (prev.handledRemoteCommandIds.includes(commandId)) {
          return prev;
        }

        return {
          ...prev,
          handledRemoteCommandIds: [
            ...prev.handledRemoteCommandIds,
            commandId,
          ].slice(-512),
        };
      });
    },
    submitTaskToSession: taskSubmission.submitTaskToSession,
    onRetryTask: taskSubmission.handleRetryTask,
    onContinueTask: taskSubmission.handleContinueTask,
    onCreateSession: handleCreateSession,
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
    onQueueSessionFollowUp: handleQueueRemoteSessionFollowUp,
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
    ): boolean => {
      const normalizedTranscript = transcript.trim();

      if (!normalizedTranscript) {
        return false;
      }

      return taskSubmission.submitTaskToSession({
        sessionSnapshot: buildQuickVoiceSessionSnapshot(),
        task: normalizedTranscript,
        contextAttachments,
        clearDraft: true,
        createSessionIfMissing: true,
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

    const contextAttachments = quickTaskContextAttachments.map((attachment) => ({
      ...attachment,
    }));

    if (
      requestChatInputNeededValues({
        kind: "quick-task",
        task: normalizedDraft,
        contextAttachments,
      })
    ) {
      return;
    }

    if (submitQuickVoiceCommand(normalizedDraft, contextAttachments)) {
      invalidateAttachmentMutation("quick-task");
      setQuickTaskDraft("");
      setQuickTaskContextAttachments([]);
    }
  }, [
    quickTaskContextAttachments,
    quickTaskDraft,
    quickTaskImageInputError,
    invalidateAttachmentMutation,
    requestChatInputNeededValues,
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
          historyClearedAt: nextUpdatedAt,
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
    interviewTaskId?: string,
  ): void => {
    if (interviewTaskId) {
      activeDesktopTasksRef.current.delete(interviewTaskId);
      desktopTaskProgressHandlersRef.current.delete(interviewTaskId);
      ignoredDesktopTaskIdsRef.current.delete(interviewTaskId);
    }

    const visibleTask = context.task;
    const promptEnhancement = createMessagePromptEnhancement(
      visibleTask,
      context.originalTask,
    );
    const composerClearGuard =
      interviewComposerClearGuardsRef.current.get(context);

    setPromptEnhancementPreview((current) =>
      current?.sessionId === context.sessionSnapshot.id ? null : current,
    );

    const submitted = taskSubmission.submitTaskToSession({
      sessionSnapshot: context.sessionSnapshot,
      task: finalPrompt,
      contextAttachments: context.contextAttachments,
      clearDraft: true,
      ...(composerClearGuard ? { composerClearGuard } : {}),
      activateSession: shouldActivateSubmittedSession(context.sessionSnapshot.id),
      visibleMessageContent: visibleTask,
      promptHistoryContent: context.originalTask ?? visibleTask,
      ...(promptEnhancement ? { promptEnhancement } : {}),
    });

    if (submitted) {
      interviewComposerClearGuardsRef.current.delete(context);
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
    requestRevision: number,
  ): Promise<void> => {
    if (chatInterviewRequestRevisionRef.current !== requestRevision) {
      return;
    }

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

    if (chatInterviewRequestRevisionRef.current !== requestRevision) {
      return;
    }

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
    submitTaskFromInterview(context, finalPrompt, taskId);
  };

  const requestChatInterviewRound = async (
    context: ChatInterviewStartContext,
    session?: ChatInterviewDialogState["session"],
    answers?: Record<string, RalphInputValue>,
    answerComments?: Record<string, string>,
  ): Promise<void> => {
    const requestRevision = ++chatInterviewRequestRevisionRef.current;
    const taskId = `task-interview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const initialThinking = createInitialThinkingTrace(context.mode, Date.now());

    activeDesktopTasksRef.current.set(taskId, context.sessionSnapshot.id);
    desktopTaskProgressHandlersRef.current.set(taskId, (progress, timestamp) => {
      setChatInterview((current) => {
        if (current?.taskId !== taskId) {
          return current;
        }

        return {
          ...current,
          thinking: appendThinkingProgress(
            current.thinking ?? initialThinking,
            progress,
            timestamp,
          ),
        };
      });
    });

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
      thinking: initialThinking,
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

      await applyChatInterviewResult(
        context,
        taskId,
        result,
        requestRevision,
      );
    } catch (error) {
      if (chatInterviewRequestRevisionRef.current !== requestRevision) {
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      setChatInterview((current) =>
        current?.taskId === taskId
          ? {
              ...current,
              status: "blocked",
              summary: errorMessage,
              error: errorMessage,
              thinking: appendThinkingProgress(
                current.thinking ?? initialThinking,
                {
                  task: context.task,
                  mode: context.mode,
                  state: "blocked",
                  message: errorMessage,
                  executedTools: [],
                  outputSections: [],
                  cancellable: false,
                },
              ),
            }
          : current,
      );
    } finally {
      desktopTaskProgressHandlersRef.current.delete(taskId);
      activeDesktopTasksRef.current.delete(taskId);
      ignoredDesktopTaskIdsRef.current.delete(taskId);
    }
  };

  const startChatInterview = (
    task: string,
    sessionSnapshot = state.activeSession,
    contextAttachments = state.activeSession.draftContextAttachments,
    originalTask?: string,
    composerClearGuard?: ComposerClearGuard,
  ): void => {
    const reasoning = normalizeSessionReasoningOverride(
      sessionSnapshot.reasoning,
      sessionSnapshot.provider,
      sessionSnapshot.model,
    );
    const context: ChatInterviewStartContext = {
      sessionSnapshot,
      task,
      ...(originalTask && originalTask.trim() !== task.trim()
        ? { originalTask: originalTask.trim() }
        : {}),
      contextAttachments: contextAttachments.map((attachment) => ({
        ...attachment,
      })),
      mode: activeRunMode,
      provider: sessionSnapshot.provider,
      model: sessionSnapshot.model,
      ...(reasoning ? { reasoning } : {}),
    };

    if (composerClearGuard) {
      interviewComposerClearGuardsRef.current.set(context, composerClearGuard);
    }

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

  const closeChatInterview = useCallback((): void => {
    chatInterviewRequestRevisionRef.current += 1;
    const taskId = chatInterview?.taskId;

    if (taskId && activeDesktopTasksRef.current.has(taskId)) {
      ignoredDesktopTaskIdsRef.current.add(taskId);
      activeDesktopTasksRef.current.delete(taskId);
      desktopTaskProgressHandlersRef.current.delete(taskId);
      void cancelDesktopTask(taskId).catch((error) => {
        console.error("Failed to cancel closed task interview:", error);
      });
    }

    setChatInterview(null);
    setPromptEnhancementPreview(null);
  }, [chatInterview]);

  const submitResolvedChatInputNeededSubmission = useCallback(
    (
      submission: ChatInputNeededSubmission,
      resolvedTask: string,
    ): void => {
      if (submission.kind === "quick-task") {
        if (submitQuickVoiceCommand(resolvedTask, submission.contextAttachments)) {
          invalidateAttachmentMutation("quick-task");
          setQuickTaskDraft("");
          setQuickTaskContextAttachments([]);
        }
        return;
      }

      const submitActiveSessionTask = (
        task: string,
        originalTask?: string,
      ): void => {
        const promptEnhancement = createMessagePromptEnhancement(
          task,
          originalTask,
        );
        const promptHistoryContent =
          promptEnhancement?.originalContent ?? task;

        const restoreFailedTaskHandoff = (message: string): void => {
          restoreSessionComposerInput({
            sessionId: submission.sessionSnapshot.id,
            prompt: originalTask ?? resolvedTask,
            contextAttachments: submission.contextAttachments,
            composerClearGuard: submission.composerClearGuard,
          });
          setPromptEnhancementStatus({
            tone: "error",
            text: message,
          });
        };

        if (submission.runningAction) {
          switch (submission.runningAction) {
            case "steer":
              appendSteeringMessageToRunningTask({
                sessionSnapshot: submission.sessionSnapshot,
                task: resolvedTask,
                contextAttachments: submission.contextAttachments,
                composerClearGuard: submission.composerClearGuard,
              });
              return;
            case "stop-and-send": {
              const queuedMessage = queueActiveSessionMessage("front", {
                sessionId: submission.sessionSnapshot.id,
                task,
                visibleMessageContent: task,
                promptHistoryContent,
                ...(promptEnhancement ? { promptEnhancement } : {}),
                contextAttachments: submission.contextAttachments,
                composerClearGuard: submission.composerClearGuard,
              });

              if (queuedMessage) {
                requestTaskCancellation(submission.sessionSnapshot);
              }
              return;
            }
            case "queue":
              queueActiveSessionMessage("back", {
                sessionId: submission.sessionSnapshot.id,
                task,
                visibleMessageContent: task,
                promptHistoryContent,
                ...(promptEnhancement ? { promptEnhancement } : {}),
                contextAttachments: submission.contextAttachments,
                composerClearGuard: submission.composerClearGuard,
              });
              return;
          }
        }

        if (chatInterviewEnabled) {
          if (promptEnhancement) {
            setPromptEnhancementPreview({
              id: `prompt-enhancement-preview-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
              sessionId: submission.sessionSnapshot.id,
              content: task,
              originalContent: promptEnhancement.originalContent,
              contextAttachments: submission.contextAttachments.map(
                (attachment) => ({ ...attachment }),
              ),
            });
            void waitForPromptEnhancementPreviewFrame().then(() => {
              startChatInterview(
                task,
                submission.sessionSnapshot,
                submission.contextAttachments,
                promptEnhancement.originalContent,
                submission.composerClearGuard,
              );
            });
            return;
          }

          startChatInterview(
            task,
            submission.sessionSnapshot,
            submission.contextAttachments,
            originalTask,
            submission.composerClearGuard,
          );
          return;
        }

        const didSubmit = taskSubmission.submitTaskToSession({
          sessionSnapshot: submission.sessionSnapshot,
          task,
          contextAttachments: submission.contextAttachments,
          clearDraft: true,
          composerClearGuard: submission.composerClearGuard,
          activateSession: shouldActivateSubmittedSession(
            submission.sessionSnapshot.id,
          ),
          visibleMessageContent: task,
          promptHistoryContent,
          ...(promptEnhancement ? { promptEnhancement } : {}),
        });

        if (!didSubmit) {
          restoreFailedTaskHandoff(
            "The request could not start because the session is already running.",
          );
        }
      };

      if (
        promptEnhancementMode === "off" ||
        submission.runningAction === "steer"
      ) {
        submitActiveSessionTask(resolvedTask);
        return;
      }

      void (async (): Promise<void> => {
        let task: string;
        const enhancementPlacement: PromptEnhancementPendingPlacement =
          chatInterviewEnabled && !submission.runningAction
            ? "composer-blocker"
            : "message";

        try {
          task = await enhancePromptForSubmission(
            submission,
            resolvedTask,
            enhancementPlacement,
          );
        } catch {
          return;
        }

        submitActiveSessionTask(task, resolvedTask);
      })();
    },
    [
      appendSteeringMessageToRunningTask,
      chatInterviewEnabled,
      enhancePromptForSubmission,
      promptEnhancementMode,
      queueActiveSessionMessage,
      requestTaskCancellation,
      invalidateAttachmentMutation,
      restoreSessionComposerInput,
      shouldActivateSubmittedSession,
      startChatInterview,
      submitQuickVoiceCommand,
      taskSubmission,
    ],
  );

  const cancelChatInputNeeded = useCallback((): void => {
    setChatInputNeeded(null);
  }, []);

  const submitChatInputNeededValue = useCallback(
    (value: string): void => {
      if (!chatInputNeeded) {
        return;
      }

      const currentPlaceholder =
        chatInputNeeded.placeholders[chatInputNeeded.currentIndex];

      if (!currentPlaceholder) {
        setChatInputNeeded(null);
        return;
      }

      const nextValuesByLookupKey = {
        ...chatInputNeeded.valuesByLookupKey,
        [currentPlaceholder.lookupKey]: value,
      };
      const nextIndex = chatInputNeeded.currentIndex + 1;

      if (nextIndex < chatInputNeeded.placeholders.length) {
        setChatInputNeeded({
          ...chatInputNeeded,
          valuesByLookupKey: nextValuesByLookupKey,
          currentIndex: nextIndex,
        });
        return;
      }

      const resolvedTask = replaceChatInputNeededPlaceholders(
        chatInputNeeded.submission.task,
        nextValuesByLookupKey,
      );

      setChatInputNeeded(null);
      submitResolvedChatInputNeededSubmission(
        chatInputNeeded.submission,
        resolvedTask,
      );
    },
    [chatInputNeeded, submitResolvedChatInputNeededSubmission],
  );

  const handleSend = (): void => {
    const task = activeComposerSession.draft.trim();

    if (
      !task ||
      activeSessionImageInputError ||
      activeSessionPromptEnhancementBusy ||
      promptEnhancementUnavailableReason
    ) {
      return;
    }

    const committedHistorySession = composerState.isHistoryPreviewActive
      ? composerState.commitHistoryPreview()
      : null;

    if (composerState.isHistoryPreviewActive && !committedHistorySession) {
      return;
    }

    const sessionSnapshot = committedHistorySession ?? activeComposerSession;
    const contextAttachments = sessionSnapshot.draftContextAttachments.map(
      (attachment) => ({ ...attachment }),
    );
    const submission: ChatInputNeededSubmission = {
      kind: "active-session",
      sessionSnapshot,
      task,
      contextAttachments,
      composerClearGuard: createComposerClearGuard(sessionSnapshot),
      runningAction:
        getSessionOverviewStatus(sessionSnapshot) === "running"
          ? runningTaskMessageAction
          : null,
    };

    if (requestChatInputNeededValues(submission)) {
      return;
    }

    submitResolvedChatInputNeededSubmission(submission, task);
  };

  const instructionRegistryInstructions: DiscoveredInstruction[] =
    instructionRegistry?.instructions ?? [];
  const instructionRegistryDiagnostics: CustomizationDiagnostic[] =
    instructionRegistry?.diagnostics ?? [];
  const currentChatInputNeededPlaceholder =
    chatInputNeeded?.placeholders[chatInputNeeded.currentIndex] ?? null;
  const conversationPromptEnhancementPending = null;
  const conversationPromptEnhancementPreview =
    promptEnhancementPreview?.sessionId === state.activeSession.id
      ? {
          id: promptEnhancementPreview.id,
          content: promptEnhancementPreview.content,
          originalContent: promptEnhancementPreview.originalContent,
          contextAttachments: promptEnhancementPreview.contextAttachments,
        }
      : null;
  const composerPromptEnhancementPending =
    activePromptEnhancementPending?.placement === "composer-blocker"
      ? {
          modeLabel:
            PROMPT_ENHANCEMENT_LABELS[activePromptEnhancementPending.mode],
        }
      : null;
  const activeSessionExecuting =
    getSessionOverviewStatus(state.activeSession) === "running";
  const activeSessionPromptEnhancementCancellable =
    activePromptEnhancementPending?.placement === "message";

  return {
    isDesktop,
    hasHydrated: state.hasHydrated,
    quickVoiceSettingsLoaded:
      runtime.userDesktopSettingsLoaded &&
      runtime.userSpeechToTextSettingsLoaded,
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
      onCreateSession: handleCreateSession,
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
      canPinSession: canPinSession(state.activeSession),
      canBranchSession: canDuplicateSession(state.activeSession),
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
      onCreateSession: handleCreateSession,
      onStartRename: () => {
        state.setRenameValue(currentSessionTitle);
        state.setIsRenamingSession(true);
      },
      onClearSessionHistory: clearQuickTaskHistory,
      onDeleteSession: () => lifecycleActions.deleteSession(state.activeSession.id),
    },
    conversation: {
      visibleMessages: state.visibleMessages,
      promptEnhancementPending: conversationPromptEnhancementPending,
      promptEnhancementPreview: conversationPromptEnhancementPreview,
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
    filePreview: {
      preview: filePreview,
      onOpenChange: (open: boolean) => {
        if (!open) {
          handleCloseFilePreview();
        }
      },
      onOpenExternal: handleOpenFilePreviewExternally,
    },
    chatInterview: {
      state: chatInterview,
      onClose: closeChatInterview,
      onValueChange: updateChatInterviewValue,
      onToggleComment: toggleChatInterviewComment,
      onCommentChange: updateChatInterviewComment,
      onSkipField: skipChatInterviewField,
      onStartNow: startTaskFromChatInterviewNow,
      onSubmitAnswers: () => void submitChatInterviewAnswers(),
    },
    inputNeeded: {
      request:
        chatInputNeeded && currentChatInputNeededPlaceholder
          ? {
              placeholder: currentChatInputNeededPlaceholder,
              currentIndex: chatInputNeeded.currentIndex,
              totalCount: chatInputNeeded.placeholders.length,
            }
          : null,
      onCancel: cancelChatInputNeeded,
      onSubmitValue: submitChatInputNeededValue,
    },
    composer: {
      activeSession: activeComposerSession,
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
      promptEnhancementMode,
      promptEnhancementWebSearchAvailable,
      promptEnhancementWebSearchUnavailableReason:
        PROMPT_ENHANCEMENT_WEB_SEARCH_UNAVAILABLE_REASON,
      promptEnhancementPending: composerPromptEnhancementPending,
      statusMessage: promptEnhancementStatus,
      contextAttachments: activeComposerSession.draftContextAttachments,
      contextPacks: workspaceContextPacks,
      matchedContextPackIds,
      imageInputSupported: activeSessionImageInputSupported,
      imageInputDisabledReason: activeSessionImageInputSupported
        ? null
        : createImageInputUnsupportedModelMessage(
            activeComposerSession.provider,
            activeComposerSession.model,
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
      sendDisabledReason: activeSessionSendDisabledReason,
      runningTaskMessageAction,
      queuedMessages: activeSessionQueuedMessages.map((message) => ({
        id: message.id,
        content: message.visibleMessageContent ?? message.task,
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
      onPromptEnhancementModeChange: handlePromptEnhancementModeChange,
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
      isExecuting:
        activeSessionExecuting || activeSessionPromptEnhancementCancellable,
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
