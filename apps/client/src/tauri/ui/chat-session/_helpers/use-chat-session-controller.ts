import { isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MediaAssetReference } from "../../../../core/media/contracts.js";
import {
  createImageInputUnsupportedModelMessage,
  getImageInputMediaTypeForPath,
  getSupportedImageInputExtensions,
  modelSupportsImageInput,
  providerSupportsImageInputMediaType,
} from "../../../../core/model-capabilities.js";
import type { RalphInputValue } from "../../../../core/ralph.js";
import type {
  ReasoningMode,
  RunMode,
} from "../../../../core/runtime-contract.generated.js";
import type {
  AgentModelImageMediaType,
  TaskExecutionProgress,
  TaskExecutionResult,
} from "../../../../core/types.js";
import { scheduleAppNotificationDismiss } from "../../components/ui/notification-lifecycle";
import {
  applySessionRetentionPolicy,
  canDeleteSession,
  canDuplicateSession,
  canPinSession,
  canRenameSession,
  createSession,
  createTaskOutcomeFromExecution,
  createVisibleConversationMessages,
  getActiveChatOperationIds,
  getActivePromptEnhancementEditMessageId,
  getLatestRunningTaskId,
  getSessionTaskOutcome,
  getSessionOverviewStatus,
  getSessionTitle,
  isMediaAssetContextAttachment,
  isPathContextAttachment,
  isQuickVoiceSession,
  isSessionWorkspaceLocked,
  isTransientChatOperationMessage,
  MAX_SMART_CONTEXT_PACKS,
  normalizeSessionTags,
  QUICK_VOICE_SESSION_KIND,
  recoverInactiveRunningTasks,
  rememberRecentWorkspace,
  removeRecentWorkspace,
  trimSessionTaskGroupsToVisibleMessageLimit,
  type ChatSessionContextAttachment,
  type ChatSessionMessage,
  type ChatSessionMessagePromptEnhancement,
  type ChatSessionMessageSettings,
  type ChatSessionPathContextAttachment,
  type ChatSessionQueuedMessage,
  type ChatSessionQueuedPromptEnhancementRequest,
  type ChatSessionRecord,
  type ShellPersistedState,
  type SmartContextPack,
} from "../../chat-session.model";
import {
  beginCrossWindowOperation,
  completeCrossWindowOperation,
  releaseCrossWindowOperation,
} from "../../lib/cross-window-operation";
import {
  DEFAULT_RUNNING_TASK_MESSAGE_ACTION,
  loadRunningTaskMessageAction,
  saveRunningTaskMessageAction,
  type RunningTaskMessageAction,
} from "../../lib/shell-store";
import { readMediaAssetReferencePreview } from "../../media/media-runtime";
import { type RuntimeProvider } from "../../model-catalog";
import {
  runInternalDesktopTask,
  runInternalTaskInterview,
} from "../../internal-task-model";
import {
  DesktopTaskRunProtocolError,
  getDesktopTaskRunFailure,
} from "../../desktop-task-error";
import {
  createDefaultRalphInputValues,
  validateRalphInputFieldValues,
} from "../../ralph/_helpers/validate-ralph-input-field-values.helper";
import { normalizeReasoningModeForProvider } from "../../reasoning-options";
import {
  acknowledgeRecentDesktopTaskResults,
  cancelDesktopTask,
  forgetWorkspaceMemoryEntry,
  listInstructions,
  loadActiveDesktopTaskIds,
  loadActiveDesktopTasks,
  loadRecentDesktopTaskResults,
  loadWorkspaceMemoryEntries,
  openAttachedPath,
  openExternalUrl,
  openWorkspacePath,
  readAttachedFilePreview,
  readWorkspaceFilePreview,
  resolveAttachedFilePreviewSource,
  resolveAttachedImagePreviewSource,
  resolveDroppedPaths,
  resolveWorkspaceFilePreviewSource,
  saveClipboardImageAttachment,
  mutateInstructions,
  syncChatCompletionIndicator,
  type InstructionMutationInput,
  type InstructionMutationResult,
  type InstructionRegistryResult,
  type DesktopTaskRunResponse,
  type FileManagerInvocationRoute,
  type RecentDesktopTaskResult,
  type TaskInterviewResult,
} from "../../runtime";
import { subscribeToSettingsImport } from "../../settings-transfer";
import {
  appendThinkingProgress,
  createInitialThinkingTrace,
} from "../../task-thinking.model";
import { createWorkspaceRootKey } from "../../workspace-management/workspace-management-model";
import type { FilePreviewMode } from "../components/file-preview-dialog";
import type { SettingsStatusMessage } from "../components/settings-dialog-panels/types";
import { clampAiContextMessageLimit } from "./ai-context-window";
import { isChatCompletionIndicatorActive } from "./chat-completion-indicator";
import {
  extractChatInputNeededPlaceholders,
  replaceChatInputNeededPlaceholders,
  type ChatInputNeededPlaceholder,
} from "./chat-input-needed-placeholders";
import {
  getChatOperationRecoveryAction,
  getOrphanedChatOperationIds,
} from "./chat-operation-ownership";
import {
  createLocalTaskInterviewPrompt,
  createTaskInterviewContextNotes,
  getTrimmedTaskInterviewAnswerComments,
  type ChatInterviewDialogState,
  type ChatInterviewStartContext,
} from "./chat-interview";
import {
  createComposerClearGuard,
  createComposerSubmissionSessionSnapshot,
  isComposerClearGuardCurrent,
  type ComposerClearGuard,
} from "./composer-submission";
import {
  getFilePreviewFileName,
  getFilePreviewRenderKind,
  resolveFilePreviewSyntax,
} from "./file-preview-language";
import { getRenderedMessageContent } from "./execution-message.tsx";
import {
  createMessagePromptEnhancement,
  createPromptEnhancementTask,
  createQueuedPromptEnhancementRequest,
  extractEnhancedPrompt,
  isPromptEnhancementCancellation,
  PROMPT_ENHANCEMENT_LABELS,
  PromptEnhancementCancellationError,
  resolveImmediatePromptEnhancementPlacement,
  shouldDeferPromptEnhancementUntilQueuedDispatch,
  type ActivePromptEnhancementMode,
  type PromptEnhancementPendingPlacement,
  type PromptEnhancementMode,
} from "./prompt-enhancement";
import {
  canDispatchQueuedMessage,
  canStartQueuedMessageDispatch,
  createFailedQueuedMessageRecovery,
  createQueuedMessageDispatchAttempt,
  createQueuedMessageRetry,
  isQueuedPromptEnhancementInputCurrent,
} from "./queued-message-lifecycle";
import {
  appendContextAttachmentsToTask,
  appendDraftBlock,
  appendTranscriptToDraft,
  clampQuickVoiceMessageLimit,
  createContextAttachment,
  createContextAttachmentFromMediaAsset,
  createContextAttachmentFromReference,
  getImageAttachmentPaths,
  isLinkContextAttachment,
  mergeContextAttachments,
  normalizeDialogSelection,
  type AttachmentSelectionKind,
  type DialogSelection,
  type FileDropTarget,
} from "./session-context-attachments";
import { normalizeSessionReasoningOverride } from "./session-reasoning";
import {
  applySessionMessageSettings,
  createSessionMessageSettings,
  getSessionMessageSettings,
} from "./session-message-settings";
import {
  createConversationContextFromSession,
  getEffectiveSessionMode,
  removeSessionModeOverride,
  RUN_MODE_META,
} from "./session-shell";
import {
  createMemorySummaryState,
  createProviderChooserState,
} from "./session-shell-view-model";
import {
  createExecutionFromTerminalProgress,
  createExecutionMessageContent,
  formatTaskExecutionError,
  isRecoveredTaskCrashMessage,
} from "./session-task-continuation";
import {
  applySmartContextPackToComposer,
  applySmartContextPackSettingsToComposer,
  applySmartContextPackSettingsToSession,
  applySmartContextPackSettingsToShellDefaults,
  cloneContextAttachmentsForPack,
  createSmartContextPackExportPayload,
  createSmartContextPackVariables,
  doesSmartContextPackMatchComposer,
  extractSmartContextPackVariables,
  filterSmartContextPacksByScope,
  getSmartContextPackModelSelection,
  getSmartContextPacksForWorkspace,
  importSmartContextPacksIntoShellState,
  type SaveSmartContextPackInput,
  type SmartContextPackScope,
  type SmartContextPackScopeFilter,
} from "./smart-context-packs";
import { useChatSessionRuntime } from "./use-chat-session-runtime";
import { useChatSessionShellState } from "./use-chat-session-shell-state";
import { useChatSessionSpeechInput } from "./use-chat-session-speech-input";
import { useChatSessionVoice } from "./use-chat-session-voice";
import {
  useDesktopTaskProgress,
  type DesktopTaskProgressRoute,
} from "./use-desktop-task-progress";
import { useFleetManagedSettings } from "./use-fleet-managed-settings";
import { useFleetControl } from "./use-fleet-control";
import { useSessionComposerState } from "./use-session-composer-state";
import { useSessionFileDrops } from "./use-session-file-drops";
import { useSessionLifecycle } from "./use-session-lifecycle";
import { useSessionSettingsActions } from "./use-session-settings";
import {
  useSessionTaskSubmission,
  type SessionOperationConflictSubmission,
} from "./use-session-task-submission";
import { useSessionWindowControls } from "./use-session-window-controls";
import { useSpeechInputDevices } from "./use-speech-input-devices";

type ChatInputNeededSubmission =
  | {
      kind: "active-session";
      sessionSnapshot: ChatSessionRecord;
      task: string;
      contextAttachments: ChatSessionContextAttachment[];
      runningAction: RunningTaskMessageAction | null;
      composerClearGuard: ComposerClearGuard;
      messageSettings: ChatSessionMessageSettings;
      promptEnhancementMode: PromptEnhancementMode;
      promptEnhancementOriginalContent?: string;
      interviewEnabled: boolean;
      conversationCutoffMessageId?: string;
      preserveQueuedMessagesCreatedAfter?: number;
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
  sessionId: string;
  text: string;
  tone: "success" | "error" | "info" | null;
}

interface MessageEditState {
  messageId: string;
  sourceSessionId: string;
  startedAt: number;
  session: ChatSessionRecord;
  promptEnhancementMode: PromptEnhancementMode;
  interviewEnabled: boolean;
}

const COMPOSER_STATUS_TIMEOUT_MS = 6_000;
const PROMPT_ENHANCEMENT_TASK_ID_PREFIX = "prompt-enhancement-";

interface PromptEnhancementPendingState {
  taskId: string;
  sessionId: string;
  mode: ActivePromptEnhancementMode;
  prompt: string;
  contextAttachments: ChatSessionContextAttachment[];
  placement: PromptEnhancementPendingPlacement;
  startedAt: number;
  ownerLaunchId: string;
  ownerWindowId: string;
  ownerInstanceId: string;
  targetMessageId?: string;
  composerClearGuard?: ComposerClearGuard;
}

interface PromptEnhancementResult {
  task: string;
  taskId: string | null;
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
  const thinkingMessage: ChatSessionMessage = {
    id: `${pending.taskId}-thinking`,
    taskId: pending.taskId,
    role: "agent",
    content: "",
    createdAt: pending.startedAt,
    lifecycle: {
      kind: "transient",
      owner: "prompt-enhancement",
      operationId: pending.taskId,
      slot: pending.placement === "edit-composer" ? "marker" : "thinking",
      ownerLaunchId: pending.ownerLaunchId,
      ownerWindowId: pending.ownerWindowId,
      ownerInstanceId: pending.ownerInstanceId,
      placement: pending.placement,
      ...(pending.targetMessageId
        ? { targetMessageId: pending.targetMessageId }
        : {}),
    },
    source: {
      kind: "thinking",
      thinking: createPromptEnhancementThinkingTrace(pending),
    },
  };

  if (pending.placement === "edit-composer") {
    return [thinkingMessage];
  }

  return [
    {
      id: `${pending.taskId}-user`,
      taskId: pending.taskId,
      role: "user",
      content: pending.prompt,
      createdAt: pending.startedAt,
      lifecycle: {
        kind: "transient",
        owner: "prompt-enhancement",
        operationId: pending.taskId,
        slot: "user",
        ownerLaunchId: pending.ownerLaunchId,
        ownerWindowId: pending.ownerWindowId,
        ownerInstanceId: pending.ownerInstanceId,
        placement: pending.placement,
      },
      ...(contextAttachments.length > 0 ? { contextAttachments } : {}),
    },
    thinkingMessage,
  ];
};

const PROMPT_ENHANCEMENT_WEB_SEARCH_UNAVAILABLE_REASON =
  "Configure an active web search provider in settings before using web-search enhancement.";

const getPromptEnhancementErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
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
    (message) =>
      message.role === "user" && getMessageTaskId(message) === taskId,
  );
};

const compareQueuedMessages = (
  left: ChatSessionQueuedMessage,
  right: ChatSessionQueuedMessage,
): number =>
  left.sessionId.localeCompare(right.sessionId) ||
  left.orderRank - right.orderRank ||
  left.createdAt - right.createdAt ||
  left.id.localeCompare(right.id);

const sortQueuedMessages = (
  messages: ChatSessionQueuedMessage[],
): ChatSessionQueuedMessage[] => [...messages].sort(compareQueuedMessages);

const areQueuedMessageListsIdentical = (
  left: readonly ChatSessionQueuedMessage[],
  right: readonly ChatSessionQueuedMessage[],
): boolean =>
  left.length === right.length &&
  left.every((message, index) => message === right[index]);

const isQueuedMessageInProgress = (
  message: ChatSessionQueuedMessage,
): boolean =>
  message.status === "enhancing" || message.status === "dispatching";

const setQueuedMessageStatus = (
  message: ChatSessionQueuedMessage,
  status: ChatSessionQueuedMessage["status"],
  updatedAt: number,
  failureMessage?: string,
): ChatSessionQueuedMessage => {
  const nextMessage = {
    ...message,
    status,
    statusUpdatedAt: updatedAt,
    updatedAt,
  };

  delete nextMessage.failureMessage;

  return status === "failed" && failureMessage?.trim()
    ? { ...nextMessage, failureMessage: failureMessage.trim() }
    : nextMessage;
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

  const sessionMessages = sortQueuedMessages(
    messages.filter((message) => message.sessionId === movingMessage.sessionId),
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
      attachment: ChatSessionPathContextAttachment;
      workspaceRoot: string | null | undefined;
    }
  | {
      kind: "workspace";
      workspaceRoot: string | null | undefined;
      relativePath: string;
      line?: number;
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
  targetLine: number | null;
}

export interface UseChatSessionControllerOptions {
  enableBackgroundMaintenance?: boolean;
  enableTaskProgress?: boolean;
  includeHistoryContent?: boolean;
  isolateActiveSession?: boolean;
  persistActiveSession?: boolean;
  settingsSurfaceOpen?: boolean;
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
const CHAT_OPERATION_WINDOW_ID_KEY = "machdoch.chat-operation-window-id";

const getOrCreateChatOperationWindowId = (): string => {
  try {
    const existingWindowId = window.sessionStorage
      .getItem(CHAT_OPERATION_WINDOW_ID_KEY)
      ?.trim();

    if (existingWindowId) {
      return existingWindowId;
    }

    const windowId = crypto.randomUUID();
    window.sessionStorage.setItem(CHAT_OPERATION_WINDOW_ID_KEY, windowId);
    return windowId;
  } catch {
    return crypto.randomUUID();
  }
};
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
} satisfies Record<
  TaskExecutionResult["status"],
  TaskExecutionProgress["state"]
>;

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

const saveSupportedClipboardImageFiles = async (
  files: File[],
  provider: RuntimeProvider,
  model: string,
): Promise<string[]> => {
  if (!modelSupportsImageInput(provider, model)) {
    console.error(createImageInputUnsupportedModelMessage(provider, model));
    return [];
  }

  const supportedFiles = files.flatMap((file) => {
    const mediaType = getClipboardImageMediaType(file);

    if (
      !mediaType ||
      !providerSupportsImageInputMediaType(provider, mediaType, model)
    ) {
      console.error(
        `Unsupported pasted image format \`${file.type || file.name || "unknown"}\`. Supported extensions for provider \`${provider}\`: ${getSupportedImageInputExtensions(
          provider,
          model,
        ).join(", ")}.`,
      );
      return [];
    }

    return [{ file, mediaType }];
  });

  return Promise.all(
    supportedFiles.map(({ file, mediaType }) =>
      saveClipboardImageAttachment({
        blob: file,
        mediaType,
        fileName: file.name,
      }),
    ),
  );
};

export const useChatSessionController = (
  options: UseChatSessionControllerOptions = {},
) => {
  const backgroundMaintenanceEnabled =
    options.enableBackgroundMaintenance !== false;
  const state = useChatSessionShellState({
    includeHistoryContent: options.includeHistoryContent,
    isolateActiveSession: options.isolateActiveSession,
    persistActiveSession: options.persistActiveSession,
    trackSessionReads: options.trackSessionReads,
  });
  const settingsSurfaceOpen =
    state.catalogOpen || options.settingsSurfaceOpen === true;
  const shellStateRef = useRef(state.shellState);
  shellStateRef.current = state.shellState;
  const activeSessionIdRef = useRef(state.activeSessionId);
  activeSessionIdRef.current = state.activeSessionId;
  const [chatOperationWindowId] = useState(getOrCreateChatOperationWindowId);
  const [chatOperationInstanceId] = useState(() => crypto.randomUUID());
  const activeDesktopTasksRef = useRef<Map<string, string>>(new Map());
  const unsettledDesktopTasksRef = useRef<Map<string, string>>(new Map());
  const activePromptEnhancementInputsRef = useRef<Map<string, string>>(
    new Map(),
  );
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
  const remoteSessionMessageSubmitRef = useRef<
    (input: {
      sessionId: string;
      prompt: string;
      promptEnhancementMode: PromptEnhancementMode;
      interviewEnabled: boolean;
    }) => boolean
  >(() => false);
  const inactiveDesktopTaskObservationsRef = useRef<
    Map<string, InactiveDesktopTaskObservation>
  >(new Map());
  const inactiveDesktopTaskRecoveryRoutesRef = useRef<
    Map<string, InactiveDesktopTaskRecoveryRoute>
  >(new Map());
  const desktopTaskProgressRoutesRef = useRef<
    Map<string, DesktopTaskProgressRoute>
  >(new Map());
  const recoveredTaskAssistantTextRef = useRef<Map<string, string>>(new Map());
  const finalizedRecoveredTaskIdsRef = useRef<Set<string>>(new Set());
  const recoveredTransientTaskIdsRef = useRef<Set<string>>(new Set());
  const orphanedChatOperationCancellationIdsRef = useRef<Set<string>>(
    new Set(),
  );
  const transientTaskMissingObservationsRef = useRef<
    Map<string, InactiveDesktopTaskObservation>
  >(new Map());
  const activeTaskRouteHydrationSignatureRef = useRef<string | null>(null);
  const [attachmentImagePreview, setAttachmentImagePreview] =
    useState<AttachmentImagePreviewState | null>(null);
  const attachmentImagePreviewObjectUrlRef = useRef<string | null>(null);
  const attachmentImagePreviewRequestRef = useRef(0);
  const [filePreview, setFilePreview] = useState<FilePreviewState | null>(null);
  const [runningTaskMessageAction, setRunningTaskMessageAction] =
    useState<RunningTaskMessageAction>(DEFAULT_RUNNING_TASK_MESSAGE_ACTION);
  const [runningTaskMessageActionLoaded, setRunningTaskMessageActionLoaded] =
    useState(false);
  const [chatInterviewEnabled, setChatInterviewEnabled] = useState(false);
  const [promptEnhancementMode, setPromptEnhancementMode] =
    useState<PromptEnhancementMode>("off");
  const [messageEdit, setMessageEdit] = useState<MessageEditState | null>(null);
  const messageEditRef = useRef<MessageEditState | null>(null);
  messageEditRef.current = messageEdit;
  const closeMessageEdit = useCallback(
    (messageId?: string): void => {
      const current = messageEditRef.current;

      if (!current || (messageId && current.messageId !== messageId)) {
        return;
      }

      invalidateAttachmentMutation(`message-edit:${current.messageId}`);
      setMessageEdit(null);
    },
    [invalidateAttachmentMutation],
  );
  const [promptEnhancementStatus, setPromptEnhancementStatus] =
    useState<ComposerStatusMessage | null>(null);
  const dismissPromptEnhancementStatus = useCallback((): void => {
    setPromptEnhancementStatus(null);
  }, []);
  const [promptEnhancementPendingTasks, setPromptEnhancementPendingTasks] =
    useState<PromptEnhancementPendingState[]>([]);
  const [promptEnhancementPreview, setPromptEnhancementPreview] =
    useState<PromptEnhancementPreviewState | null>(null);
  const [chatInterview, setChatInterview] =
    useState<ChatInterviewDialogState | null>(null);
  const isMessageEditPromptEnhancementPending = Boolean(
    messageEdit &&
    promptEnhancementPendingTasks.some(
      (pending) =>
        pending.sessionId === messageEdit.sourceSessionId &&
        pending.placement === "edit-composer",
    ),
  );
  const activeMessageEdit = isMessageEditPromptEnhancementPending
    ? null
    : messageEdit;
  const activeMessageEditRef = useRef<MessageEditState | null>(null);
  activeMessageEditRef.current = activeMessageEdit;

  useEffect(() => {
    if (!promptEnhancementStatus) {
      return;
    }

    const status = promptEnhancementStatus;
    return scheduleAppNotificationDismiss(() => {
      setPromptEnhancementStatus((current) =>
        current === status ? null : current,
      );
    }, COMPOSER_STATUS_TIMEOUT_MS);
  }, [promptEnhancementStatus]);

  useEffect(
    () => () => {
      attachmentImagePreviewRequestRef.current += 1;
      if (attachmentImagePreviewObjectUrlRef.current) {
        URL.revokeObjectURL(attachmentImagePreviewObjectUrlRef.current);
        attachmentImagePreviewObjectUrlRef.current = null;
      }
    },
    [],
  );
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
        const nextQueuedMessages = sortQueuedMessages(
          updater(prev.queuedSessionMessages),
        );

        if (
          areQueuedMessageListsIdentical(
            nextQueuedMessages,
            prev.queuedSessionMessages,
          )
        ) {
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
  const updateMessageEditSession = useCallback(
    (updater: (session: ChatSessionRecord) => ChatSessionRecord): void => {
      setMessageEdit((current) =>
        current
          ? {
              ...current,
              session: updater(current.session),
            }
          : current,
      );
    },
    [],
  );
  const activeComposerSession = useMemo<ChatSessionRecord>(
    () =>
      activeMessageEdit?.session ?? {
        ...state.activeSession,
        draft: composerState.activeDraft,
        draftContextAttachments: composerState.activeContextAttachments,
      },
    [
      activeMessageEdit,
      composerState.activeContextAttachments,
      composerState.activeDraft,
      state.activeSession,
    ],
  );
  const runtime = useChatSessionRuntime({
    catalogOpen: settingsSurfaceOpen,
    activeSessionProvider: activeComposerSession.provider,
    activeSessionWorkspace: activeComposerSession.workspace,
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

      const currentEdit = activeMessageEditRef.current;

      if (currentEdit?.sourceSessionId === sessionId) {
        updateMessageEditSession((session) => ({
          ...session,
          draft: appendTranscriptToDraft(session.draft, normalizedTranscript),
          updatedAt: Date.now(),
        }));
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
          draftUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [
      composerState.commitHistoryPreview,
      state.activeSession.id,
      state.setDraftValue,
      state.updateSessionById,
      updateMessageEditSession,
    ],
  );
  const speechInput = useChatSessionSpeechInput({
    activeSessionId: state.activeSession.id,
    settings: runtime.userSpeechToTextSettings,
    onTranscript: handleSpeechTranscript,
  });
  const speechInputDevices = useSpeechInputDevices(
    settingsSurfaceOpen && state.settingsSection === "voice",
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
  const instructionRegistrySavingRef = useRef(false);
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
  const workspaceMemoryEnabled =
    activeComposerSession.workspace !== null &&
    (runtime.runtimeSnapshot?.workspaceMemoryEnabled ??
      runtime.userMemorySettings.workspaceDefaultEnabled !== false);
  const memorySummaryState = createMemorySummaryState({
    session: activeComposerSession,
    userMemorySettings: runtime.userMemorySettings,
    workspaceMemoryEntries: runtime.workspaceMemoryEntries,
    workspaceMemoryEnabled,
  });
  const currentSessionTitle = getSessionTitle(state.activeSession);
  const memorySourceSessions = useMemo(
    () =>
      state.shellState.sessions.map((session) => ({
        id: session.id,
        title: getSessionTitle(session),
      })),
    [state.shellState.sessions],
  );
  const activeChatOperationIds = useMemo(() => {
    return state.shellState.sessions.flatMap((session) =>
      getActiveChatOperationIds(session),
    );
  }, [state.shellState.sessions]);
  const hasRunningSession = activeChatOperationIds.length > 0;
  const activeChatOperationIdsSignature = activeChatOperationIds.join("\0");
  const sessionOwnershipSignature = useMemo(
    () =>
      state.shellState.sessions
        .map((session) => session.id)
        .sort()
        .join("\0"),
    [state.shellState.sessions],
  );
  const transientChatOperationIdsSignature = useMemo(() => {
    return state.shellState.sessions
      .flatMap((session) =>
        session.messages.flatMap((message) =>
          isTransientChatOperationMessage(message)
            ? [getMessageTaskId(message)]
            : [],
        ),
      )
      .sort()
      .join("\0");
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
    activeComposerSession.mode,
    runtime.runtimeSnapshot,
  );
  const activeRunModeMeta = RUN_MODE_META[activeRunMode];
  const defaultRunMode = runtime.runtimeSnapshot?.mode ?? "machdoch";
  const effectiveReasoning = runtime.runtimeSnapshot?.reasoning ?? "default";
  const workspaceReasoningProvider =
    runtime.runtimeSnapshot?.provider === "unconfigured"
      ? undefined
      : runtime.runtimeSnapshot?.provider;
  const workspaceReasoningModel = runtime.runtimeSnapshot?.model;
  const normalizedEffectiveReasoning = normalizeReasoningModeForProvider(
    effectiveReasoning,
    activeComposerSession.provider,
    activeComposerSession.model,
  );
  const workspaceDefaultReasoning = normalizeReasoningModeForProvider(
    runtime.runtimeSnapshot?.defaultReasoning ?? effectiveReasoning,
    workspaceReasoningProvider ?? null,
    workspaceReasoningModel,
  );
  const activeSessionReasoningOverride = normalizeSessionReasoningOverride(
    activeComposerSession.reasoning,
    activeComposerSession.provider,
    activeComposerSession.model,
  );
  const activeReasoning =
    activeSessionReasoningOverride ?? normalizedEffectiveReasoning;
  const isUsingWorkspaceDefaultMode = !activeComposerSession.mode;
  const isUsingWorkspaceDefaultReasoning = !activeSessionReasoningOverride;
  const hasActiveWorkspace = activeComposerSession.workspace !== null;
  const workspaceLocked = isSessionWorkspaceLocked(activeComposerSession);
  const workspaceContextPacks = useMemo(
    () =>
      getSmartContextPacksForWorkspace(
        state.shellState.contextPacks,
        activeComposerSession.workspace,
      ),
    [activeComposerSession.workspace, state.shellState.contextPacks],
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

  const handleInstructionSave = useCallback(
    async (
      input: InstructionMutationInput,
    ): Promise<InstructionMutationResult | false> => {
      if (instructionRegistrySavingRef.current) return false;
      instructionRegistrySavingRef.current = true;
      setInstructionRegistrySaving(true);
      setInstructionRegistryMessage(null);

      try {
        const previousWorkspaceRoot =
          input.operation === "workspace-relink" ||
          input.operation === "workspace-remove"
            ? instructionRegistry?.workspaces.find(
                (workspace) => workspace.id === input.workspaceId,
              )?.root
            : undefined;
        if (previousWorkspaceRoot) {
          const { disposeWorkspaceTerminals } =
            await import("../../workspace-management/workspace-terminal-store");
          await disposeWorkspaceTerminals(previousWorkspaceRoot);
        }
        const result = await mutateInstructions(
          state.activeSession.workspace,
          input,
        );
        if (input.operation === "workspace-relink" && previousWorkspaceRoot) {
          state.applyShellState((previous) => ({
            ...previous,
            recentWorkspaces: rememberRecentWorkspace(
              removeRecentWorkspace(
                previous.recentWorkspaces,
                previousWorkspaceRoot,
              ),
              input.root,
            ),
          }));
        }
        await refreshInstructionRegistry();
        return result;
      } catch (error) {
        setInstructionRegistryMessage({
          tone: "error",
          text: getInstructionCommandErrorMessage(
            error,
            "Instruction library could not be updated.",
          ),
        });
        return false;
      } finally {
        instructionRegistrySavingRef.current = false;
        setInstructionRegistrySaving(false);
      }
    },
    [
      instructionRegistry,
      refreshInstructionRegistry,
      state.activeSession.workspace,
      state.applyShellState,
    ],
  );

  const matchedContextPackIds = useMemo(() => {
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
          contextAttachments: activeComposerSession.draftContextAttachments,
        })
      ) {
        matchedIds.push(pack.id);
      }
    }

    return matchedIds;
  }, [
    activeComposerSession.draft,
    activeComposerSession.draftContextAttachments,
    workspaceContextPacks,
  ]);
  const activeSessionImageInputSupported = modelSupportsImageInput(
    activeComposerSession.provider,
    activeComposerSession.model,
  );
  const activeSessionImageAttachmentPaths = getImageAttachmentPaths(
    activeComposerSession.draftContextAttachments,
  );
  const activeSessionImageInputError =
    activeSessionImageAttachmentPaths.length > 0 &&
    !activeSessionImageInputSupported
      ? createImageInputUnsupportedModelMessage(
          activeComposerSession.provider,
          activeComposerSession.model,
        )
      : null;
  const activePromptEnhancementMode =
    activeMessageEdit?.promptEnhancementMode ?? promptEnhancementMode;
  const activeChatInterviewEnabled =
    activeMessageEdit?.interviewEnabled ?? chatInterviewEnabled;
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
    activePromptEnhancementMode === "web-search" &&
    !promptEnhancementWebSearchAvailable
      ? PROMPT_ENHANCEMENT_WEB_SEARCH_UNAVAILABLE_REASON
      : null;
  const activePromptEnhancementPending =
    promptEnhancementPendingTasks.find(
      (pending) => pending.sessionId === state.activeSession.id,
    ) ?? null;
  const activeSessionHasPromptEnhancementPlaceholder =
    state.activeSession.messages.some(
      (message) =>
        isTransientChatOperationMessage(message) &&
        message.lifecycle?.owner === "prompt-enhancement",
    );
  const activeSessionPromptEnhancementBusy =
    activePromptEnhancementPending !== null ||
    activeSessionHasPromptEnhancementPlaceholder;
  const activeSessionSendDisabledReason =
    promptEnhancementUnavailableReason ?? activeSessionImageInputError;
  const canComposeMessage =
    !speechInput.recording &&
    !speechInput.transcribing &&
    !chatInterviewBusy &&
    !promptEnhancementUnavailableReason &&
    !activeSessionImageInputError;
  const canSendMessage =
    Boolean(activeComposerSession.draft.trim()) && canComposeMessage;
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
      ? createImageInputUnsupportedModelMessage(
          quickTaskProvider,
          quickTaskModel,
        )
      : null;
  const quickTaskCanSend =
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
      if (activeMessageEditRef.current) {
        setMessageEdit((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            promptEnhancementMode: mode,
          };
        });
        setPromptEnhancementStatus(null);
        return;
      }

      setPromptEnhancementMode(mode);
      setPromptEnhancementStatus(null);
    },
    [],
  );
  const handleInterviewEnabledChange = useCallback((enabled: boolean): void => {
    if (activeMessageEditRef.current) {
      setMessageEdit((current) =>
        current ? { ...current, interviewEnabled: enabled } : current,
      );
      return;
    }

    setChatInterviewEnabled(enabled);
  }, []);
  const handleSessionMemoryEnabledChange = useCallback(
    (enabled: boolean): void => {
      if (activeMessageEditRef.current) {
        updateMessageEditSession((session) => ({
          ...session,
          sessionMemoryEnabled: enabled,
          updatedAt: Date.now(),
        }));
        return;
      }

      settingsActions.setSessionMemoryEnabled(enabled);
    },
    [settingsActions, updateMessageEditSession],
  );
  const forgetSessionMemory = useCallback(
    (sessionId: string, memoryId: string): void => {
      const updatedAt = Date.now();
      state.updateSessionById(sessionId, (session) => ({
        ...session,
        sessionMemory: session.sessionMemory.filter(
          (entry) => entry.id !== memoryId,
        ),
        updatedAt,
      }));

      if (activeMessageEditRef.current?.sourceSessionId === sessionId) {
        updateMessageEditSession((session) => ({
          ...session,
          sessionMemory: session.sessionMemory.filter(
            (entry) => entry.id !== memoryId,
          ),
          updatedAt,
        }));
      }
    },
    [state.updateSessionById, updateMessageEditSession],
  );
  const forgetManagedWorkspaceMemory = useCallback(
    async (
      workspaceRoot: string,
      memoryId: string,
    ): Promise<Awaited<ReturnType<typeof forgetWorkspaceMemoryEntry>>> => {
      const entries = await forgetWorkspaceMemoryEntry(workspaceRoot, memoryId);
      if (workspaceRoot === state.activeSession.workspace) {
        await runtime.refreshWorkspaceMemoryEntries();
      }
      return entries;
    },
    [runtime.refreshWorkspaceMemoryEntries, state.activeSession.workspace],
  );
  const handleUseGlobalMemoryChange = useCallback(
    (enabled: boolean): void => {
      if (activeMessageEditRef.current) {
        updateMessageEditSession((session) => ({
          ...session,
          useGlobalMemory: enabled,
          updatedAt: Date.now(),
        }));
        return;
      }

      settingsActions.setUseGlobalMemory(enabled);
    },
    [settingsActions, updateMessageEditSession],
  );
  const handleUseWorkspaceMemoryChange = useCallback(
    (enabled: boolean): void => {
      if (activeMessageEditRef.current) {
        updateMessageEditSession((session) => ({
          ...session,
          useWorkspaceMemory: enabled,
          updatedAt: Date.now(),
        }));
        return;
      }

      settingsActions.setUseWorkspaceMemory(enabled);
    },
    [settingsActions, updateMessageEditSession],
  );
  const handleUiControlEnabledChange = useCallback(
    (enabled: boolean): void => {
      if (activeMessageEditRef.current) {
        updateMessageEditSession((session) => ({
          ...session,
          uiControlEnabled: enabled,
          updatedAt: Date.now(),
        }));
        return;
      }

      settingsActions.setUiControlEnabled(enabled);
    },
    [settingsActions, updateMessageEditSession],
  );

  useEffect(() => {
    shellStateRef.current = state.shellState;
    activeSessionIdRef.current = state.activeSessionId;
  }, [state.activeSessionId, state.shellState]);

  const shouldActivateSubmittedSession = useCallback(
    (sessionId: string): boolean => {
      return activeSessionIdRef.current === sessionId;
    },
    [],
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

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToSettingsImport((event) => {
      if (!event.categories.includes("preferences.chat-voice")) {
        return;
      }
      void loadRunningTaskMessageAction()
        .then((action) => {
          if (!disposed) {
            setRunningTaskMessageAction(action);
          }
        })
        .catch((error: unknown) => {
          if (!disposed) {
            console.error("Failed to reload imported chat preferences", error);
          }
        });
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unsubscribe = dispose;
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.error(
            "Failed to subscribe to imported chat preferences",
            error,
          );
        }
      });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const handleSpeechInputAction = (): void => {
    if (!speechInput.browserSupported) {
      return;
    }

    if (
      !speechInput.enabled &&
      !speechInput.recording &&
      !speechInput.transcribing
    ) {
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
      persistence: "durable" | "transient" = "durable",
    ): void => {
      const updateSession =
        persistence === "transient"
          ? state.updateSessionByIdTransient
          : state.updateSessionById;

      updateSession(sessionId, (session) => {
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
    [
      applySessionMessageLimit,
      runtime.runtimeSnapshot,
      state.updateSessionById,
      state.updateSessionByIdTransient,
    ],
  );

  const updateTransientThinkingTrace = useCallback(
    (
      sessionId: string,
      taskId: string,
      updater: (
        trace: ReturnType<typeof createInitialThinkingTrace>,
      ) => ReturnType<typeof createInitialThinkingTrace>,
    ): void => {
      updateThinkingTrace(sessionId, taskId, updater, "transient");
    },
    [updateThinkingTrace],
  );

  const applyCompletedDesktopTaskResult = useCallback(
    (result: RecentDesktopTaskResult): boolean => {
      const taskId = result.id.trim();

      if (!taskId || result.kind !== "chat-run") {
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

          const messagesWithoutRecoveredCrash = session.messages.filter(
            (message) =>
              getMessageTaskId(message) !== taskId ||
              !isRecoveredTaskCrashMessage(message),
          );

          if (result.outcome.status === "failed") {
            const failure = getDesktopTaskRunFailure(result.outcome.failure);
            const failureError = failure
              ? new DesktopTaskRunProtocolError(failure)
              : new Error("Desktop task returned malformed failure state.");
            const outcomeStatus =
              failure?.kind === "cancelled"
                ? "cancelled"
                : failure?.kind === "timed-out"
                  ? "timed-out"
                  : "failed";
            didApplyResult = true;
            return applySessionMessageLimit({
              ...session,
              updatedAt: timestamp,
              messages: [
                ...messagesWithoutRecoveredCrash,
                {
                  id: `${taskId}-agent`,
                  taskId,
                  role: "agent",
                  content: formatTaskExecutionError(failureError),
                  createdAt: timestamp,
                  outcome: {
                    status: outcomeStatus,
                    reason: failureError.message,
                  },
                },
              ],
            });
          }

          const execution = (result.outcome.response as DesktopTaskRunResponse)
            .execution;
          if (!execution) {
            return session;
          }
          didApplyResult = true;
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
                outcome: createTaskOutcomeFromExecution(execution),
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
    [applySessionMessageLimit, state.applyShellState],
  );

  useEffect(() => {
    if (!backgroundMaintenanceEnabled || !state.hasHydrated) {
      return;
    }

    let disposed = false;
    let reconcileInFlight = false;

    const cancelOrphanedChatOperations = async (): Promise<void> => {
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
        for (const taskId of orphanedChatOperationCancellationIdsRef.current) {
          if (!activeTaskIds.has(taskId)) {
            orphanedChatOperationCancellationIdsRef.current.delete(taskId);
          }
        }

        const sessionIds = new Set(
          shellStateRef.current.sessions.map((session) => session.id),
        );
        const orphanedTaskIds = getOrphanedChatOperationIds(
          activeTasks,
          sessionIds,
        ).filter(
          (taskId) =>
            !orphanedChatOperationCancellationIdsRef.current.has(taskId),
        );

        await Promise.all(
          orphanedTaskIds.map(async (taskId) => {
            orphanedChatOperationCancellationIdsRef.current.add(taskId);
            try {
              await cancelDesktopTask(taskId);
            } catch (error) {
              orphanedChatOperationCancellationIdsRef.current.delete(taskId);
              console.error(
                "Failed to cancel chat work owned by a deleted session",
                error,
              );
            }
          }),
        );
      } finally {
        reconcileInFlight = false;
      }
    };

    void cancelOrphanedChatOperations();
    const intervalId = window.setInterval(() => {
      void cancelOrphanedChatOperations();
    }, ACTIVE_DESKTOP_TASK_RECONCILE_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [
    backgroundMaintenanceEnabled,
    sessionOwnershipSignature,
    state.hasHydrated,
  ]);

  useEffect(() => {
    if (!state.hasHydrated) {
      return;
    }

    const hydrationSignature = activeChatOperationIdsSignature;

    if (
      !hydrationSignature ||
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
      const sessionIds = new Set(
        state.shellState.sessions.map((session) => session.id),
      );
      const persistedOperationIds = new Set(activeChatOperationIds);

      for (const task of activeTasks) {
        const taskId = task.id.trim();
        const sessionId = task.sessionId?.trim();

        if (
          !taskId ||
          !sessionId ||
          !sessionIds.has(sessionId) ||
          !persistedOperationIds.has(taskId)
        ) {
          continue;
        }

        activeDesktopTasksRef.current.set(taskId, sessionId);
        if (
          (task.kind === "prompt-enhancement" ||
            task.kind === "task-interview") &&
          !desktopTaskProgressRoutesRef.current.has(taskId)
        ) {
          desktopTaskProgressRoutesRef.current.set(taskId, {});
        }
      }
    });

    return () => {
      cancelled = true;
    };
  }, [
    activeChatOperationIds,
    activeChatOperationIdsSignature,
    state.hasHydrated,
    state.shellState.sessions,
  ]);

  useEffect(() => {
    if (!state.hasHydrated || !transientChatOperationIdsSignature) {
      return;
    }

    let disposed = false;
    let reconcileInFlight = false;

    const reconcileTransientChatOperations = async (): Promise<void> => {
      if (disposed || reconcileInFlight) {
        return;
      }

      reconcileInFlight = true;

      try {
        const activeTasks = await loadActiveDesktopTasks();

        if (disposed || activeTasks === null) {
          return;
        }

        const activeTaskById = new Map(
          activeTasks.map((task) => [task.id.trim(), task] as const),
        );
        const transientOperationById = new Map<
          string,
          {
            taskId: string;
            sessionId: string;
            owner: "prompt-enhancement" | "task-interview";
            ownerLaunchId: string;
            ownerWindowId: string;
            ownerInstanceId: string;
            placement?: NonNullable<
              ChatSessionMessage["lifecycle"]
            >["placement"];
            prompt?: string;
            contextAttachments: ChatSessionContextAttachment[];
          }
        >();
        for (const session of shellStateRef.current.sessions) {
          for (const message of session.messages) {
            if (!isTransientChatOperationMessage(message)) {
              continue;
            }

            const lifecycle = message.lifecycle;
            if (!lifecycle) {
              continue;
            }

            const taskId = getMessageTaskId(message);
            const existing = transientOperationById.get(taskId);
            transientOperationById.set(taskId, {
              taskId,
              sessionId: session.id,
              owner: lifecycle.owner,
              ownerLaunchId: lifecycle.ownerLaunchId,
              ownerWindowId: lifecycle.ownerWindowId,
              ownerInstanceId: lifecycle.ownerInstanceId,
              ...(lifecycle.placement
                ? { placement: lifecycle.placement }
                : {}),
              ...(message.role === "user" && message.content.trim()
                ? { prompt: message.content.trim() }
                : existing?.prompt
                  ? { prompt: existing.prompt }
                  : {}),
              contextAttachments:
                message.role === "user"
                  ? (message.contextAttachments ?? []).map((attachment) => ({
                      ...attachment,
                    }))
                  : (existing?.contextAttachments ?? []),
            });
          }
        }
        const transientOperations = [...transientOperationById.values()];
        const inactiveTaskIds: string[] = [];
        const missingTaskIds: string[] = [];
        const now = Date.now();
        const currentLaunchId =
          shellStateRef.current.lastRecoveredLaunchId ?? "pending-launch";
        const currentOperationOwner = {
          launchId: currentLaunchId,
          windowId: chatOperationWindowId,
          instanceId: chatOperationInstanceId,
        };

        for (const operation of transientOperations) {
          const activeTask = activeTaskById.get(operation.taskId);
          const recoveryAction = getChatOperationRecoveryAction(
            {
              launchId: operation.ownerLaunchId,
              windowId: operation.ownerWindowId,
              instanceId: operation.ownerInstanceId,
            },
            currentOperationOwner,
            Boolean(activeTask),
          );

          if (activeTask) {
            const expectedKind = operation.owner;
            if (
              activeTask.sessionId !== operation.sessionId ||
              activeTask.kind !== expectedKind
            ) {
              void cancelDesktopTask(operation.taskId).catch((error) => {
                console.error(
                  "Failed to cancel incorrectly owned chat operation",
                  error,
                );
              });
              continue;
            }

            if (recoveryAction === "cancel") {
              if (!recoveredTransientTaskIdsRef.current.has(operation.taskId)) {
                void cancelDesktopTask(operation.taskId).catch((error) => {
                  console.error(
                    "Failed to cancel an orphaned chat operation",
                    error,
                  );
                });
              }
              recoveredTransientTaskIdsRef.current.add(operation.taskId);
            }

            activeDesktopTasksRef.current.set(
              operation.taskId,
              operation.sessionId,
            );
            if (!desktopTaskProgressRoutesRef.current.has(operation.taskId)) {
              desktopTaskProgressRoutesRef.current.set(operation.taskId, {});
            }
            transientTaskMissingObservationsRef.current.delete(
              operation.taskId,
            );
            continue;
          }

          if (recoveredTransientTaskIdsRef.current.has(operation.taskId)) {
            inactiveTaskIds.push(operation.taskId);
            continue;
          }

          if (
            recoveryAction === "retain" &&
            activeDesktopTasksRef.current.has(operation.taskId)
          ) {
            continue;
          }

          if (recoveryAction === "reconcile") {
            missingTaskIds.push(operation.taskId);
            inactiveTaskIds.push(operation.taskId);
            continue;
          }

          const previousObservation =
            transientTaskMissingObservationsRef.current.get(operation.taskId);
          missingTaskIds.push(operation.taskId);
          const observation = previousObservation
            ? {
                firstMissingAt: previousObservation.firstMissingAt,
                missCount: previousObservation.missCount + 1,
              }
            : { firstMissingAt: now, missCount: 1 };
          transientTaskMissingObservationsRef.current.set(
            operation.taskId,
            observation,
          );

          if (
            observation.missCount >=
              ACTIVE_DESKTOP_TASK_MISSING_CONFIRMATION_COUNT &&
            now - observation.firstMissingAt >=
              ACTIVE_DESKTOP_TASK_MISSING_GRACE_MS
          ) {
            inactiveTaskIds.push(operation.taskId);
          }
        }

        const completedResults = await loadRecentDesktopTaskResults([
          ...new Set([...inactiveTaskIds, ...missingTaskIds]),
        ]);

        if (disposed) {
          return;
        }

        for (const result of completedResults ?? []) {
          if (!inactiveTaskIds.includes(result.id)) {
            inactiveTaskIds.push(result.id);
          }
        }

        if (inactiveTaskIds.length === 0) {
          return;
        }

        const inactiveTaskIdSet = new Set(inactiveTaskIds);
        for (const taskId of inactiveTaskIds) {
          activeDesktopTasksRef.current.delete(taskId);
          desktopTaskProgressRoutesRef.current.delete(taskId);
          recoveredTransientTaskIdsRef.current.delete(taskId);
          transientTaskMissingObservationsRef.current.delete(taskId);
        }
        state.applyShellState((prev) => {
          let changed = false;
          const sessions = prev.sessions.map((session) => {
            const recoveredPrompt = transientOperations.find(
              (operation) =>
                operation.sessionId === session.id &&
                inactiveTaskIdSet.has(operation.taskId) &&
                operation.placement === "message" &&
                operation.prompt,
            );
            const messages = session.messages.filter((message) => {
              const remove =
                isTransientChatOperationMessage(message) &&
                inactiveTaskIdSet.has(getMessageTaskId(message));
              changed ||= remove;
              return !remove;
            });
            const shouldRestorePrompt = Boolean(
              recoveredPrompt?.prompt && !session.draft.trim(),
            );

            return messages.length === session.messages.length &&
              !shouldRestorePrompt
              ? session
              : applySessionMessageLimit({
                  ...session,
                  messages,
                  ...(shouldRestorePrompt && recoveredPrompt?.prompt
                    ? {
                        draft: recoveredPrompt.prompt,
                        draftContextAttachments: mergeContextAttachments(
                          session.draftContextAttachments,
                          recoveredPrompt.contextAttachments,
                        ),
                        draftUpdatedAt: Date.now(),
                        draftAttachmentsUpdatedAt: Date.now(),
                      }
                    : {}),
                  updatedAt: Date.now(),
                });
          });

          return changed ? { ...prev, sessions } : prev;
        });

        try {
          await state.flushPersistence();
          if (completedResults) {
            await acknowledgeRecentDesktopTaskResults(
              completedResults.map((result) => result.id),
            );
          }
        } catch (error) {
          console.error(
            "Failed to persist reconciled chat helper operations",
            error,
          );
        }
      } finally {
        reconcileInFlight = false;
      }
    };

    void reconcileTransientChatOperations();
    const intervalId = window.setInterval(() => {
      void reconcileTransientChatOperations();
    }, ACTIVE_DESKTOP_TASK_RECONCILE_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(intervalId);
    };
  }, [
    applySessionMessageLimit,
    chatOperationInstanceId,
    chatOperationWindowId,
    state.applyShellState,
    state.flushPersistence,
    state.hasHydrated,
    transientChatOperationIdsSignature,
  ]);

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

        if (completedResultTaskIds.size > 0) {
          try {
            await state.flushPersistence();
            await acknowledgeRecentDesktopTaskResults([
              ...completedResultTaskIds,
            ]);
          } catch (error) {
            console.error(
              "Failed to acknowledge recovered desktop task results",
              error,
            );
          }
        }

        const now = Date.now();
        const confirmedInactiveTaskIds: string[] = [];

        for (const taskId of currentInactiveRunningTaskIds) {
          if (
            activeTaskIdSet.has(taskId) ||
            completedResultTaskIds.has(taskId)
          ) {
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
          const observation: InactiveDesktopTaskObservation =
            previousObservation
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
              outcome: createTaskOutcomeFromExecution(execution),
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
    enabled: options.enableTaskProgress,
    activeDesktopTasksRef,
    ignoredDesktopTaskIdsRef,
    onUnhandledProgress: handleUnhandledDesktopTaskProgress,
    progressRoutesRef: desktopTaskProgressRoutesRef,
    resolveSessionIdForTask: resolveSessionIdForDesktopTask,
    updateThinkingTrace: updateTransientThinkingTrace,
  });

  useEffect(() => {
    if (
      !backgroundMaintenanceEnabled ||
      !state.hasHydrated ||
      !runtime.userDesktopSettingsLoaded
    ) {
      return;
    }

    const applyRetentionPolicy = (): void => {
      const currentShellState = shellStateRef.current;
      const nextShellState = applySessionRetentionPolicy(currentShellState, {
        inactiveSessionArchiveDays:
          runtime.userDesktopSettings.inactiveSessionArchiveDays,
        archivedSessionRetentionDays:
          runtime.userDesktopSettings.archivedSessionRetentionDays,
      });

      if (nextShellState !== currentShellState) {
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
    backgroundMaintenanceEnabled,
    runtime.userDesktopSettings.inactiveSessionArchiveDays,
    runtime.userDesktopSettings.archivedSessionRetentionDays,
    runtime.userDesktopSettingsLoaded,
    state.applyShellState,
    state.hasHydrated,
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

      if (activeMessageEditRef.current) {
        updateMessageEditSession((session) =>
          isSessionWorkspaceLocked(session)
            ? session
            : {
                ...session,
                workspace: normalizedWorkspace,
                updatedAt: Date.now(),
              },
        );
        return;
      }

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
            ? rememberRecentWorkspace(
                prev.recentWorkspaces,
                normalizedWorkspace,
              )
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
    [state.activeSessionId, state.applyShellState, updateMessageEditSession],
  );

  const applyRemoteWorkspaceSelection = useCallback(
    (sessionId: string, workspace: string | null): void => {
      const normalizedWorkspace = workspace?.trim() || null;
      state.applyShellState((previous) => {
        const session = previous.sessions.find(
          (entry) => entry.id === sessionId,
        );
        if (!session || isSessionWorkspaceLocked(session)) {
          return previous;
        }
        return {
          ...previous,
          recentWorkspaces: normalizedWorkspace
            ? rememberRecentWorkspace(
                previous.recentWorkspaces,
                normalizedWorkspace,
              )
            : previous.recentWorkspaces,
          sessions: previous.sessions.map((entry) =>
            entry.id === sessionId
              ? {
                  ...entry,
                  workspace: normalizedWorkspace,
                  updatedAt: Date.now(),
                }
              : entry,
          ),
        };
      });
    },
    [state.applyShellState],
  );

  const removeWorkspaceFromHistory = useCallback(
    async (workspace: string): Promise<void> => {
      try {
        const { disposeWorkspaceTerminals } =
          await import("../../workspace-management/workspace-terminal-store");
        await disposeWorkspaceTerminals(workspace);
      } catch (error) {
        console.error("Failed to stop workspace terminals", error);
        window.alert(
          "The workspace could not be removed because its terminals could not be stopped. Try again.",
        );
        return;
      }
      state.applyShellState((prev) => ({
        ...prev,
        recentWorkspaces: removeRecentWorkspace(
          prev.recentWorkspaces,
          workspace,
        ),
      }));
    },
    [state.applyShellState],
  );

  const addWorkspaceToHistory = useCallback(
    (workspace: string): void => {
      state.applyShellState((prev) => ({
        ...prev,
        recentWorkspaces: rememberRecentWorkspace(
          prev.recentWorkspaces,
          workspace,
        ),
      }));
    },
    [state.applyShellState],
  );

  const relinkWorkspaceInHistory = useCallback(
    async (currentWorkspace: string, nextWorkspace: string): Promise<void> => {
      try {
        const { disposeWorkspaceTerminals } =
          await import("../../workspace-management/workspace-terminal-store");
        await disposeWorkspaceTerminals(currentWorkspace);
      } catch (error) {
        console.error(
          "Failed to stop terminals for the relinked workspace",
          error,
        );
        window.alert(
          "The workspace could not be relinked because its terminals could not be stopped. Try again.",
        );
        return;
      }
      state.applyShellState((prev) => ({
        ...prev,
        recentWorkspaces: rememberRecentWorkspace(
          removeRecentWorkspace(prev.recentWorkspaces, currentWorkspace),
          nextWorkspace,
        ),
      }));
    },
    [state.applyShellState],
  );

  const handleSelectFolder = async (): Promise<void> => {
    if (isSessionWorkspaceLocked(activeComposerSession)) {
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
    if (activeMessageEditRef.current) {
      updateMessageEditSession((session) => {
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
      });
      return;
    }

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
    if (activeMessageEditRef.current) {
      updateMessageEditSession((session) => {
        const nextSession: ChatSessionRecord = {
          ...session,
          updatedAt: Date.now(),
        };

        if (mode) {
          nextSession.mode = mode;
        } else {
          delete nextSession.mode;
        }

        return nextSession;
      });
      return;
    }

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
    const currentEdit = activeMessageEditRef.current;

    if (currentEdit) {
      updateMessageEditSession((session) => {
        const normalizedReasoning = normalizeSessionReasoningOverride(
          reasoning,
          session.provider,
          session.model,
        );
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
      return;
    }

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

  const createFilePreviewState = (
    target: FilePreviewTarget,
  ): FilePreviewState => {
    const path =
      target.kind === "attachment"
        ? target.attachment.path
        : target.relativePath;
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
      targetLine: target.kind === "workspace" ? (target.line ?? null) : null,
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
          error instanceof Error
            ? error.message
            : "Failed to read file preview.";

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

  const handleOpenWorkspaceFile = (
    relativePath: string,
    line?: number,
  ): void => {
    showFilePreview({
      kind: "workspace",
      workspaceRoot: state.activeSession.workspace,
      relativePath,
      line,
    });
  };

  const handleOpenQuickTaskWorkspaceFile = (
    relativePath: string,
    line?: number,
  ): void => {
    showFilePreview({
      kind: "workspace",
      workspaceRoot:
        quickTaskSession?.workspace ?? state.activeSession.workspace,
      relativePath,
      line,
    });
  };

  const handleOpenAttachment = (
    attachment: ChatSessionContextAttachment,
    workspaceRoot = state.activeSession.workspace,
  ): void => {
    if (isMediaAssetContextAttachment(attachment)) {
      setFilePreview(null);
      if (attachment.kind !== "image") {
        return;
      }
      const previewRequest = ++attachmentImagePreviewRequestRef.current;
      setAttachmentImagePreview({
        attachment,
        source: null,
        loading: true,
        error: null,
      });
      void readMediaAssetReferencePreview(attachment.assetId, 1_024)
        .then((blob) => {
          const source = URL.createObjectURL(blob);
          if (attachmentImagePreviewRequestRef.current !== previewRequest) {
            URL.revokeObjectURL(source);
            return;
          }
          if (attachmentImagePreviewObjectUrlRef.current) {
            URL.revokeObjectURL(attachmentImagePreviewObjectUrlRef.current);
          }
          attachmentImagePreviewObjectUrlRef.current = source;
          setAttachmentImagePreview((current) =>
            current &&
            current.attachment.id === attachment.id &&
            isMediaAssetContextAttachment(current.attachment) &&
            current.attachment.assetId === attachment.assetId
              ? { ...current, source, loading: false, error: null }
              : current,
          );
        })
        .catch((error) => {
          if (attachmentImagePreviewRequestRef.current !== previewRequest) {
            return;
          }
          const message =
            error instanceof Error
              ? error.message
              : "Failed to resolve Media Studio image preview.";
          setAttachmentImagePreview((current) =>
            current?.attachment.id === attachment.id
              ? { ...current, source: null, loading: false, error: message }
              : current,
          );
        });
      return;
    }
    if (attachment.kind === "image") {
      setFilePreview(null);
      setAttachmentImagePreview({
        attachment,
        source: null,
        loading: true,
        error: null,
      });

      void resolveAttachedImagePreviewSource(attachment.path, workspaceRoot)
        .then((source) => {
          setAttachmentImagePreview((current) => {
            if (
              !current ||
              current.attachment.id !== attachment.id ||
              !isPathContextAttachment(current.attachment) ||
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
              !isPathContextAttachment(current.attachment) ||
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
    attachmentImagePreviewRequestRef.current += 1;
    if (attachmentImagePreviewObjectUrlRef.current) {
      URL.revokeObjectURL(attachmentImagePreviewObjectUrlRef.current);
      attachmentImagePreviewObjectUrlRef.current = null;
    }
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

  const getActiveDesktopTaskIdForSession = useCallback(
    (sessionId: string): string | null => {
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
    },
    [],
  );

  const getUnsettledDesktopTaskIdForSession = useCallback(
    (sessionId: string): string | null => {
      for (const [
        taskId,
        activeSessionId,
      ] of unsettledDesktopTasksRef.current.entries()) {
        if (activeSessionId === sessionId) {
          return taskId;
        }
      }

      return null;
    },
    [],
  );

  const requestTaskCancellation = useCallback(
    (session: ChatSessionRecord): void => {
      const pendingPromptEnhancement =
        promptEnhancementPendingTasks.find(
          (pending) => pending.sessionId === session.id,
        ) ?? null;
      const targetTaskIds = new Set(
        pendingPromptEnhancement
          ? [pendingPromptEnhancement.taskId]
          : [
              ...[...activeDesktopTasksRef.current.entries()].flatMap(
                ([taskId, activeSessionId]) =>
                  activeSessionId === session.id ? [taskId] : [],
              ),
              ...session.messages.flatMap((message) =>
                isTransientChatOperationMessage(message) &&
                message.lifecycle?.owner === "prompt-enhancement"
                  ? [getMessageTaskId(message)]
                  : [],
              ),
            ],
      );
      const latestRunningTaskId = getLatestRunningTaskId(session);
      if (latestRunningTaskId) {
        targetTaskIds.add(latestRunningTaskId);
      }

      if (targetTaskIds.size === 0) {
        return;
      }

      if (pendingPromptEnhancement) {
        const targetTaskId = pendingPromptEnhancement.taskId;
        ignoredDesktopTaskIdsRef.current.add(targetTaskId);
        setPromptEnhancementStatus(null);
      } else {
        for (const targetTaskId of targetTaskIds) {
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
      }

      for (const targetTaskId of targetTaskIds) {
        void cancelDesktopTask(targetTaskId).catch((error) => {
          console.error("Failed to cancel desktop task:", error);
        });
      }
    },
    [promptEnhancementPendingTasks, updateThinkingTrace],
  );

  const handleCancel = (): void => {
    requestTaskCancellation(state.activeSession);
  };

  const handleCancelMessageEdit = useCallback(
    (messageId: string): void => {
      const currentEdit = messageEditRef.current;

      if (!currentEdit || currentEdit.messageId !== messageId) {
        return;
      }

      if (
        promptEnhancementPendingTasks.some(
          (pending) => pending.sessionId === currentEdit.sourceSessionId,
        )
      ) {
        requestTaskCancellation(currentEdit.session);
      }

      setChatInputNeeded((current) =>
        current?.submission.kind === "active-session" &&
        current.submission.conversationCutoffMessageId === messageId
          ? null
          : current,
      );
      closeMessageEdit(messageId);
    },
    [closeMessageEdit, promptEnhancementPendingTasks, requestTaskCancellation],
  );

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
          ...(state.activeSession.mode
            ? { mode: state.activeSession.mode }
            : {}),
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
          draftUpdatedAt: updatedAt,
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
          draftAttachmentsUpdatedAt: updatedAt,
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
        messageEditId?: string;
      } = {},
    ): Promise<void> => {
      const currentMessageEdit =
        target === "active-session" ? activeMessageEditRef.current : null;
      const targetMessageEdit =
        options.messageEditId === undefined ||
        currentMessageEdit?.messageId === options.messageEditId
          ? currentMessageEdit
          : null;

      if (options.messageEditId && !targetMessageEdit) {
        return;
      }

      if (target === "active-session" && !targetMessageEdit) {
        composerState.commitHistoryPreview();
      }

      const targetSessionId =
        target === "active-session"
          ? (options.targetSessionId ??
            targetMessageEdit?.sourceSessionId ??
            activeSessionIdRef.current)
          : null;
      const attachmentMutationKey =
        target === "quick-task"
          ? "quick-task"
          : targetMessageEdit
            ? `message-edit:${targetMessageEdit.messageId}`
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
        (attachmentMutationVersionsRef.current.get(attachmentMutationKey) ??
          0) !== attachmentMutationVersion
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

      if (targetMessageEdit) {
        setMessageEdit((current) => {
          if (current?.messageId !== targetMessageEdit.messageId) {
            return current;
          }

          const updatedAt = Date.now();
          const nextSession: ChatSessionRecord = {
            ...current.session,
            draftContextAttachments: mergeContextAttachments(
              current.session.draftContextAttachments,
              attachments,
            ),
            updatedAt,
          };

          if (
            shouldUpdateWorkspaceRoot &&
            resolution.workspaceRoot &&
            !isSessionWorkspaceLocked(nextSession)
          ) {
            nextSession.workspace = resolution.workspaceRoot;
          }

          return {
            ...current,
            session: nextSession,
          };
        });
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
          draftAttachmentsUpdatedAt: updatedAt,
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

  const applyFileManagerInvocationRoute = useCallback(
    async (route: FileManagerInvocationRoute): Promise<void> => {
      const previousSessionId = activeSessionIdRef.current;
      closeMessageEdit();
      composerState.resetDraftHistoryState();
      invalidateAttachmentMutation(`session:${previousSessionId}`);
      const sessionId = lifecycleActions.createNewSession({
        workspace: route.workspaceRoot,
      });

      if (route.attachmentPaths.length > 0) {
        await handleAttachPaths(route.attachmentPaths, "active-session", {
          targetSessionId: sessionId,
          updateWorkspaceRoot: false,
        });
      }
    },
    [
      closeMessageEdit,
      composerState.resetDraftHistoryState,
      handleAttachPaths,
      invalidateAttachmentMutation,
      lifecycleActions,
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

      if (activeMessageEditRef.current) {
        updateMessageEditSession((session) => ({
          ...session,
          draftContextAttachments: mergeContextAttachments(
            session.draftContextAttachments,
            attachments,
          ),
          updatedAt: Date.now(),
        }));
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
          draftAttachmentsUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [
      composerState.commitHistoryPreview,
      state.updateActiveSession,
      updateMessageEditSession,
    ],
  );

  const attachMediaAssetToChat = useCallback(
    (reference: MediaAssetReference): boolean => {
      const currentEdit = activeMessageEditRef.current;
      const activeWorkspace =
        (
          currentEdit?.session.workspace ?? state.activeSession.workspace
        )?.trim() ?? "";
      if (
        !activeWorkspace ||
        reference.workspaceRoot.trim() !== activeWorkspace ||
        reference.kind !== "image"
      ) {
        return false;
      }
      const attachment = createContextAttachmentFromMediaAsset(reference);

      if (currentEdit) {
        updateMessageEditSession((session) => ({
          ...session,
          draftContextAttachments: mergeContextAttachments(
            session.draftContextAttachments,
            [attachment],
          ),
          updatedAt: Date.now(),
        }));
        return true;
      }

      composerState.commitHistoryPreview();
      state.updateActiveSession((session) => {
        const updatedAt = Date.now();
        return {
          ...session,
          draftContextAttachments: mergeContextAttachments(
            session.draftContextAttachments,
            [attachment],
          ),
          draftAttachmentsUpdatedAt: updatedAt,
          updatedAt,
        };
      });
      return true;
    },
    [
      composerState.commitHistoryPreview,
      state.activeSession.workspace,
      state.updateActiveSession,
      updateMessageEditSession,
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

      if (activeMessageEditRef.current) {
        updateMessageEditSession((session) => ({
          ...session,
          draft: appendDraftBlock(session.draft, normalizedText),
          updatedAt: Date.now(),
        }));
        return;
      }

      composerState.commitHistoryPreview();
      state.setDraftValue((currentDraft) =>
        appendDraftBlock(currentDraft, normalizedText),
      );
    },
    [
      composerState.commitHistoryPreview,
      state.setDraftValue,
      updateMessageEditSession,
    ],
  );

  const handleSelectAttachments = useCallback(
    async (
      target: FileDropTarget,
      selectionKind: AttachmentSelectionKind,
    ): Promise<void> => {
      const targetMessageEdit =
        target === "active-session" ? activeMessageEditRef.current : null;

      if (target === "active-session" && !targetMessageEdit) {
        composerState.commitHistoryPreview();
      }

      const targetSessionId =
        target === "active-session"
          ? (targetMessageEdit?.sourceSessionId ?? activeSessionIdRef.current)
          : undefined;
      const attachmentMutationKey =
        target === "quick-task"
          ? "quick-task"
          : targetMessageEdit
            ? `message-edit:${targetMessageEdit.messageId}`
            : `session:${targetSessionId ?? "missing"}`;
      const attachmentMutationVersion =
        attachmentMutationVersionsRef.current.get(attachmentMutationKey) ?? 0;
      const targetProvider =
        target === "quick-task"
          ? quickTaskProvider
          : (targetMessageEdit?.session.provider ??
            state.activeSession.provider);
      const targetModel =
        target === "quick-task"
          ? quickTaskModel
          : (targetMessageEdit?.session.model ?? state.activeSession.model);

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
          {
            targetSessionId,
            attachmentMutationVersion,
            ...(targetMessageEdit
              ? { messageEditId: targetMessageEdit.messageId }
              : {}),
          },
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
                      targetModel,
                    ),
                  },
                ],
              }
            : {}),
        })) as DialogSelection;

        await handleAttachPaths(normalizeDialogSelection(selected), target, {
          targetSessionId,
          attachmentMutationVersion,
          ...(targetMessageEdit
            ? { messageEditId: targetMessageEdit.messageId }
            : {}),
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
      const targetMessageEdit =
        target === "active-session" ? activeMessageEditRef.current : null;

      if (target === "active-session" && !targetMessageEdit) {
        composerState.commitHistoryPreview();
      }

      const targetSessionId =
        target === "active-session"
          ? (targetMessageEdit?.sourceSessionId ?? activeSessionIdRef.current)
          : undefined;
      const attachmentMutationKey =
        target === "quick-task"
          ? "quick-task"
          : targetMessageEdit
            ? `message-edit:${targetMessageEdit.messageId}`
            : `session:${targetSessionId ?? "missing"}`;
      const attachmentMutationVersion =
        attachmentMutationVersionsRef.current.get(attachmentMutationKey) ?? 0;
      const targetProvider =
        target === "quick-task"
          ? quickTaskProvider
          : (targetMessageEdit?.session.provider ??
            state.activeSession.provider);
      const targetModel =
        target === "quick-task"
          ? quickTaskModel
          : (targetMessageEdit?.session.model ?? state.activeSession.model);

      const paths = await saveSupportedClipboardImageFiles(
        files,
        targetProvider,
        targetModel,
      );

      if (paths.length === 0) {
        return;
      }

      await handleAttachPaths(paths, target, {
        updateWorkspaceRoot: false,
        targetSessionId,
        attachmentMutationVersion,
        ...(targetMessageEdit
          ? { messageEditId: targetMessageEdit.messageId }
          : {}),
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
      const promptEnhancementMode = input.promptEnhancementMode;
      const interviewEnabled = input.interviewEnabled;
      const sessionMemoryEnabled = input.sessionMemoryEnabled;
      const useGlobalMemory = input.useGlobalMemory;
      const uiControlEnabled = input.uiControlEnabled;
      const hasOptionalSettingOverride =
        promptEnhancementMode !== undefined ||
        interviewEnabled !== undefined ||
        sessionMemoryEnabled !== undefined ||
        useGlobalMemory !== undefined ||
        uiControlEnabled !== undefined;

      if (
        !instructions &&
        !prompt &&
        contextAttachments.length === 0 &&
        !provider &&
        !mode &&
        !reasoning &&
        !hasOptionalSettingOverride
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
            input.scope === "global" ? null : activeComposerSession.workspace,
          name,
          instructions,
          prompt,
          contextAttachments,
          variables: createSmartContextPackVariables(input.variables ?? []),
          trigger: {
            phrases: input.triggerPhrases ?? [],
            pathPatterns: input.triggerPathPatterns ?? [],
          },
          ...(provider ? { provider } : {}),
          ...(provider && model ? { model } : {}),
          ...(mode ? { mode } : {}),
          ...(reasoning ? { reasoning } : {}),
          ...(promptEnhancementMode !== undefined
            ? { promptEnhancementMode }
            : {}),
          ...(interviewEnabled !== undefined ? { interviewEnabled } : {}),
          ...(sessionMemoryEnabled !== undefined
            ? { sessionMemoryEnabled }
            : {}),
          ...(useGlobalMemory !== undefined ? { useGlobalMemory } : {}),
          ...(uiControlEnabled !== undefined ? { uiControlEnabled } : {}),
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
    [activeComposerSession.workspace, state.applyShellState],
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

      const targetMessageEdit = activeMessageEditRef.current;

      if (!targetMessageEdit) {
        composerState.commitHistoryPreview();
      }

      const targetSessionId =
        targetMessageEdit?.sourceSessionId ?? state.activeSession.id;
      const targetUserMessageSignature = JSON.stringify(
        (targetMessageEdit?.session.messages ?? state.activeSession.messages)
          .filter((message) => message.role === "user")
          .map((message) => message.id),
      );
      const packRevisionSignature = JSON.stringify(pack);
      let contextAttachments = pack.contextAttachments;

      if (pack.contextAttachments.length > 0) {
        try {
          const mediaAttachments = pack.contextAttachments.filter(
            isMediaAssetContextAttachment,
          );
          const pathAttachments = pack.contextAttachments.filter(
            isPathContextAttachment,
          );
          const resolution = await resolveDroppedPaths(
            pathAttachments.map((attachment) => attachment.path),
          );
          contextAttachments = [
            ...mediaAttachments,
            ...resolution.entries.map(createContextAttachment),
          ];
        } catch (error) {
          console.error("Failed to revalidate context pack paths", error);
        }
      }

      const packForApplication: SmartContextPack = {
        ...pack,
        contextAttachments,
      };
      const savedModelSelection = getSmartContextPackModelSelection(
        pack,
        providerChooserState.chooserProviders,
      );

      if (targetMessageEdit) {
        setMessageEdit((current) => {
          if (current?.messageId !== targetMessageEdit.messageId) {
            return current;
          }

          const application = applySmartContextPackToComposer(
            current.session.draft,
            current.session.draftContextAttachments,
            packForApplication,
            variableValues,
          );
          const now = Date.now();
          const nextSession = applySmartContextPackSettingsToSession(
            {
              ...current.session,
              draft: application.draft,
              draftContextAttachments: application.contextAttachments,
              updatedAt: now,
            },
            pack,
            savedModelSelection,
          );
          const nextComposerSettings = applySmartContextPackSettingsToComposer(
            {
              promptEnhancementMode: current.promptEnhancementMode,
              interviewEnabled: current.interviewEnabled,
            },
            pack,
          );

          return {
            ...current,
            ...nextComposerSettings,
            session: nextSession,
          };
        });
        state.applyShellState((prev) => {
          const currentPack = prev.contextPacks.find(
            (contextPack) => contextPack.id === pack.id,
          );

          if (
            !currentPack ||
            JSON.stringify(currentPack) !== packRevisionSignature
          ) {
            return prev;
          }

          const now = Date.now();

          return {
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
          };
        });
        return;
      }

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
            return applySmartContextPackSettingsToSession(
              {
                ...session,
                draft: application.draft,
                draftContextAttachments: application.contextAttachments,
                draftUpdatedAt: now,
                draftAttachmentsUpdatedAt: now,
                updatedAt: now,
              },
              pack,
              savedModelSelection,
            );
          }),
        };

        return applySmartContextPackSettingsToShellDefaults(
          nextState,
          pack,
          savedModelSelection,
        );
      });

      if (didApplyPack && activeSessionIdRef.current === targetSessionId) {
        const nextComposerSettings = applySmartContextPackSettingsToComposer(
          {
            promptEnhancementMode,
            interviewEnabled: chatInterviewEnabled,
          },
          pack,
        );

        setPromptEnhancementMode(nextComposerSettings.promptEnhancementMode);
        setChatInterviewEnabled(nextComposerSettings.interviewEnabled);
        composerState.resetDraftHistoryState();
      }
    },
    [
      composerState.commitHistoryPreview,
      composerState.resetDraftHistoryState,
      chatInterviewEnabled,
      promptEnhancementMode,
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
      const scopeSuffix = scopeFilter === "all" ? "" : `-${scopeFilter}`;

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
      if (scope === "workspace" && !activeComposerSession.workspace) {
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
              activeComposerSession.workspace,
              scope,
            ),
          );
        })
        .catch((error) => {
          console.error("Failed to import context packs:", error);
        });
    },
    [activeComposerSession.workspace, state.applyShellState],
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

      const contextAttachments = message.contextAttachments ?? [];
      const name =
        prompt.replace(/\s+/gu, " ").slice(0, 48).trim() || "Context pack";
      const messageSettings = message.settings;

      handleSaveContextPack({
        name,
        scope: state.activeSession.workspace ? "workspace" : "global",
        instructions: "",
        prompt,
        contextAttachments,
        variables: extractSmartContextPackVariables(prompt),
        triggerPhrases: [],
        triggerPathPatterns: [],
        provider: messageSettings?.provider ?? state.activeSession.provider,
        model: messageSettings?.model ?? state.activeSession.model,
        mode: messageSettings?.mode ?? activeRunMode,
        reasoning: messageSettings?.reasoning ?? activeReasoning,
        promptEnhancementMode:
          messageSettings?.promptEnhancementMode ?? promptEnhancementMode,
        interviewEnabled:
          messageSettings?.interviewEnabled ?? chatInterviewEnabled,
        sessionMemoryEnabled:
          messageSettings?.sessionMemoryEnabled ??
          state.activeSession.sessionMemoryEnabled,
        useGlobalMemory:
          messageSettings?.useGlobalMemory ??
          state.activeSession.useGlobalMemory,
        uiControlEnabled:
          messageSettings?.uiControlEnabled ??
          state.activeSession.uiControlEnabled,
      });
    },
    [
      activeReasoning,
      activeRunMode,
      chatInterviewEnabled,
      handleSaveContextPack,
      promptEnhancementMode,
      state.activeSession.model,
      state.activeSession.provider,
      state.activeSession.sessionMemoryEnabled,
      state.activeSession.uiControlEnabled,
      state.activeSession.useGlobalMemory,
      state.activeSession.workspace,
    ],
  );

  const handleStartMessageEdit = useCallback(
    (message: ChatSessionMessage): void => {
      if (message.role !== "user" || message.taskAction) {
        return;
      }

      const sourceSession = shellStateRef.current.sessions.find((session) =>
        session.messages.some((entry) => entry.id === message.id),
      );

      if (
        !sourceSession ||
        getSessionOverviewStatus(sourceSession) === "running" ||
        promptEnhancementPendingTasks.some(
          (pending) => pending.sessionId === sourceSession.id,
        )
      ) {
        return;
      }

      const settings = getSessionMessageSettings(message, sourceSession);
      const content =
        settings.promptEnhancementMode !== "off"
          ? (message.promptEnhancement?.originalContent ??
            getRenderedMessageContent(message))
          : getRenderedMessageContent(message);

      if (!content.trim()) {
        return;
      }

      const contextAttachments = (message.contextAttachments ?? []).map(
        (attachment) => ({ ...attachment }),
      );
      const sessionWithSettings = applySessionMessageSettings(
        sourceSession,
        settings,
      );
      const currentEdit = activeMessageEditRef.current;

      if (currentEdit) {
        invalidateAttachmentMutation(`message-edit:${currentEdit.messageId}`);
      }

      setMessageEdit({
        messageId: message.id,
        sourceSessionId: sourceSession.id,
        startedAt: Date.now(),
        session: {
          ...sessionWithSettings,
          draft: content,
          draftContextAttachments: contextAttachments,
        },
        promptEnhancementMode: settings.promptEnhancementMode,
        interviewEnabled: settings.interviewEnabled,
      });
    },
    [invalidateAttachmentMutation, promptEnhancementPendingTasks],
  );

  useEffect(() => {
    if (!messageEdit) {
      return;
    }

    const sourceSession = state.shellState.sessions.find(
      (session) => session.id === messageEdit.sourceSessionId,
    );

    if (
      state.activeSession.id !== messageEdit.sourceSessionId ||
      !sourceSession?.messages.some(
        (message) => message.id === messageEdit.messageId,
      )
    ) {
      closeMessageEdit(messageEdit.messageId);
    }
  }, [
    closeMessageEdit,
    messageEdit,
    state.activeSession.id,
    state.shellState.sessions,
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

      const currentEdit = activeMessageEditRef.current;

      if (currentEdit) {
        const mutationKey = `message-edit:${currentEdit.messageId}`;
        attachmentMutationVersionsRef.current.set(
          mutationKey,
          (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
        );
        updateMessageEditSession((session) => ({
          ...session,
          draftContextAttachments: session.draftContextAttachments.filter(
            (attachment) => attachment.id !== attachmentId,
          ),
          updatedAt: Date.now(),
        }));
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
          draftAttachmentsUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [
      composerState.commitHistoryPreview,
      state.updateSessionById,
      updateMessageEditSession,
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

      const currentEdit = activeMessageEditRef.current;

      if (currentEdit) {
        const mutationKey = `message-edit:${currentEdit.messageId}`;
        attachmentMutationVersionsRef.current.set(
          mutationKey,
          (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
        );
        updateMessageEditSession((session) => ({
          ...session,
          draftContextAttachments: [],
          updatedAt: Date.now(),
        }));
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
          draftAttachmentsUpdatedAt: updatedAt,
          updatedAt,
        };
      });
    },
    [
      composerState.commitHistoryPreview,
      state.updateSessionById,
      updateMessageEditSession,
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
          draftUpdatedAt: updatedAt,
          draftAttachmentsUpdatedAt: updatedAt,
          updatedAt,
        };

        clearedComposer = createComposerClearGuard(nextSession);
        return nextSession;
      });

      if (clearedComposer) {
        const clearedSession = state.getSessionById(sessionId);

        if (clearedSession) {
          clearedComposer = createComposerClearGuard(clearedSession);
        }
        invalidateAttachmentMutation(`session:${sessionId}`);
      }

      return clearedComposer;
    },
    [
      composerState.resetDraftHistoryState,
      state.getSessionById,
      invalidateAttachmentMutation,
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
          draftUpdatedAt: updatedAt,
          draftAttachmentsUpdatedAt: updatedAt,
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
            ? {
                draftUpdatedAt: updatedAt,
                draftAttachmentsUpdatedAt: updatedAt,
              }
            : {}),
          updatedAt,
        });
      });
    },
    [applySessionMessageLimit, state.updateSessionById],
  );

  const updateQueuedMessageStatus = useCallback(
    (
      messageId: string,
      status: ChatSessionQueuedMessage["status"],
      failureMessage?: string,
    ): void => {
      const normalizedFailureMessage = failureMessage?.trim();

      updateQueuedSessionMessages((current) =>
        current.map((message) => {
          if (
            message.id !== messageId ||
            (message.status === status &&
              message.failureMessage === normalizedFailureMessage)
          ) {
            return message;
          }

          const updatedAt = Date.now();
          return setQueuedMessageStatus(
            message,
            status,
            updatedAt,
            normalizedFailureMessage,
          );
        }),
      );
    },
    [updateQueuedSessionMessages],
  );

  const markQueuedMessagePromptEnhancementFailed = useCallback(
    (messageId: string, cancelled: boolean): void => {
      updateQueuedMessageStatus(
        messageId,
        "failed",
        cancelled ? "Enhancement cancelled." : "Enhancement failed.",
      );
    },
    [updateQueuedMessageStatus],
  );

  const rebindQueuedPromptEnhancementFollowers = useCallback(
    (
      sessionId: string,
      promptEnhancementTaskId: string,
      taskId: string,
    ): void => {
      updateQueuedSessionMessages((current) =>
        current.map((message) => {
          if (
            message.sessionId !== sessionId ||
            message.blockedByTaskId !== promptEnhancementTaskId
          ) {
            return message;
          }

          const updatedAt = Date.now();

          return {
            ...message,
            blockedByTaskId: taskId,
            blockerUpdatedAt: updatedAt,
            updatedAt,
          };
        }),
      );
    },
    [updateQueuedSessionMessages],
  );

  const failQueuedPromptEnhancementFollowers = useCallback(
    (sessionId: string, promptEnhancementTaskId: string): void => {
      updateQueuedSessionMessages((current) =>
        current.map((message) => {
          if (
            message.sessionId !== sessionId ||
            message.blockedByTaskId !== promptEnhancementTaskId
          ) {
            return message;
          }

          const updatedAt = Date.now();
          const nextMessage = {
            ...message,
            blockerUpdatedAt: updatedAt,
          };

          delete nextMessage.blockedByTaskId;

          return setQueuedMessageStatus(
            nextMessage,
            "failed",
            updatedAt,
            "The request ahead of this one did not start.",
          );
        }),
      );
    },
    [updateQueuedSessionMessages],
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
    unsettledDesktopTasksRef,
    ignoredDesktopTaskIdsRef,
    progressRoutesRef: desktopTaskProgressRoutesRef,
    applySessionMessageLimit,
    updateThinkingTrace,
    onComposerCleared: (sessionId) =>
      invalidateAttachmentMutation(`session:${sessionId}`),
    onSessionOperationConflict: (submission) =>
      sessionOperationConflictHandlerRef.current(submission),
  });

  const enhancePromptForSubmission = useCallback(
    async (
      submission: Extract<
        ChatInputNeededSubmission,
        { kind: "active-session" }
      >,
      prompt: string,
      placement: PromptEnhancementPendingPlacement,
    ): Promise<PromptEnhancementResult> => {
      const normalizedPrompt = prompt.trim();
      const enhancementMode = submission.promptEnhancementMode;

      if (!normalizedPrompt || enhancementMode === "off") {
        return { task: normalizedPrompt, taskId: null };
      }

      if (
        enhancementMode === "web-search" &&
        !promptEnhancementWebSearchAvailable
      ) {
        const error = PROMPT_ENHANCEMENT_WEB_SEARCH_UNAVAILABLE_REASON;
        setPromptEnhancementStatus({
          sessionId: submission.sessionSnapshot.id,
          tone: "error",
          text: error,
        });
        throw new Error(error);
      }

      const activeMode = enhancementMode as ActivePromptEnhancementMode;
      const taskId = `${PROMPT_ENHANCEMENT_TASK_ID_PREFIX}${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const sessionSnapshot = submission.sessionSnapshot;
      const targetMessageId = submission.conversationCutoffMessageId?.trim();

      if (placement === "edit-composer" && !targetMessageId) {
        throw new Error(
          "Edited-message enhancement requires a target message.",
        );
      }

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
        ownerLaunchId:
          shellStateRef.current.lastRecoveredLaunchId ?? "pending-launch",
        ownerWindowId: chatOperationWindowId,
        ownerInstanceId: chatOperationInstanceId,
        ...(targetMessageId ? { targetMessageId } : {}),
      };
      const imagePaths = getImageAttachmentPaths(submission.contextAttachments);

      setPromptEnhancementStatus(null);
      setPromptEnhancementPreview((current) =>
        current?.sessionId === sessionSnapshot.id ? null : current,
      );
      setPromptEnhancementPendingTasks((current) => [...current, pending]);
      desktopTaskProgressRoutesRef.current.set(taskId, {});
      activeDesktopTasksRef.current.set(taskId, sessionSnapshot.id);
      activePromptEnhancementInputsRef.current.set(taskId, normalizedPrompt);

      if (placement === "message" && !submission.conversationCutoffMessageId) {
        const clearedComposer = clearSessionComposerInput(
          sessionSnapshot.id,
          submission.composerClearGuard,
        );

        if (clearedComposer) {
          pending.composerClearGuard = clearedComposer;
          submission.composerClearGuard = clearedComposer;
        }
      }

      showPromptEnhancementSessionPlaceholder(pending);

      try {
        await state.flushPersistence();
        const operationOwned = shellStateRef.current.sessions.some(
          (session) =>
            session.id === sessionSnapshot.id &&
            session.messages.some(
              (message) =>
                isTransientChatOperationMessage(message) &&
                getMessageTaskId(message) === taskId,
            ),
        );
        if (!operationOwned) {
          throw new Error(
            "The session was deleted before prompt enhancement started.",
          );
        }

        const taskRun = await runInternalDesktopTask(
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
              runtime.runtimeSnapshot?.workspaceMemoryEnabled ??
                runtime.userMemorySettings.workspaceDefaultEnabled !== false,
            ),
            mode: "ask",
            ...(imagePaths.length > 0 ? { imagePaths } : {}),
            sessionId: sessionSnapshot.id,
            taskId,
            operationKind: "prompt-enhancement",
          },
        );

        if (ignoredDesktopTaskIdsRef.current.has(taskId)) {
          throw new PromptEnhancementCancellationError(taskId);
        }

        const responseText =
          taskRun.execution.response?.markdown ?? taskRun.execution.summary;
        const enhancedPrompt = extractEnhancedPrompt(responseText);

        if (!enhancedPrompt) {
          throw new Error(
            "Prompt enhancement did not return an enhanced prompt.",
          );
        }

        if (
          taskRun.execution.status !== "executed" &&
          taskRun.execution.status !== "planned"
        ) {
          throw new Error(
            taskRun.execution.reason ?? taskRun.execution.summary,
          );
        }

        setPromptEnhancementStatus(null);

        return { task: enhancedPrompt, taskId };
      } catch (error) {
        const message = getPromptEnhancementErrorMessage(error);
        const wasCancelled = isPromptEnhancementCancellation(
          error,
          taskId,
          ignoredDesktopTaskIdsRef.current,
        );

        if (placement === "message") {
          removePromptEnhancementSessionPlaceholder(pending);
          restorePromptEnhancementComposer(pending);
        }

        failQueuedPromptEnhancementFollowers(pending.sessionId, pending.taskId);

        setPromptEnhancementStatus(
          wasCancelled
            ? null
            : {
                sessionId: pending.sessionId,
                tone: "error",
                text: `Prompt enhancement failed: ${message}`,
              },
        );
        throw error instanceof Error ? error : new Error(message);
      } finally {
        activeDesktopTasksRef.current.delete(taskId);
        activePromptEnhancementInputsRef.current.delete(taskId);
        desktopTaskProgressRoutesRef.current.delete(taskId);
        ignoredDesktopTaskIdsRef.current.delete(taskId);
        removePromptEnhancementSessionPlaceholder(pending);
        setPromptEnhancementPendingTasks((current) =>
          current.filter((entry) => entry.taskId !== taskId),
        );
      }
    },
    [
      aiContextMessageLimit,
      chatOperationInstanceId,
      chatOperationWindowId,
      clearSessionComposerInput,
      failQueuedPromptEnhancementFollowers,
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
        promptEnhancementRequest?: ChatSessionQueuedPromptEnhancementRequest;
        dispatchPolicy?: ChatSessionQueuedMessage["dispatchPolicy"];
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
      const blockedByTaskId =
        input?.blockedByTaskId ??
        (targetSession ? getLatestRunningTaskId(targetSession) : null) ??
        getActiveDesktopTaskIdForSession(sessionId);
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
        ...(input?.promptEnhancement
          ? { promptEnhancement: input.promptEnhancement }
          : {}),
        ...(input?.promptEnhancementRequest
          ? { promptEnhancementRequest: input.promptEnhancementRequest }
          : {}),
        dispatchPolicy: input?.dispatchPolicy ?? "after-success",
        ...(blockedByTaskId ? { blockedByTaskId } : {}),
        contextAttachments,
        contentUpdatedAt: now,
        attachmentsUpdatedAt: now,
        attachmentTombstones: {},
        blockerUpdatedAt: now,
        orderRank,
        orderUpdatedAt: now,
        status: "queued",
        statusUpdatedAt: now,
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
      getActiveDesktopTaskIdForSession,
      state.activeSession,
      updateQueuedSessionMessages,
    ],
  );

  const handleSessionOperationConflict = useCallback(
    (submission: SessionOperationConflictSubmission): boolean => {
      const { activeTaskId, queuedMessageRecovery, ...queuedSubmission } =
        submission;

      if (queuedMessageRecovery) {
        const updatedAt = Date.now();
        const recoveredQueuedMessage = createFailedQueuedMessageRecovery(
          {
            ...queuedMessageRecovery,
            contextAttachments: queuedSubmission.contextAttachments.map(
              (attachment) => ({ ...attachment }),
            ),
          },
          crypto.randomUUID(),
          activeTaskId,
          updatedAt,
        );

        updateQueuedSessionMessages((current) => [
          ...current,
          recoveredQueuedMessage,
        ]);
        activeDesktopTasksRef.current.set(activeTaskId, submission.sessionId);
        return true;
      }

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
    [queueActiveSessionMessage, updateQueuedSessionMessages],
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
            activeDesktopTasksRef.current.set(taskId, blockedMessage.sessionId);
            continue;
          }

          if (
            activeDesktopTasksRef.current.get(taskId) ===
            blockedMessage.sessionId
          ) {
            activeDesktopTasksRef.current.delete(taskId);
          }
        }
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
  }, [blockedQueuedTaskIdsSignature]);

  const appendSteeringMessageToRunningTask = useCallback(
    (input?: {
      sessionSnapshot: ChatSessionRecord;
      task: string;
      contextAttachments: ChatSessionContextAttachment[];
      composerClearGuard?: ComposerClearGuard;
    }): boolean => {
      const submittedSessionSnapshot =
        input?.sessionSnapshot ?? state.activeSession;
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
        Math.min(
          0,
          ...shellStateRef.current.queuedSessionMessages
            .filter((message) => message.sessionId === sessionSnapshot.id)
            .map((message) => message.orderRank),
        ) - 1;
      const queuedMessage: ChatSessionQueuedMessage = {
        id: crypto.randomUUID(),
        sessionId: sessionSnapshot.id,
        task,
        visibleMessageContent: task,
        promptHistoryContent: task,
        dispatchPolicy: "after-success",
        blockedByTaskId: targetTaskId,
        contextAttachments,
        contentUpdatedAt: now,
        attachmentsUpdatedAt: now,
        attachmentTombstones: {},
        blockerUpdatedAt: now,
        orderRank,
        orderUpdatedAt: now,
        status: "queued",
        statusUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      };

      updateQueuedSessionMessages((current) => [queuedMessage, ...current]);
      clearSessionComposerInput(sessionSnapshot.id, input?.composerClearGuard);

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
        nextQueuedMessage.status === "failed" ||
        !canDispatchQueuedMessage(
          nextQueuedMessage,
          session,
          getUnsettledDesktopTaskIdForSession(session.id),
        ) ||
        dispatchingQueuedMessageIds.has(nextQueuedMessage.id)
      ) {
        return;
      }

      dispatchingQueuedMessageIds.add(nextQueuedMessage.id);
      void beginCrossWindowOperation(`queued-message:${nextQueuedMessage.id}`)
        .then(async (lease) => {
          if (!lease) {
            return;
          }

          let promptEnhancementTaskId: string | null = null;

          try {
            const queuedMessageAtDispatch =
              shellStateRef.current.queuedSessionMessages.find(
                (message) => message.id === nextQueuedMessage.id,
              );
            let latestSession = state.getSessionById(session.id);
            const queuedHeadAtDispatch =
              shellStateRef.current.queuedSessionMessages.find(
                (message) =>
                  message.sessionId === session.id &&
                  message.task.trim().length > 0,
              );

            if (
              !queuedMessageAtDispatch ||
              !latestSession ||
              queuedHeadAtDispatch?.id !== queuedMessageAtDispatch.id ||
              queuedMessageAtDispatch.status === "failed" ||
              !canDispatchQueuedMessage(
                queuedMessageAtDispatch,
                latestSession,
                getUnsettledDesktopTaskIdForSession(latestSession.id),
              ) ||
              getSessionOverviewStatus(latestSession) === "running"
            ) {
              await releaseCrossWindowOperation(lease);
              return;
            }

            const promptEnhancementRequest =
              queuedMessageAtDispatch.promptEnhancementRequest;
            let enhancedPrompt: string | undefined;

            if (promptEnhancementRequest) {
              updateQueuedMessageStatus(
                queuedMessageAtDispatch.id,
                "enhancing",
              );

              try {
                const enhancement = await enhancePromptForSubmission(
                  {
                    kind: "active-session",
                    sessionSnapshot: latestSession,
                    task: queuedMessageAtDispatch.task,
                    contextAttachments:
                      queuedMessageAtDispatch.contextAttachments.map(
                        (attachment) => ({ ...attachment }),
                      ),
                    runningAction: null,
                    composerClearGuard: createComposerClearGuard(latestSession),
                    messageSettings: createSessionMessageSettings(
                      latestSession,
                      promptEnhancementRequest.mode,
                      false,
                    ),
                    promptEnhancementMode: promptEnhancementRequest.mode,
                    interviewEnabled: false,
                  },
                  queuedMessageAtDispatch.task,
                  "queued-message",
                );
                enhancedPrompt = enhancement.task;
                promptEnhancementTaskId = enhancement.taskId;
              } catch (error) {
                const failedQueuedMessage =
                  shellStateRef.current.queuedSessionMessages.find(
                    (message) => message.id === queuedMessageAtDispatch.id,
                  );

                if (
                  failedQueuedMessage &&
                  isQueuedPromptEnhancementInputCurrent(
                    queuedMessageAtDispatch,
                    failedQueuedMessage,
                  )
                ) {
                  markQueuedMessagePromptEnhancementFailed(
                    failedQueuedMessage.id,
                    error instanceof PromptEnhancementCancellationError,
                  );
                  await completeCrossWindowOperation(lease);
                } else {
                  await releaseCrossWindowOperation(lease);
                }
                return;
              }
            }

            const refreshedQueuedMessage =
              shellStateRef.current.queuedSessionMessages.find(
                (message) => message.id === queuedMessageAtDispatch.id,
              );
            const refreshedSession = state.getSessionById(session.id);
            const refreshedQueuedHead =
              shellStateRef.current.queuedSessionMessages.find(
                (message) =>
                  message.sessionId === session.id &&
                  message.task.trim().length > 0,
              );

            if (
              !refreshedQueuedMessage ||
              !refreshedSession ||
              !isQueuedPromptEnhancementInputCurrent(
                queuedMessageAtDispatch,
                refreshedQueuedMessage,
              )
            ) {
              if (promptEnhancementTaskId) {
                failQueuedPromptEnhancementFollowers(
                  latestSession.id,
                  promptEnhancementTaskId,
                );
              }
              await releaseCrossWindowOperation(lease);
              return;
            }

            const dispatchAttempt = createQueuedMessageDispatchAttempt(
              refreshedQueuedMessage,
              enhancedPrompt,
              Date.now(),
            );
            let dispatchAttemptStored = false;

            updateQueuedSessionMessages((current) =>
              current.map((message) => {
                if (
                  message.id !== refreshedQueuedMessage.id ||
                  !isQueuedPromptEnhancementInputCurrent(
                    refreshedQueuedMessage,
                    message,
                  )
                ) {
                  return message;
                }

                dispatchAttemptStored = true;
                return dispatchAttempt.message;
              }),
            );

            if (!dispatchAttemptStored) {
              if (promptEnhancementTaskId) {
                failQueuedPromptEnhancementFollowers(
                  latestSession.id,
                  promptEnhancementTaskId,
                );
              }
              await releaseCrossWindowOperation(lease);
              return;
            }

            const canStartDispatch = canStartQueuedMessageDispatch(
              dispatchAttempt.message,
              refreshedQueuedHead?.id,
              refreshedSession,
              getUnsettledDesktopTaskIdForSession(refreshedSession.id),
            );

            if (!canStartDispatch) {
              updateQueuedMessageStatus(
                dispatchAttempt.message.id,
                "failed",
                "Task could not start.",
              );
              if (promptEnhancementTaskId) {
                failQueuedPromptEnhancementFollowers(
                  refreshedSession.id,
                  promptEnhancementTaskId,
                );
              }
              await completeCrossWindowOperation(lease);
              return;
            }

            const queuedMessageToSubmit = dispatchAttempt.message;
            const dispatchPrompt = dispatchAttempt.prompt;
            latestSession = refreshedSession;
            const promptEnhancementTaskIdForStartedTask =
              promptEnhancementTaskId;

            const didSubmit = taskSubmission.submitTaskToSession({
              sessionSnapshot: latestSession,
              task: dispatchPrompt.task,
              contextAttachments: queuedMessageToSubmit.contextAttachments,
              clearDraft: false,
              activateSession: shouldActivateSubmittedSession(latestSession.id),
              visibleMessageContent: dispatchPrompt.visibleMessageContent,
              promptHistoryContent: dispatchPrompt.promptHistoryContent,
              consumedQueuedMessageId: queuedMessageToSubmit.id,
              queuedMessageRecovery: queuedMessageToSubmit,
              ...(dispatchPrompt.promptEnhancement
                ? { promptEnhancement: dispatchPrompt.promptEnhancement }
                : {}),
              ...(promptEnhancementRequest
                ? {
                    messageSettings: createSessionMessageSettings(
                      latestSession,
                      promptEnhancementRequest.mode,
                      false,
                    ),
                  }
                : {}),
              ...(promptEnhancementTaskIdForStartedTask
                ? {
                    onTaskStarted: (taskId: string) =>
                      rebindQueuedPromptEnhancementFollowers(
                        latestSession.id,
                        promptEnhancementTaskIdForStartedTask,
                        taskId,
                      ),
                  }
                : {}),
            });

            if (!didSubmit) {
              if (promptEnhancementTaskId) {
                failQueuedPromptEnhancementFollowers(
                  latestSession.id,
                  promptEnhancementTaskId,
                );
              }
              const currentSession = state.getSessionById(latestSession.id);
              updateQueuedMessageStatus(
                queuedMessageToSubmit.id,
                "failed",
                currentSession
                  ? "Task could not start."
                  : "The target session no longer exists.",
              );
              await completeCrossWindowOperation(lease);
              return;
            }

            await completeCrossWindowOperation(lease);
          } catch (error) {
            updateQueuedMessageStatus(
              nextQueuedMessage.id,
              "failed",
              "Queue dispatch failed.",
            );
            if (promptEnhancementTaskId) {
              failQueuedPromptEnhancementFollowers(
                session.id,
                promptEnhancementTaskId,
              );
            }
            await completeCrossWindowOperation(lease);
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
      enhancePromptForSubmission,
      failQueuedPromptEnhancementFollowers,
      getUnsettledDesktopTaskIdForSession,
      markQueuedMessagePromptEnhancementFailed,
      queuedSessionMessages,
      rebindQueuedPromptEnhancementFollowers,
      shouldActivateSubmittedSession,
      state.getSessionById,
      taskSubmission,
      updateQueuedMessageStatus,
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
          if (message.id !== messageId || isQueuedMessageInProgress(message)) {
            return message;
          }

          const updatedAt = Date.now();
          const currentMessage = { ...message };
          delete currentMessage.promptEnhancement;
          delete currentMessage.failureMessage;

          const hasContent = Boolean(content.trim());

          return setQueuedMessageStatus(
            {
              ...currentMessage,
              task: content,
              visibleMessageContent: content,
              promptHistoryContent: content,
              contentUpdatedAt: updatedAt,
            },
            hasContent ? "queued" : "failed",
            updatedAt,
            hasContent ? undefined : "Enter a message or remove this item.",
          );
        }),
      );
    },
    [updateQueuedSessionMessages],
  );

  const handleQueuedMessageMove = useCallback(
    (messageId: string, direction: -1 | 1): void => {
      updateQueuedSessionMessages((current) => {
        const movingMessage = current.find(
          (message) => message.id === messageId,
        );

        if (
          !movingMessage ||
          isQueuedMessageInProgress(movingMessage) ||
          current.some(
            (message) =>
              message.sessionId === movingMessage.sessionId &&
              isQueuedMessageInProgress(message),
          )
        ) {
          return current;
        }

        const sessionIndex = sortQueuedMessages(
          current.filter(
            (message) => message.sessionId === movingMessage.sessionId,
          ),
        ).findIndex((message) => message.id === messageId);

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
      updateQueuedSessionMessages((current) => {
        const message = current.find((entry) => entry.id === messageId);

        if (
          !message ||
          isQueuedMessageInProgress(message) ||
          current.some(
            (entry) =>
              entry.sessionId === message.sessionId &&
              isQueuedMessageInProgress(entry),
          )
        ) {
          return current;
        }

        return reorderQueuedMessagesWithinSession(
          current,
          messageId,
          targetIndex,
        );
      });
    },
    [updateQueuedSessionMessages],
  );

  const handleQueuedMessageRemove = useCallback(
    (messageId: string): void => {
      const mutationKey = `queued:${messageId}`;
      attachmentMutationVersionsRef.current.set(
        mutationKey,
        (attachmentMutationVersionsRef.current.get(mutationKey) ?? 0) + 1,
      );
      updateQueuedSessionMessages((current) => {
        const message = current.find((entry) => entry.id === messageId);

        return message && !isQueuedMessageInProgress(message)
          ? current.filter((entry) => entry.id !== messageId)
          : current;
      });
    },
    [updateQueuedSessionMessages],
  );

  const handleQueuedMessageSend = useCallback(
    (messageId: string): void => {
      updateQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId && message.status === "queued"
            ? (() => {
                const updatedAt = Date.now();
                return {
                  ...setQueuedMessageStatus(message, "queued", updatedAt),
                  dispatchPolicy: "after-terminal",
                  blockerUpdatedAt: updatedAt,
                };
              })()
            : message,
        ),
      );
    },
    [updateQueuedSessionMessages],
  );

  const handleQueuedMessageRetry = useCallback(
    (messageId: string): void => {
      updateQueuedSessionMessages((current) =>
        current.map((message) =>
          message.id === messageId && message.status === "failed"
            ? createQueuedMessageRetry(message, crypto.randomUUID(), Date.now())
            : message,
        ),
      );
    },
    [updateQueuedSessionMessages],
  );

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
          message.id === messageId && !isQueuedMessageInProgress(message)
            ? (() => {
                const updatedAt = Date.now();
                return setQueuedMessageStatus(
                  {
                    ...message,
                    contextAttachments: mergeContextAttachments(
                      message.contextAttachments,
                      attachments,
                    ),
                    attachmentsUpdatedAt: updatedAt,
                  },
                  "queued",
                  updatedAt,
                );
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

      if (isQueuedMessageInProgress(queuedMessage)) {
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
                      targetSession.model,
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

  const handlePasteQueuedMessageImages = useCallback(
    async (messageId: string, files: File[]): Promise<void> => {
      const queuedMessage = queuedSessionMessages.find(
        (message) => message.id === messageId,
      );

      if (!queuedMessage || isQueuedMessageInProgress(queuedMessage)) {
        return;
      }

      const mutationKey = `queued:${messageId}`;
      const mutationVersion =
        attachmentMutationVersionsRef.current.get(mutationKey) ?? 0;
      const targetSession =
        state.shellState.sessions.find(
          (session) => session.id === queuedMessage.sessionId,
        ) ?? state.activeSession;
      const paths = await saveSupportedClipboardImageFiles(
        files,
        targetSession.provider,
        targetSession.model,
      );

      if (paths.length === 0) {
        return;
      }

      await handleAttachQueuedMessagePaths(messageId, paths, mutationVersion);
    },
    [
      handleAttachQueuedMessagePaths,
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
          message.id === messageId && !isQueuedMessageInProgress(message)
            ? (() => {
                const updatedAt = Date.now();
                return setQueuedMessageStatus(
                  {
                    ...message,
                    contextAttachments: message.contextAttachments.filter(
                      (attachment) => attachment.id !== attachmentId,
                    ),
                    attachmentTombstones: {
                      ...message.attachmentTombstones,
                      [attachmentId]: updatedAt,
                    },
                    attachmentsUpdatedAt: updatedAt,
                  },
                  "queued",
                  updatedAt,
                );
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
          !isQueuedMessageInProgress(message) &&
          message.contextAttachments.length > 0
            ? (() => {
                const updatedAt = Date.now();
                return setQueuedMessageStatus(
                  {
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
                  },
                  "queued",
                  updatedAt,
                );
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

      for (const [
        taskId,
        activeSessionId,
      ] of activeDesktopTasksRef.current.entries()) {
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
          draftUpdatedAt: updatedAt,
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
      key:
        | "sessionMemoryEnabled"
        | "useWorkspaceMemory"
        | "useGlobalMemory"
        | "uiControlEnabled",
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
          draftAttachmentsUpdatedAt: updatedAt,
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
          draftAttachmentsUpdatedAt: updatedAt,
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
      let appliedPromptEnhancementMode: PromptEnhancementMode | undefined;
      let appliedInterviewEnabled: boolean | undefined;

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
        const nextComposerSettings = applySmartContextPackSettingsToComposer(
          {
            promptEnhancementMode,
            interviewEnabled: chatInterviewEnabled,
          },
          pack,
        );
        appliedPromptEnhancementMode =
          nextComposerSettings.promptEnhancementMode;
        appliedInterviewEnabled = nextComposerSettings.interviewEnabled;

        const now = Date.now();
        const savedModelSelection = getSmartContextPackModelSelection(
          pack,
          providerChooserState.chooserProviders,
        );

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
            return applySmartContextPackSettingsToSession(
              {
                ...session,
                draft: application.draft,
                draftContextAttachments: application.contextAttachments,
                draftUpdatedAt: now,
                draftAttachmentsUpdatedAt: now,
                updatedAt: now,
              },
              pack,
              savedModelSelection,
            );
          }),
        };

        return applySmartContextPackSettingsToShellDefaults(
          nextState,
          pack,
          savedModelSelection,
        );
      });

      if (applied && activeSessionIdRef.current === sessionId) {
        if (appliedPromptEnhancementMode !== undefined) {
          setPromptEnhancementMode(appliedPromptEnhancementMode);
        }

        if (appliedInterviewEnabled !== undefined) {
          setChatInterviewEnabled(appliedInterviewEnabled);
        }
      }

      return applied;
    },
    [
      chatInterviewEnabled,
      promptEnhancementMode,
      providerChooserState.chooserProviders,
      state.applyShellState,
    ],
  );

  useFleetManagedSettings({
    hasHydrated: state.hasHydrated,
    shellState: state.shellState,
    applyShellState: state.applyShellState,
    userAgentLimitsSettings: runtime.userAgentLimitsSettings,
    applyLoadedUserAgentLimitsSettings:
      runtime.applyLoadedUserAgentLimitsSettings,
    refreshInstructions: refreshInstructionRegistry,
  });

  useFleetControl({
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
    recentWorkspaces: state.shellState.recentWorkspaces,
    promptEnhancementMode: activePromptEnhancementMode,
    interviewEnabled: chatInterviewEnabled,
    interviewAvailable: !chatInterviewBusy,
    instructionRegistry,
    instructionRegistryLoading,
    instructionRegistryError:
      instructionRegistryMessage?.tone === "error"
        ? instructionRegistryMessage.text
        : null,
    onRefreshInstructions: refreshInstructionRegistry,
    isGlobalMemoryAvailable: memorySummaryState.isGlobalMemoryAvailable,
    isGlobalMemoryActive: memorySummaryState.isGlobalMemoryActive,
    isWorkspaceMemoryAvailable: memorySummaryState.isWorkspaceMemoryAvailable,
    isWorkspaceMemoryActive: memorySummaryState.isWorkspaceMemoryActive,
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
    quickTaskUiControlEnabled:
      isUiControlAvailable && quickTaskUiControlEnabled,
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
    onMarkFleetCommandHandled: (commandId: string) => {
      state.applyShellState((prev) => {
        if (prev.handledFleetCommandIds.includes(commandId)) {
          return prev;
        }

        return {
          ...prev,
          handledFleetCommandIds: [
            ...prev.handledFleetCommandIds,
            commandId,
          ].slice(-512),
        };
      });
    },
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
    onSetSessionWorkspace: applyRemoteWorkspaceSelection,
    onSetPromptEnhancementMode: handlePromptEnhancementModeChange,
    onSetInterview: handleInterviewEnabledChange,
    onCancelPromptEnhancement: (taskId: string) => {
      ignoredDesktopTaskIdsRef.current.add(taskId);
      void cancelDesktopTask(taskId).catch((error) => {
        console.error("Failed to cancel prompt enhancement", error);
      });
    },
    onSubmitSessionMessage: (input) =>
      remoteSessionMessageSubmitRef.current(input),
    onSetSessionMemory: (sessionId: string, enabled: boolean) =>
      handleRemoteSetSessionFlag(sessionId, "sessionMemoryEnabled", enabled),
    onForgetSessionMemory: forgetSessionMemory,
    onSetWorkspaceMemory: (sessionId: string, enabled: boolean) =>
      handleRemoteSetSessionFlag(sessionId, "useWorkspaceMemory", enabled),
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

  const handleQuickTaskDraftSend = useCallback(
    (draft = quickTaskDraft): void => {
      const normalizedDraft = draft.trim();

      if (!normalizedDraft || quickTaskImageInputError) {
        return;
      }

      const contextAttachments = quickTaskContextAttachments.map(
        (attachment) => ({
          ...attachment,
        }),
      );

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
    },
    [
      quickTaskContextAttachments,
      quickTaskDraft,
      quickTaskImageInputError,
      invalidateAttachmentMutation,
      requestChatInputNeededValues,
      submitQuickVoiceCommand,
    ],
  );

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
      desktopTaskProgressRoutesRef.current.delete(interviewTaskId);
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
      ...(context.messageSettings
        ? { messageSettings: context.messageSettings }
        : {}),
      clearDraft: !context.conversationCutoffMessageId,
      ...(composerClearGuard ? { composerClearGuard } : {}),
      activateSession: shouldActivateSubmittedSession(
        context.sessionSnapshot.id,
      ),
      visibleMessageContent: visibleTask,
      promptHistoryContent: context.originalTask ?? visibleTask,
      ...(promptEnhancement ? { promptEnhancement } : {}),
      ...(context.conversationCutoffMessageId
        ? {
            conversationCutoffMessageId: context.conversationCutoffMessageId,
            preserveQueuedMessagesCreatedAfter:
              context.preserveQueuedMessagesCreatedAfter,
          }
        : {}),
    });

    if (submitted) {
      interviewComposerClearGuardsRef.current.delete(context);
      setChatInterview(null);
      if (context.conversationCutoffMessageId) {
        closeMessageEdit(context.conversationCutoffMessageId);
      }
      return;
    }

    setChatInterview((current) =>
      current?.context === context
        ? {
            ...current,
            status: "blocked",
            summary:
              "The task could not start because the session is already running.",
            error:
              "The task could not start because the session is already running.",
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
    const initialThinking = createInitialThinkingTrace(
      context.mode,
      Date.now(),
    );

    activeDesktopTasksRef.current.set(taskId, context.sessionSnapshot.id);
    state.updateSessionById(context.sessionSnapshot.id, (sessionRecord) => {
      if (
        sessionRecord.messages.some(
          (message) => getMessageTaskId(message) === taskId,
        )
      ) {
        return sessionRecord;
      }

      return applySessionMessageLimit({
        ...sessionRecord,
        updatedAt: Date.now(),
        messages: [
          ...sessionRecord.messages,
          {
            id: `${taskId}-marker`,
            taskId,
            role: "agent",
            content: "",
            createdAt: Date.now(),
            lifecycle: {
              kind: "transient",
              owner: "task-interview",
              operationId: taskId,
              slot: "marker",
              ownerLaunchId:
                shellStateRef.current.lastRecoveredLaunchId ?? "pending-launch",
              ownerWindowId: chatOperationWindowId,
              ownerInstanceId: chatOperationInstanceId,
            },
            source: {
              kind: "thinking",
              thinking: initialThinking,
            },
          },
        ],
      });
    });
    desktopTaskProgressRoutesRef.current.set(taskId, {
      onProgress: (progress, timestamp) => {
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
      },
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
      await state.flushPersistence();
      const operationOwned = shellStateRef.current.sessions.some(
        (session) =>
          session.id === context.sessionSnapshot.id &&
          session.messages.some(
            (message) =>
              isTransientChatOperationMessage(message) &&
              getMessageTaskId(message) === taskId,
          ),
      );
      if (!operationOwned) {
        throw new Error(
          "The session was deleted before Task Interview started.",
        );
      }
      const result = await runInternalTaskInterview(
        context.sessionSnapshot.workspace,
        {
          prompt: context.task,
          mode: context.mode,
          contextNotes: createTaskInterviewContextNotes(
            context,
            aiContextMessageLimit,
          ),
          ...(context.reasoning ? { reasoning: context.reasoning } : {}),
          maxTurns: 5,
          taskId,
          sessionId: context.sessionSnapshot.id,
          ...(session ? { session } : {}),
          ...(answers ? { answers } : {}),
          ...(answerComments && Object.keys(answerComments).length > 0
            ? { answerComments }
            : {}),
        },
      );

      await applyChatInterviewResult(context, taskId, result, requestRevision);
    } catch (error) {
      if (chatInterviewRequestRevisionRef.current !== requestRevision) {
        return;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const failure = getDesktopTaskRunFailure(error);
      const status =
        failure?.kind === "cancelled"
          ? "cancelled"
          : failure?.kind === "timed-out"
            ? "timed-out"
            : "failed";

      setChatInterview((current) =>
        current?.taskId === taskId
          ? {
              ...current,
              status,
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
      desktopTaskProgressRoutesRef.current.delete(taskId);
      activeDesktopTasksRef.current.delete(taskId);
      ignoredDesktopTaskIdsRef.current.delete(taskId);
      state.updateSessionById(context.sessionSnapshot.id, (sessionRecord) => {
        const messages = sessionRecord.messages.filter(
          (message) => getMessageTaskId(message) !== taskId,
        );

        return messages.length === sessionRecord.messages.length
          ? sessionRecord
          : applySessionMessageLimit({
              ...sessionRecord,
              messages,
              updatedAt: Date.now(),
            });
      });
    }
  };

  const startChatInterview = (
    task: string,
    sessionSnapshot = state.activeSession,
    contextAttachments = state.activeSession.draftContextAttachments,
    originalTask?: string,
    composerClearGuard?: ComposerClearGuard,
    messageSettings?: ChatSessionMessageSettings,
    conversationCutoffMessageId?: string,
    preserveQueuedMessagesCreatedAfter?: number,
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
      ...(messageSettings ? { messageSettings } : {}),
      ...(conversationCutoffMessageId ? { conversationCutoffMessageId } : {}),
      ...(preserveQueuedMessagesCreatedAfter !== undefined
        ? { preserveQueuedMessagesCreatedAfter }
        : {}),
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
            skippedFieldIds: current.skippedFieldIds.filter(
              (id) => id !== fieldId,
            ),
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
            expandedCommentFieldIds: current.expandedCommentFieldIds.includes(
              fieldId,
            )
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
      void cancelDesktopTask(taskId).catch((error) => {
        console.error("Failed to cancel closed task interview:", error);
      });
    }

    setChatInterview(null);
    setPromptEnhancementPreview(null);
  }, [chatInterview]);

  const submitResolvedChatInputNeededSubmission = useCallback(
    (submission: ChatInputNeededSubmission, resolvedTask: string): void => {
      if (submission.kind === "quick-task") {
        if (
          submitQuickVoiceCommand(resolvedTask, submission.contextAttachments)
        ) {
          invalidateAttachmentMutation("quick-task");
          setQuickTaskDraft("");
          setQuickTaskContextAttachments([]);
        }
        return;
      }

      const submitActiveSessionTask = (
        task: string,
        originalTask = submission.promptEnhancementOriginalContent,
        promptEnhancementTaskId: string | null = null,
      ): void => {
        const promptEnhancement = createMessagePromptEnhancement(
          task,
          originalTask,
        );
        const promptEnhancementRequest =
          shouldDeferPromptEnhancementUntilQueuedDispatch(
            submission.promptEnhancementMode,
            submission.runningAction,
          )
            ? createQueuedPromptEnhancementRequest(
                submission.promptEnhancementMode,
              )
            : undefined;
        const promptEnhancementRequestOnConflict =
          originalTask !== undefined
            ? createQueuedPromptEnhancementRequest(
                submission.promptEnhancementMode,
              )
            : undefined;
        const promptHistoryContent = promptEnhancement?.originalContent ?? task;

        const restoreFailedTaskHandoff = (message: string): void => {
          if (submission.conversationCutoffMessageId) {
            setMessageEdit((current) =>
              current &&
              current.messageId === submission.conversationCutoffMessageId &&
              current.sourceSessionId === submission.sessionSnapshot.id
                ? {
                    ...current,
                    session: {
                      ...current.session,
                      draft: task,
                      updatedAt: Date.now(),
                    },
                  }
                : current,
            );
          } else {
            restoreSessionComposerInput({
              sessionId: submission.sessionSnapshot.id,
              prompt: task,
              contextAttachments: submission.contextAttachments,
              composerClearGuard: submission.composerClearGuard,
            });
          }
          setPromptEnhancementStatus({
            sessionId: submission.sessionSnapshot.id,
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
                ...(promptEnhancementRequest
                  ? { promptEnhancementRequest }
                  : {}),
                dispatchPolicy: "after-terminal",
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
                ...(promptEnhancementRequest
                  ? { promptEnhancementRequest }
                  : {}),
                contextAttachments: submission.contextAttachments,
                composerClearGuard: submission.composerClearGuard,
              });
              return;
          }
        }

        if (submission.interviewEnabled) {
          if (promptEnhancementTaskId) {
            failQueuedPromptEnhancementFollowers(
              submission.sessionSnapshot.id,
              promptEnhancementTaskId,
            );
          }
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
                submission.messageSettings,
                submission.conversationCutoffMessageId,
                submission.preserveQueuedMessagesCreatedAfter,
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
            submission.messageSettings,
            submission.conversationCutoffMessageId,
            submission.preserveQueuedMessagesCreatedAfter,
          );
          return;
        }

        const didSubmit = taskSubmission.submitTaskToSession({
          sessionSnapshot: submission.sessionSnapshot,
          task,
          contextAttachments: submission.contextAttachments,
          messageSettings: submission.messageSettings,
          clearDraft: !submission.conversationCutoffMessageId,
          composerClearGuard: submission.composerClearGuard,
          activateSession: shouldActivateSubmittedSession(
            submission.sessionSnapshot.id,
          ),
          visibleMessageContent: task,
          promptHistoryContent,
          ...(promptEnhancement ? { promptEnhancement } : {}),
          ...(promptEnhancementRequestOnConflict
            ? { promptEnhancementRequestOnConflict }
            : {}),
          ...(submission.conversationCutoffMessageId
            ? {
                conversationCutoffMessageId:
                  submission.conversationCutoffMessageId,
                preserveQueuedMessagesCreatedAfter:
                  submission.preserveQueuedMessagesCreatedAfter,
              }
            : {}),
          ...(promptEnhancementTaskId
            ? {
                onTaskStarted: (taskId: string) =>
                  rebindQueuedPromptEnhancementFollowers(
                    submission.sessionSnapshot.id,
                    promptEnhancementTaskId,
                    taskId,
                  ),
              }
            : {}),
        });

        if (!didSubmit) {
          if (promptEnhancementTaskId) {
            failQueuedPromptEnhancementFollowers(
              submission.sessionSnapshot.id,
              promptEnhancementTaskId,
            );
          }
          restoreFailedTaskHandoff(
            "The request could not start because the session is already running.",
          );
          return;
        }

        if (submission.conversationCutoffMessageId) {
          closeMessageEdit(submission.conversationCutoffMessageId);
        }
      };

      if (
        submission.promptEnhancementMode === "off" ||
        submission.runningAction === "steer" ||
        shouldDeferPromptEnhancementUntilQueuedDispatch(
          submission.promptEnhancementMode,
          submission.runningAction,
        )
      ) {
        submitActiveSessionTask(resolvedTask);
        return;
      }

      void (async (): Promise<void> => {
        const enhancementPlacement =
          resolveImmediatePromptEnhancementPlacement(submission);

        try {
          const enhancement = await enhancePromptForSubmission(
            submission,
            resolvedTask,
            enhancementPlacement,
          );
          submitActiveSessionTask(
            enhancement.task,
            resolvedTask,
            enhancement.taskId,
          );
        } catch {
          return;
        }
      })();
    },
    [
      appendSteeringMessageToRunningTask,
      closeMessageEdit,
      enhancePromptForSubmission,
      failQueuedPromptEnhancementFollowers,
      queueActiveSessionMessage,
      rebindQueuedPromptEnhancementFollowers,
      requestTaskCancellation,
      invalidateAttachmentMutation,
      restoreSessionComposerInput,
      shouldActivateSubmittedSession,
      startChatInterview,
      submitQuickVoiceCommand,
      taskSubmission,
    ],
  );

  const submitRemoteSessionMessage = useCallback(
    (input: {
      sessionId: string;
      prompt: string;
      promptEnhancementMode: PromptEnhancementMode;
      interviewEnabled: boolean;
    }): boolean => {
      const prompt = input.prompt.trim();
      const session = state.getSessionById(input.sessionId);
      if (!prompt || !session) {
        return false;
      }
      const activeTaskId = getActiveDesktopTaskIdForSession(session.id);
      submitResolvedChatInputNeededSubmission(
        {
          kind: "active-session",
          sessionSnapshot: session,
          task: prompt,
          contextAttachments: [],
          runningAction:
            getSessionOverviewStatus(session) === "running" || activeTaskId
              ? "queue"
              : null,
          composerClearGuard: createComposerClearGuard(session),
          messageSettings: createSessionMessageSettings(
            session,
            input.promptEnhancementMode,
            input.interviewEnabled,
          ),
          promptEnhancementMode: input.promptEnhancementMode,
          interviewEnabled: input.interviewEnabled,
        },
        prompt,
      );
      return true;
    },
    [
      getActiveDesktopTaskIdForSession,
      state.getSessionById,
      submitResolvedChatInputNeededSubmission,
    ],
  );
  remoteSessionMessageSubmitRef.current = submitRemoteSessionMessage;

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

  const handleSend = (draft = activeComposerSession.draft): void => {
    const task = draft.trim();
    const currentEdit = activeMessageEditRef.current;
    const activeComposerTaskId = getActiveDesktopTaskIdForSession(
      activeComposerSession.id,
    );
    const activePromptEnhancementInput = activeComposerTaskId
      ? activePromptEnhancementInputsRef.current.get(activeComposerTaskId)
      : undefined;

    if (
      !task ||
      activeSessionImageInputError ||
      (currentEdit &&
        (activeSessionPromptEnhancementBusy || activeComposerTaskId)) ||
      (!currentEdit && activePromptEnhancementInput === task) ||
      promptEnhancementUnavailableReason
    ) {
      return;
    }

    const committedHistorySession =
      !currentEdit && composerState.isHistoryPreviewActive
        ? composerState.commitHistoryPreview()
        : null;

    if (
      !currentEdit &&
      composerState.isHistoryPreviewActive &&
      !committedHistorySession
    ) {
      return;
    }

    const renderedSessionSnapshot =
      currentEdit?.session ?? committedHistorySession ?? activeComposerSession;
    const currentSessionSnapshot =
      currentEdit || committedHistorySession
        ? null
        : state.getSessionById(renderedSessionSnapshot.id);
    const sessionSnapshot = createComposerSubmissionSessionSnapshot(
      renderedSessionSnapshot,
      currentSessionSnapshot,
      draft,
    );
    const contextAttachments = sessionSnapshot.draftContextAttachments.map(
      (attachment) => ({ ...attachment }),
    );
    const selectedPromptEnhancementMode =
      currentEdit?.promptEnhancementMode ?? promptEnhancementMode;
    const submission: ChatInputNeededSubmission = {
      kind: "active-session",
      sessionSnapshot,
      task,
      contextAttachments,
      composerClearGuard: createComposerClearGuard(sessionSnapshot),
      messageSettings: createSessionMessageSettings(
        sessionSnapshot,
        selectedPromptEnhancementMode,
        currentEdit?.interviewEnabled ?? chatInterviewEnabled,
      ),
      promptEnhancementMode: selectedPromptEnhancementMode,
      interviewEnabled: currentEdit?.interviewEnabled ?? chatInterviewEnabled,
      runningAction:
        !currentEdit &&
        (getSessionOverviewStatus(sessionSnapshot) === "running" ||
          Boolean(activeComposerTaskId))
          ? activeSessionPromptEnhancementBusy ||
            Boolean(activePromptEnhancementInput)
            ? "queue"
            : runningTaskMessageAction
          : null,
      ...(currentEdit
        ? {
            conversationCutoffMessageId: currentEdit.messageId,
            preserveQueuedMessagesCreatedAfter: currentEdit.startedAt,
          }
        : {}),
    };

    if (requestChatInputNeededValues(submission)) {
      return;
    }

    submitResolvedChatInputNeededSubmission(submission, task);
  };

  const currentChatInputNeededPlaceholder =
    chatInputNeeded?.placeholders[chatInputNeeded.currentIndex] ?? null;
  const conversationPromptEnhancementPreview =
    promptEnhancementPreview?.sessionId === state.activeSession.id
      ? {
          id: promptEnhancementPreview.id,
          content: promptEnhancementPreview.content,
          originalContent: promptEnhancementPreview.originalContent,
          contextAttachments: promptEnhancementPreview.contextAttachments,
        }
      : null;
  const activePromptEnhancementEditMessageId =
    getActivePromptEnhancementEditMessageId(state.activeSession);
  const activeEditingMessageId =
    messageEdit?.sourceSessionId === state.activeSession.id
      ? messageEdit.messageId
      : activePromptEnhancementEditMessageId;
  const editingPromptEnhancement = activePromptEnhancementEditMessageId
    ? { messageId: activePromptEnhancementEditMessageId }
    : null;
  const activeSessionExecuting =
    getSessionOverviewStatus(state.activeSession) === "running" &&
    !activeSessionPromptEnhancementBusy;

  return {
    isDesktop,
    hasHydrated: state.hasHydrated,
    flushPersistence: state.flushPersistence,
    fileManager: {
      knownWorkspaceRoots: state.shellState.recentWorkspaces,
      onRoute: applyFileManagerInvocationRoute,
    },
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
      workspaceRoot:
        quickTaskSession?.workspace ?? state.activeSession.workspace,
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
    activeChatOperationIds,
    titlebar: {
      providerStatuses: providerChooserState.activeProviderStats,
      onMinimizeWindow: windowControls.onMinimizeWindow,
      onToggleMaximizeWindow: windowControls.onToggleMaximizeWindow,
      onCloseWindow: windowControls.onCloseWindow,
    },
    attachMediaAssetToChat,
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
      onDeleteSession: lifecycleActions.deleteSession,
      onTogglePinnedSession: lifecycleActions.togglePinnedSession,
      onDuplicateSession: (sessionId: string) =>
        lifecycleActions.cloneSession(sessionId, "duplicate"),
      onResetSessionTime: lifecycleActions.resetSessionTime,
      onMoveSessionToTop: lifecycleActions.moveSessionToTop,
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
      primaryTaskRunning: activeSessionExecuting,
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
      onDeleteSession: () =>
        lifecycleActions.deleteSession(state.activeSession.id),
    },
    conversation: {
      visibleMessages: state.visibleMessages,
      promptEnhancementPreview: conversationPromptEnhancementPreview,
      workspaceRoot: state.activeSession.workspace,
      aiContextMessageLimit,
      isSessionRunning:
        activeSessionExecuting || activeSessionPromptEnhancementBusy,
      bottomRef: state.bottomRef,
      showScrollToNewestButton: state.showScrollToNewestButton,
      onScrollToNewest: state.scrollToNewest,
      onRetryTask: taskSubmission.handleRetryTask,
      onRetryMessage: taskSubmission.handleRetryMessage,
      onEditMessage: taskSubmission.handleEditMessage,
      onStartEditMessage: handleStartMessageEdit,
      activeEditingMessageId,
      editingPromptEnhancement,
      onCancelPromptEnhancement: activeSessionPromptEnhancementBusy
        ? handleCancel
        : undefined,
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
      editingMessageId: activeMessageEdit?.messageId ?? null,
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
      workspaceMemoryDescription: memorySummaryState.workspaceMemoryDescription,
      globalMemoryDescription: memorySummaryState.globalMemoryDescription,
      uiControlDescription,
      isGlobalMemoryAvailable: memorySummaryState.isGlobalMemoryAvailable,
      isGlobalMemoryActive: memorySummaryState.isGlobalMemoryActive,
      isWorkspaceMemoryAvailable: memorySummaryState.isWorkspaceMemoryAvailable,
      isWorkspaceMemoryActive: memorySummaryState.isWorkspaceMemoryActive,
      isUiControlAvailable,
      interviewEnabled: activeChatInterviewEnabled,
      interviewDisabled: !isDesktop || chatInterviewBusy,
      interviewDescription: isDesktop
        ? "Ask focused precheck questions before starting the task."
        : "Task interviews are available in the desktop app.",
      promptEnhancementMode: activePromptEnhancementMode,
      promptEnhancementWebSearchAvailable,
      promptEnhancementWebSearchUnavailableReason:
        PROMPT_ENHANCEMENT_WEB_SEARCH_UNAVAILABLE_REASON,
      statusMessage:
        promptEnhancementStatus?.sessionId === activeComposerSession.id
          ? promptEnhancementStatus
          : null,
      onStatusMessageDismiss: dismissPromptEnhancementStatus,
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
        onStatusDismiss: speechInput.dismissStatus,
      },
      canSendMessage: canComposeMessage,
      sendDisabledReason: activeSessionSendDisabledReason,
      runningTaskMessageAction: activeSessionPromptEnhancementBusy
        ? "queue"
        : runningTaskMessageAction,
      queuedMessages: activeSessionQueuedMessages.map((message) => {
        const blockerOutcome = message.blockedByTaskId
          ? getSessionTaskOutcome(state.activeSession, message.blockedByTaskId)
          : null;
        const blockerActive = message.blockedByTaskId
          ? activeChatOperationIds.includes(message.blockedByTaskId)
          : false;

        return {
          id: message.id,
          content: message.visibleMessageContent ?? message.task,
          attachments: message.contextAttachments,
          ...(message.promptEnhancementRequest
            ? {
                promptEnhancementMode: message.promptEnhancementRequest.mode,
              }
            : {}),
          status: message.status,
          ...(message.failureMessage
            ? { failureMessage: message.failureMessage }
            : {}),
          canSendNow:
            message.dispatchPolicy === "after-success" &&
            !blockerActive &&
            blockerOutcome?.status !== "succeeded",
          createdAt: message.createdAt,
        };
      }),
      onSelectFolder: handleSelectFolder,
      onWorkspaceSelection: applyWorkspaceSelection,
      onWorkspaceRemoval: removeWorkspaceFromHistory,
      onSessionModelSelection: handleSessionModelSelection,
      onSessionModeSelection: handleSessionModeSelection,
      onSessionReasoningSelection: handleSessionReasoningSelection,
      onSessionMemoryEnabledChange: handleSessionMemoryEnabledChange,
      onForgetSessionMemory: (memoryId: string) =>
        forgetSessionMemory(activeComposerSession.id, memoryId),
      memorySourceSessions,
      onUseWorkspaceMemoryChange: handleUseWorkspaceMemoryChange,
      onUseGlobalMemoryChange: handleUseGlobalMemoryChange,
      onUiControlEnabledChange: handleUiControlEnabledChange,
      onInterviewEnabledChange: handleInterviewEnabledChange,
      onPromptEnhancementModeChange: handlePromptEnhancementModeChange,
      onSelectContextFiles: () =>
        handleSelectAttachments("active-session", "files"),
      onSelectContextFolders: () =>
        handleSelectAttachments("active-session", "folders"),
      onSelectContextImages: () =>
        handleSelectAttachments("active-session", "images"),
      onPasteContextImages: (files: File[]) =>
        handlePasteContextImages(files, "active-session"),
      onOpenContextAttachment: (attachment: ChatSessionContextAttachment) =>
        handleOpenAttachment(attachment, activeComposerSession.workspace),
      onRemoveContextAttachment: (attachmentId: string) =>
        handleRemoveContextAttachment("active-session", attachmentId),
      onClearContextAttachments: () =>
        handleClearContextAttachments("active-session"),
      onSaveContextPack: handleSaveContextPack,
      onApplyContextPack: handleApplyContextPack,
      onDeleteContextPack: handleDeleteContextPack,
      onExportContextPacks: handleExportContextPacks,
      onImportContextPacks: handleImportContextPacks,
      onDraftChange: activeMessageEdit
        ? (value: string) =>
            updateMessageEditSession((session) => ({
              ...session,
              draft: value,
              updatedAt: Date.now(),
            }))
        : composerState.handleDraftChange,
      onComposerHistoryNavigation: activeMessageEdit
        ? () => {}
        : composerState.handleComposerHistoryNavigation,
      onRunningTaskMessageActionChange: setRunningTaskMessageAction,
      onQueuedMessageChange: handleQueuedMessageChange,
      onQueuedMessageMove: handleQueuedMessageMove,
      onQueuedMessageReorder: handleQueuedMessageReorder,
      onQueuedMessageRemove: handleQueuedMessageRemove,
      onQueuedMessageRetry: handleQueuedMessageRetry,
      onQueuedMessageSend: handleQueuedMessageSend,
      onQueuedMessageSelectContextAttachments:
        handleSelectQueuedMessageAttachments,
      onQueuedMessagePasteContextImages: handlePasteQueuedMessageImages,
      onQueuedMessageRemoveContextAttachment:
        handleQueuedMessageRemoveContextAttachment,
      onQueuedMessageClearContextAttachments:
        handleQueuedMessageClearContextAttachments,
      onSend: handleSend,
      onCancel: activeMessageEdit
        ? () => handleCancelMessageEdit(activeMessageEdit.messageId)
        : handleCancel,
      isExecuting: activeSessionExecuting,
      isPromptEnhancementActive: activeSessionPromptEnhancementBusy,
    },
    quickTaskComposer: {
      draft: quickTaskDraft,
      draftRevision: quickTaskSession?.draftUpdatedAt ?? 0,
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
    instructionManagement: {
      workspaceRoot: state.activeSession.workspace,
      registry: instructionRegistry,
      loading: instructionRegistryLoading,
      saving: instructionRegistrySaving,
      message: instructionRegistryMessage,
      onRefresh: refreshInstructionRegistry,
      onSave: handleInstructionSave,
    },
    workspaceManagement: {
      workspaceRoots: state.shellState.recentWorkspaces,
      memorySourceSessions,
      workspaceMemoryDefaultEnabled:
        runtime.userMemorySettings.workspaceDefaultEnabled !== false,
      loading: !state.hasHydrated,
      onAdd: addWorkspaceToHistory,
      onRemove: removeWorkspaceFromHistory,
      onRelink: relinkWorkspaceInHistory,
      onLoadMemory: loadWorkspaceMemoryEntries,
      onForgetMemory: forgetManagedWorkspaceMemory,
      onConfigurationChanged: async (workspaceRoot: string) => {
        if (
          state.activeSession.workspace &&
          createWorkspaceRootKey(state.activeSession.workspace) ===
            createWorkspaceRootKey(workspaceRoot)
        ) {
          await runtime.refreshWorkspaceRuntimeSnapshot(workspaceRoot);
        }
      },
    },
    settingsDialog: {
      settingsSection: state.settingsSection,
      onSettingsSectionChange: state.setSettingsSection,
      effectiveWorkspaceMode: defaultRunMode,
      providerSetup: {
        provider: runtime.providerSetupProvider,
        providerAvailability: runtime.globalProviders ?? [],
        keyValue: runtime.providerSetupKey,
        loading: runtime.providerSetupLoading,
        saving: runtime.providerSetupSaving,
        message: runtime.providerSetupMessage,
        onProviderChange: runtime.handleProviderSetupProviderChange,
        onOpenProviderPortal: runtime.handleProviderSetupPortalOpen,
        onKeyChange: runtime.handleProviderSetupKeyChange,
        onSave: runtime.handleProviderSetupSave,
      },
      webSearchSetup: {
        activeProvider: runtime.webSearchActiveProvider,
        providerAvailability: runtime.webSearchProviderAvailability,
        provider: runtime.webSearchSetupProvider,
        keyValue: runtime.webSearchSetupKey,
        loading: runtime.webSearchSetupLoading,
        saving: runtime.webSearchSetupSaving,
        message: runtime.webSearchSetupMessage,
        onActiveProviderChange: runtime.handleWebSearchActiveProviderSave,
        onProviderChange: runtime.handleWebSearchSetupProviderChange,
        onKeyChange: runtime.handleWebSearchSetupKeyChange,
        onSave: runtime.handleWebSearchSetupSave,
      },
      mcpSetup: {
        workspaceRoot: state.activeSession.workspace,
        document: runtime.mcpConfigDocument,
        draft: runtime.mcpConfigDraft,
        presets: runtime.mcpConfigPresets,
        commandsAvailable: runtime.mcpConfigWorkspaceAvailable,
        loading: runtime.mcpConfigLoading,
        saving: runtime.mcpConfigSaving,
        discoveryServerId: runtime.mcpDiscoveryServerId,
        discoveryBusy: runtime.mcpDiscoveryBusy,
        discoveryOutput: runtime.mcpDiscoveryOutput,
        oauthServerId: runtime.mcpOAuthServerId,
        oauthCallback: runtime.mcpOAuthCallback,
        oauthBusy: runtime.mcpOAuthBusy,
        message: runtime.mcpConfigMessage,
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
        sourceSessions: memorySourceSessions,
        saving: runtime.memorySetupSaving,
        message: runtime.memorySetupMessage,
        onGlobalEnabledChange: runtime.handleGlobalMemoryEnabledSave,
        onWorkspaceDefaultEnabledChange:
          runtime.handleWorkspaceMemoryDefaultEnabledSave,
        onForgetGlobal: runtime.handleGlobalMemoryForget,
      },
      desktopSetup: {
        settings: runtime.userDesktopSettings,
        saving: runtime.desktopSetupSaving,
        message: runtime.desktopSetupMessage,
        onSave: runtime.handleDesktopSettingsSave,
      },
      workspaceRunSetup: {
        settings: runtime.userWorkspaceRunSettings,
        saving: runtime.workspaceRunSetupSaving,
        message: runtime.workspaceRunSetupMessage,
        onSave: runtime.handleWorkspaceRunSettingsSave,
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
