import { normalizeConversationMemoryEntries } from "../../core/memory.js";
import {
  MODEL_PROVIDERS,
  REASONING_MODES,
  VALID_TOOLS,
} from "../../core/runtime-contract.generated.js";
import type {
  ConversationMemoryEntry,
  TaskExecutionChangedLineRange,
  TaskExecutionFileChange,
  TaskExecutionFileChangeCompleteness,
  TaskExecutionFileChangeIssue,
  TaskExecutionFileChangeOperation,
  TaskExecutionFileEntryType,
  TaskExecutionFileLineAnalysis,
  TaskExecutionFileChanges,
  TaskExecutionTokenUsage,
  TaskExecutionNarrative,
  TaskExecutionResult,
  TaskExecutionSection,
  TaskExecutionStatus,
  TaskExecutionTimeoutState,
  TaskRunPreview,
} from "../../core/types.js";
import type {
  MediaAssetKind,
  MediaAssetReference,
} from "../../core/media/contracts.js";
import type {
  ReasoningMode,
  RunMode,
  ToolName,
} from "../../core/runtime-contract.generated.js";
import {
  getDefaultModelForProvider,
  RUNNABLE_PROVIDER_ORDER,
  type RuntimeProvider,
} from "./model-catalog";
import type { TaskPanelTone } from "./task-panel";
import {
  appendTerminalExecutionToThinkingTrace,
  type TaskThinkingActionOutputLine,
  type TaskThinkingModelStream,
  type TaskThinkingSource,
  type TaskThinkingTimelineEvent,
  type TaskThinkingTrace,
} from "./task-thinking.model";
import { normalizeChatSessionOptionalString } from "./chat-session/_helpers/normalize-chat-session-optional-string.helper";
import { createWorkspaceRootKey } from "./workspace-management/workspace-management-model";

export type ChatSessionMessageSource =
  | { kind: "preview"; preview: TaskRunPreview }
  | {
      kind: "execution";
      execution: TaskExecutionResult;
      /** The durable live trace captured before the terminal result replaced it. */
      thinking?: TaskThinkingTrace;
    }
  | {
      kind: "interrupted-task";
      status: "crashed";
      reason: "restart" | "inactive";
    }
  | TaskThinkingSource;

export type ChatSessionSpecialKind = "quick-voice";

export type ChatSessionContextAttachmentKind =
  | "file"
  | "directory"
  | "image"
  | "other";

export interface ChatSessionPathContextAttachment {
  id: string;
  source: "path";
  path: string;
  kind: ChatSessionContextAttachmentKind;
  name: string;
  parent?: string;
}

export interface ChatSessionMediaAssetAttachment extends MediaAssetReference {
  id: string;
  name: string;
}

export type ChatSessionContextAttachment =
  | ChatSessionPathContextAttachment
  | ChatSessionMediaAssetAttachment;

export const isPathContextAttachment = (
  attachment: ChatSessionContextAttachment,
): attachment is ChatSessionPathContextAttachment =>
  attachment.source === "path";

export const isMediaAssetContextAttachment = (
  attachment: ChatSessionContextAttachment,
): attachment is ChatSessionMediaAssetAttachment =>
  attachment.source === "media-asset";

export interface ChatSessionMessagePromptEnhancement {
  originalContent: string;
}

export type ChatSessionMessagePromptEnhancementMode =
  | "off"
  | "simple"
  | "web-search";

export interface ChatSessionMessageLifecycle {
  kind: "transient";
  owner: "prompt-enhancement" | "task-interview";
  operationId: string;
  slot: "user" | "thinking" | "marker";
  ownerLaunchId: string;
  ownerWindowId: string;
  ownerInstanceId: string;
  placement?: "edit-composer" | "message" | "queued-message";
  targetMessageId?: string;
}

export type ChatSessionTaskOutcomeStatus =
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled"
  | "timed-out"
  | "unsupported"
  | "crashed";

export interface ChatSessionTaskOutcome {
  status: ChatSessionTaskOutcomeStatus;
  reason?: string;
}

export type ChatSessionTaskActionKind = "retry-task" | "continue-task";

export interface ChatSessionTaskAction {
  kind: ChatSessionTaskActionKind;
  objective: string;
}

export interface ChatSessionQueuedPromptEnhancementRequest {
  mode: Exclude<ChatSessionMessagePromptEnhancementMode, "off">;
}

export interface ChatSessionMessageSettings {
  workspace: string | null;
  provider: RuntimeProvider;
  model: string;
  mode?: RunMode;
  reasoning?: ReasoningMode;
  sessionMemoryEnabled: boolean;
  useWorkspaceMemory: boolean;
  useGlobalMemory: boolean;
  uiControlEnabled: boolean;
  promptEnhancementMode: ChatSessionMessagePromptEnhancementMode;
  interviewEnabled: boolean;
}

export interface ChatSessionMessage {
  id: string;
  taskId?: string;
  role: "user" | "agent";
  content: string;
  createdAt?: number;
  taskAction?: ChatSessionTaskAction;
  contextAttachments?: ChatSessionContextAttachment[];
  promptEnhancement?: ChatSessionMessagePromptEnhancement;
  settings?: ChatSessionMessageSettings;
  source?: ChatSessionMessageSource;
  lifecycle?: ChatSessionMessageLifecycle;
  outcome?: ChatSessionTaskOutcome;
}

export const isTransientChatOperationMessage = (
  message: ChatSessionMessage,
): boolean => {
  const lifecycle = message.lifecycle;
  return (
    lifecycle?.kind === "transient" && lifecycle.operationId === message.taskId
  );
};

export const isPromptEnhancementPlaceholderMessage = (
  message: ChatSessionMessage,
): boolean => {
  const lifecycle = message.lifecycle;
  if (
    lifecycle?.kind !== "transient" ||
    lifecycle.owner !== "prompt-enhancement" ||
    lifecycle.operationId !== message.taskId
  ) {
    return false;
  }

  return lifecycle.slot === "user"
    ? message.role === "user"
    : lifecycle.slot === "thinking" &&
        message.role === "agent" &&
        message.source?.kind === "thinking";
};

export const getActivePromptEnhancementEditMessageId = (
  session: ChatSessionRecord,
): string | null => {
  let targetMessageId: string | undefined;

  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    const lifecycle = message.lifecycle;

    if (
      isTransientChatOperationMessage(message) &&
      lifecycle?.owner === "prompt-enhancement" &&
      lifecycle.slot === "marker" &&
      lifecycle.placement === "edit-composer"
    ) {
      targetMessageId = lifecycle.targetMessageId;
      break;
    }
  }

  if (!targetMessageId) {
    return null;
  }

  return session.messages.some(
    (message) =>
      message.id === targetMessageId &&
      message.role === "user" &&
      !isTransientChatOperationMessage(message),
  )
    ? targetMessageId
    : null;
};

export interface ChatSessionRecord {
  id: string;
  createdAt: number;
  updatedAt: number;
  draftUpdatedAt: number;
  draftAttachmentsUpdatedAt: number;
  draftAttachmentAddedAt?: Record<string, number>;
  draftAttachmentTombstones?: Record<string, number>;
  messageTombstones?: Record<string, number>;
  historyClearedAt?: number;
  lastReadAt?: number;
  archivedAt?: number;
  pinnedAt?: number;
  timeResetAt?: number;
  movedToTopAt?: number;
  specialSession?: ChatSessionSpecialKind;
  workspace: string | null;
  provider: RuntimeProvider;
  model: string;
  mode?: RunMode;
  reasoning?: ReasoningMode;
  draft: string;
  draftContextAttachments: ChatSessionContextAttachment[];
  manualTitle?: string;
  tags: string[];
  messages: ChatSessionMessage[];
  promptHistory: string[];
  promptContextHistory: ChatSessionContextAttachment[][];
  sessionMemoryEnabled: boolean;
  useWorkspaceMemory?: boolean;
  useGlobalMemory: boolean;
  uiControlEnabled: boolean;
  sessionMemory: ConversationMemoryEntry[];
}

export interface ShellVoiceSettings {
  autoSpeakResponses: boolean;
  preferredVoiceURI?: string;
  rate: number;
}

export interface SmartContextPackVariable {
  name: string;
  defaultValue?: string;
}

export interface SmartContextPackTrigger {
  phrases: string[];
  pathPatterns: string[];
}

export type SmartContextPackSettingOverrides = Partial<
  Pick<
    ChatSessionMessageSettings,
    | "provider"
    | "model"
    | "mode"
    | "reasoning"
    | "promptEnhancementMode"
    | "interviewEnabled"
    | "sessionMemoryEnabled"
    | "useWorkspaceMemory"
    | "useGlobalMemory"
    | "uiControlEnabled"
  >
>;

export interface SmartContextPack extends SmartContextPackSettingOverrides {
  id: string;
  workspace: string | null;
  name: string;
  instructions: string;
  prompt: string;
  contextAttachments: ChatSessionContextAttachment[];
  variables: SmartContextPackVariable[];
  trigger: SmartContextPackTrigger;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
}

export interface ChatSessionQueuedMessage {
  id: string;
  sessionId: string;
  task: string;
  visibleMessageContent?: string;
  promptHistoryContent?: string;
  promptEnhancement?: ChatSessionMessagePromptEnhancement;
  promptEnhancementRequest?: ChatSessionQueuedPromptEnhancementRequest;
  dispatchPolicy: "after-success" | "after-terminal";
  blockedByTaskId?: string;
  contentUpdatedAt: number;
  attachmentsUpdatedAt: number;
  attachmentTombstones: Record<string, number>;
  blockerUpdatedAt: number;
  orderRank: number;
  orderUpdatedAt: number;
  status: "queued" | "enhancing" | "dispatching" | "failed";
  statusUpdatedAt: number;
  failureMessage?: string;
  contextAttachments: ChatSessionContextAttachment[];
  createdAt: number;
  updatedAt: number;
}

export type SessionOverviewStatus =
  | "empty"
  | "running"
  | "done"
  | "failed"
  | "blocked"
  | "cancelled"
  | "timed-out"
  | "unsupported"
  | "crashed";

export const INTERRUPTED_TASK_CRASH_PREFIX = "**Task crashed.**";

export interface ShellPersistedState {
  version: 2;
  activeSessionId: string;
  activeSessionUpdatedAt: number;
  sessions: ChatSessionRecord[];
  sessionTombstones?: Record<string, number>;
  queuedSessionMessages: ChatSessionQueuedMessage[];
  queuedMessageTombstones: Record<string, number>;
  handledFleetCommandIds: string[];
  contextPacks: SmartContextPack[];
  recentWorkspaces: string[];
  voice: ShellVoiceSettings;
  lastSelectedProvider: RuntimeProvider;
  lastSelectedModelByProvider: Partial<Record<RuntimeProvider, string>>;
  lastSelectedMode?: RunMode;
  lastSelectedReasoning?: ReasoningMode;
  lastSelectedSessionMemoryEnabled: boolean;
  lastSelectedUseWorkspaceMemory: boolean;
  lastSelectedUseGlobalMemory: boolean;
  lastSelectedUiControlEnabled: boolean;
  fleetManagedSettings?: FleetManagedSettingsState;
  lastRecoveredLaunchId?: string;
}

export interface FleetManagedSettingsState {
  managerId: string;
  profileId: string;
  revision: number;
  instructionProfileIds: Record<string, string>;
  contextPackIds: string[];
  secretIds: string[];
  appliedAt: number;
}

const DEFAULT_PROVIDER: RuntimeProvider = "openai";
const DEFAULT_VOICE_RATE = 1;
const MIN_VOICE_RATE = 0.8;
const MAX_VOICE_RATE = 1.4;
const SPECIAL_SESSION_KINDS = ["quick-voice"] as const;
const RUN_MODES: RunMode[] = ["ask", "machdoch"];
const STORED_REASONING_MODES: ReasoningMode[] = [...REASONING_MODES];
const RUNTIME_PROVIDERS: RuntimeProvider[] = [...RUNNABLE_PROVIDER_ORDER];
const TASK_EXECUTION_STATUSES: TaskExecutionStatus[] = [
  "planned",
  "executed",
  "blocked",
  "cancelled",
  "unsupported",
];
const TASK_OUTCOME_STATUSES: ChatSessionTaskOutcomeStatus[] = [
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "timed-out",
  "unsupported",
  "crashed",
];
const TASK_PANEL_TONES: TaskPanelTone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
];
const THINKING_STATUSES: TaskThinkingTrace["status"][] = [
  "running",
  "complete",
];
const MODEL_STREAM_KINDS: TaskThinkingModelStream["kind"][] = [
  "assistant",
  "tool-call",
  "reasoning",
  "status",
  "tool-result",
];
const THINKING_TIMELINE_EVENT_KINDS: TaskThinkingTimelineEvent["kind"][] = [
  "state",
  "model-call",
  "tool-call",
  "retry",
  "validator",
  "output",
];
const THINKING_TIMELINE_EVENT_PHASES: TaskThinkingTimelineEvent["phase"][] = [
  "started",
  "streaming",
  "completed",
  "failed",
  "skipped",
  "usage",
  "passed",
  "requested-continuation",
  "rejected",
];
const THINKING_TIMELINE_EVENT_LIMIT = 120;
const COMPLETED_THINKING_ACTION_OUTPUT_LINE_LIMIT = 20;
const COMPLETED_THINKING_TIMELINE_EVENT_LIMIT = 40;
const EXECUTION_SECTION_LIMIT = 40;
const EXECUTION_SECTION_LINE_LIMIT = 80;
const EXECUTION_SECTION_LINE_LENGTH_LIMIT = 1_000;
const PERSISTED_MESSAGE_CONTENT_LIMIT = 128_000;
const PERSISTED_TEXT_TRUNCATION_MARKER =
  "\n\n[content truncated by machdoch to keep session storage bounded]";
const PERSISTED_VISIBLE_MESSAGE_LIMIT = 400;
const PROMPT_HISTORY_ENTRY_LIMIT = 100;
const PROMPT_HISTORY_ENTRY_LENGTH_LIMIT = 8_000;
const EXECUTION_RESPONSE_MARKDOWN_LIMIT = 32_000;
const MAX_SESSION_TAGS = 12;
const MAX_SESSION_TAG_LENGTH = 32;
const MAX_CONTEXT_PACK_NAME_LENGTH = 72;
const MAX_CONTEXT_PACK_VARIABLES = 12;
const MAX_CONTEXT_PACK_VARIABLE_LENGTH = 40;
const MAX_CONTEXT_PACK_TRIGGERS = 16;
const MAX_CONTEXT_PACK_TRIGGER_LENGTH = 96;
const MAX_CONTEXT_PACK_TEXT_LENGTH = 8_000;
const SESSION_RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECENT_WORKSPACES = 10;
const CONTEXT_ATTACHMENT_KINDS: ChatSessionContextAttachmentKind[] = [
  "file",
  "directory",
  "image",
  "other",
];
const MESSAGE_PROMPT_ENHANCEMENT_MODES: ChatSessionMessagePromptEnhancementMode[] =
  ["off", "simple", "web-search"];

export const QUICK_VOICE_SESSION_KIND: ChatSessionSpecialKind = "quick-voice";
export const MAX_SMART_CONTEXT_PACKS = 160;

const clampVoiceRate = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_VOICE_RATE;
  }

  return Math.min(MAX_VOICE_RATE, Math.max(MIN_VOICE_RATE, value));
};

export const createDefaultShellVoiceSettings = (): ShellVoiceSettings => {
  return {
    autoSpeakResponses: false,
    rate: DEFAULT_VOICE_RATE,
  };
};

const isRunMode = (value: unknown): value is RunMode => {
  return typeof value === "string" && RUN_MODES.includes(value as RunMode);
};

const normalizeStoredRunMode = (
  value: unknown,
  fallback: RunMode = "machdoch",
): RunMode => (isRunMode(value) ? value : fallback);

const normalizeOptionalStoredRunMode = (
  value: unknown,
): RunMode | undefined => {
  return isRunMode(value) ? value : undefined;
};

const normalizeOptionalStoredReasoningMode = (
  value: unknown,
): ReasoningMode | undefined => {
  return typeof value === "string" &&
    STORED_REASONING_MODES.includes(value as ReasoningMode)
    ? (value as ReasoningMode)
    : undefined;
};

const normalizeOptionalPromptEnhancementMode = (
  value: unknown,
): ChatSessionMessagePromptEnhancementMode | undefined => {
  return typeof value === "string" &&
    MESSAGE_PROMPT_ENHANCEMENT_MODES.includes(
      value as ChatSessionMessagePromptEnhancementMode,
    )
    ? (value as ChatSessionMessagePromptEnhancementMode)
    : undefined;
};

const normalizeOptionalBoolean = (value: unknown): boolean | undefined => {
  return typeof value === "boolean" ? value : undefined;
};

const normalizeFleetManagedSettingsState = (
  value: unknown,
): FleetManagedSettingsState | undefined => {
  if (!isRecord(value)) return undefined;
  const managerId = normalizeString(value.managerId).trim();
  const profileId = normalizeString(value.profileId).trim();
  const revision = normalizeOptionalFiniteNumber(value.revision);
  const appliedAt = normalizeOptionalFiniteNumber(value.appliedAt);
  if (
    !managerId ||
    !profileId ||
    revision === undefined ||
    appliedAt === undefined
  ) {
    return undefined;
  }
  const instructionProfileIds = isRecord(value.instructionProfileIds)
    ? Object.fromEntries(
        Object.entries(value.instructionProfileIds).flatMap(
          ([managedId, localId]) =>
            managedId.trim() && typeof localId === "string" && localId.trim()
              ? [[managedId.trim(), localId.trim()] as const]
              : [],
        ),
      )
    : {};
  const normalizeIds = (candidate: unknown): string[] =>
    Array.isArray(candidate)
      ? [
          ...new Set(
            candidate
              .filter((entry): entry is string => typeof entry === "string")
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        ]
      : [];

  return {
    managerId,
    profileId,
    revision: Math.max(0, Math.round(revision)),
    instructionProfileIds,
    contextPackIds: normalizeIds(value.contextPackIds),
    secretIds: normalizeIds(value.secretIds),
    appliedAt: Math.max(0, appliedAt),
  };
};

const isRuntimeProvider = (value: unknown): value is RuntimeProvider => {
  return (
    typeof value === "string" &&
    RUNTIME_PROVIDERS.includes(value as RuntimeProvider)
  );
};

const isTaskExecutionStatus = (
  value: unknown,
): value is TaskExecutionStatus => {
  return (
    typeof value === "string" &&
    TASK_EXECUTION_STATUSES.includes(value as TaskExecutionStatus)
  );
};

const normalizeTaskExecutionStatus = (value: unknown): TaskExecutionStatus => {
  if (isTaskExecutionStatus(value)) {
    return value;
  }

  return "unsupported";
};

const isTaskPanelTone = (value: unknown): value is TaskPanelTone => {
  return (
    typeof value === "string" &&
    TASK_PANEL_TONES.includes(value as TaskPanelTone)
  );
};

const isToolName = (value: unknown): value is ToolName => {
  return typeof value === "string" && VALID_TOOLS.includes(value as ToolName);
};

const isSpecialSessionKind = (
  value: unknown,
): value is ChatSessionSpecialKind => {
  return (
    typeof value === "string" &&
    SPECIAL_SESSION_KINDS.includes(value as ChatSessionSpecialKind)
  );
};

const isContextAttachmentKind = (
  value: unknown,
): value is ChatSessionContextAttachmentKind => {
  return (
    typeof value === "string" &&
    CONTEXT_ATTACHMENT_KINDS.includes(value as ChatSessionContextAttachmentKind)
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const normalizeString = (value: unknown, fallback = ""): string => {
  return typeof value === "string" ? value : fallback;
};

const normalizeFiniteNumber = (value: unknown, fallback = 0): number => {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

const normalizeOptionalFiniteNumber = (value: unknown): number | undefined => {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
};

const normalizeTimestampRecord = (
  value: unknown,
  maxEntries = 2_048,
): Record<string, number> => {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .flatMap(([rawId, rawTimestamp]) => {
        const id = rawId.trim();
        const timestamp = normalizeOptionalFiniteNumber(rawTimestamp);

        return id && timestamp !== undefined
          ? ([[id, Math.max(0, timestamp)]] as const)
          : [];
      })
      .sort((left, right) => right[1] - left[1])
      .slice(0, maxEntries),
  );
};

const normalizeStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string");
};

const createWorkspaceHistoryKey = (workspace: string): string => {
  return createWorkspaceRootKey(workspace);
};

export const normalizeRecentWorkspaces = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const workspaces: string[] = [];
  const seenWorkspaces = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const workspace = entry.trim();
    const workspaceKey = createWorkspaceHistoryKey(workspace);

    if (!workspace || seenWorkspaces.has(workspaceKey)) {
      continue;
    }

    seenWorkspaces.add(workspaceKey);
    workspaces.push(workspace);

    if (workspaces.length >= MAX_RECENT_WORKSPACES) {
      break;
    }
  }

  return workspaces;
};

export const rememberRecentWorkspace = (
  recentWorkspaces: readonly string[],
  workspace: string | null | undefined,
): string[] => {
  const normalizedWorkspace = workspace?.trim();

  if (!normalizedWorkspace) {
    return normalizeRecentWorkspaces(recentWorkspaces);
  }

  const workspaceKey = createWorkspaceHistoryKey(normalizedWorkspace);
  const previousWorkspaces = normalizeRecentWorkspaces(recentWorkspaces).filter(
    (entry) => createWorkspaceHistoryKey(entry) !== workspaceKey,
  );

  return normalizeRecentWorkspaces([
    normalizedWorkspace,
    ...previousWorkspaces,
  ]);
};

export const removeRecentWorkspace = (
  recentWorkspaces: readonly string[],
  workspace: string | null | undefined,
): string[] => {
  const normalizedWorkspace = workspace?.trim();

  if (!normalizedWorkspace) {
    return normalizeRecentWorkspaces(recentWorkspaces);
  }

  const workspaceKey = createWorkspaceHistoryKey(normalizedWorkspace);

  return normalizeRecentWorkspaces(
    recentWorkspaces.filter(
      (entry) => createWorkspaceHistoryKey(entry) !== workspaceKey,
    ),
  );
};

export const mergeRecentWorkspaces = (
  ...workspaceLists: ReadonlyArray<readonly string[]>
): string[] => {
  const mergedWorkspaces: string[] = [];

  for (const workspaceList of workspaceLists) {
    mergedWorkspaces.push(...workspaceList);
  }

  return normalizeRecentWorkspaces(mergedWorkspaces);
};

export const mergeRecentWorkspacesForPersistence = (
  localWorkspaces: readonly string[],
  baseWorkspaces: readonly string[],
  latestWorkspaces: readonly string[],
): string[] => {
  const localRecentWorkspaces = normalizeRecentWorkspaces(localWorkspaces);
  const localWorkspaceKeys = new Set(
    localRecentWorkspaces.map(createWorkspaceHistoryKey),
  );
  const removedBaseWorkspaceKeys = new Set(
    normalizeRecentWorkspaces(baseWorkspaces)
      .filter(
        (workspace) =>
          !localWorkspaceKeys.has(createWorkspaceHistoryKey(workspace)),
      )
      .map(createWorkspaceHistoryKey),
  );
  const latestWorkspacesWithLocalRemovals = normalizeRecentWorkspaces(
    latestWorkspaces,
  ).filter(
    (workspace) =>
      !removedBaseWorkspaceKeys.has(createWorkspaceHistoryKey(workspace)),
  );

  return mergeRecentWorkspaces(
    localRecentWorkspaces,
    latestWorkspacesWithLocalRemovals,
  );
};

const normalizeToolNames = (value: unknown): ToolName[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter(isToolName))];
};

const normalizeStringRecord = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) {
    return {};
  }

  const normalized: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      normalized[key] = entry;
    }
  }

  return normalized;
};

const getFallbackAttachmentName = (path: string): string => {
  const name = path.replace(/\\/gu, "/").split("/").filter(Boolean).at(-1);

  return name?.trim() || path;
};

const normalizeTimeoutDuration = (
  value: unknown,
): number | null | undefined => {
  if (value === null) {
    return null;
  }

  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : undefined;
};

const normalizeTaskExecutionTimeoutState = (
  value: unknown,
): TaskExecutionTimeoutState | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const startedAt = normalizeOptionalFiniteNumber(value.startedAt);
  const lastActivityAt = normalizeOptionalFiniteNumber(value.lastActivityAt);
  const idleTimeoutMs = normalizeTimeoutDuration(value.idleTimeoutMs);
  const absoluteTimeoutMs = normalizeTimeoutDuration(value.absoluteTimeoutMs);

  if (
    startedAt === undefined ||
    lastActivityAt === undefined ||
    idleTimeoutMs === undefined ||
    absoluteTimeoutMs === undefined
  ) {
    return undefined;
  }

  const normalizedStartedAt = Math.max(0, startedAt);

  return {
    startedAt: normalizedStartedAt,
    lastActivityAt: Math.max(normalizedStartedAt, lastActivityAt),
    idleTimeoutMs,
    absoluteTimeoutMs,
  };
};

const MEDIA_ASSET_KINDS = new Set<MediaAssetKind>([
  "prompt",
  "image",
  "alpha-matte",
  "report",
  "collection",
]);

const isMediaAssetKind = (value: unknown): value is MediaAssetKind =>
  typeof value === "string" && MEDIA_ASSET_KINDS.has(value as MediaAssetKind);

const isMediaAssetRendition = (
  value: unknown,
): value is NonNullable<MediaAssetReference["rendition"]> =>
  value === "thumbnail" || value === "preview" || value === "original";

const normalizeContextAttachments = (
  value: unknown,
  idPrefix: string,
): ChatSessionContextAttachment[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenAttachmentKeys = new Set<string>();
  const attachments: ChatSessionContextAttachment[] = [];

  for (const [index, entry] of value.entries()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const candidate = entry as Record<string, unknown>;
    if (candidate.source === "media-asset") {
      const workspaceRoot =
        typeof candidate.workspaceRoot === "string"
          ? candidate.workspaceRoot.trim()
          : "";
      const assetId =
        typeof candidate.assetId === "string" ? candidate.assetId.trim() : "";
      if (!workspaceRoot || !assetId || !isMediaAssetKind(candidate.kind)) {
        continue;
      }
      const dedupeKey = `media:${workspaceRoot.toLowerCase()}:${assetId}`;
      if (seenAttachmentKeys.has(dedupeKey)) {
        continue;
      }
      seenAttachmentKeys.add(dedupeKey);
      const displayName =
        typeof candidate.displayName === "string" &&
        candidate.displayName.trim()
          ? candidate.displayName.trim()
          : undefined;
      attachments.push({
        id:
          typeof candidate.id === "string" && candidate.id.trim()
            ? candidate.id.trim()
            : `${idPrefix}-${index}`,
        source: "media-asset",
        workspaceRoot,
        assetId,
        kind: candidate.kind,
        name:
          typeof candidate.name === "string" && candidate.name.trim()
            ? candidate.name.trim()
            : (displayName ?? `Media asset ${assetId.slice(0, 12)}`),
        ...(displayName ? { displayName } : {}),
        ...(isMediaAssetRendition(candidate.rendition)
          ? { rendition: candidate.rendition }
          : {}),
      });
      continue;
    }
    if (candidate.source !== "path") {
      continue;
    }
    const path =
      typeof candidate.path === "string" ? candidate.path.trim() : "";

    if (!path) {
      continue;
    }

    const dedupeKey = path.toLowerCase();

    if (seenAttachmentKeys.has(dedupeKey)) {
      continue;
    }

    seenAttachmentKeys.add(dedupeKey);
    attachments.push({
      id:
        typeof candidate.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : `${idPrefix}-${index}`,
      source: "path",
      path,
      kind: isContextAttachmentKind(candidate.kind) ? candidate.kind : "other",
      name:
        typeof candidate.name === "string" && candidate.name.trim()
          ? candidate.name.trim()
          : getFallbackAttachmentName(path),
      ...(typeof candidate.parent === "string" && candidate.parent.trim()
        ? { parent: candidate.parent.trim() }
        : {}),
    });
  }

  return attachments;
};

const normalizePromptContextHistory = (
  value: unknown,
): ChatSessionContextAttachment[][] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry, index) =>
    normalizeContextAttachments(entry, `history-context-${index}`),
  );
};

const normalizeContextPackText = (value: unknown): string => {
  return typeof value === "string"
    ? value.trim().slice(0, MAX_CONTEXT_PACK_TEXT_LENGTH)
    : "";
};

const normalizeContextPackToken = (
  value: unknown,
  maxLength: number,
): string => {
  return typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim().slice(0, maxLength)
    : "";
};

const normalizeContextPackTokenArray = (
  value: unknown,
  options: { limit: number; maxLength: number },
): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const tokens: string[] = [];
  const seenTokens = new Set<string>();

  for (const entry of value) {
    const token = normalizeContextPackToken(entry, options.maxLength);
    const key = token.toLowerCase();

    if (!token || seenTokens.has(key)) {
      continue;
    }

    seenTokens.add(key);
    tokens.push(token);

    if (tokens.length >= options.limit) {
      break;
    }
  }

  return tokens;
};

const normalizeContextPackVariableName = (value: unknown): string => {
  const name = normalizeContextPackToken(
    value,
    MAX_CONTEXT_PACK_VARIABLE_LENGTH,
  )
    .replace(/^\{|\}$/gu, "")
    .replace(/[^A-Za-z0-9_-]/gu, "_");

  return /^[A-Za-z]/u.test(name) ? name : "";
};

const normalizeContextPackVariables = (
  value: unknown,
): SmartContextPackVariable[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const variables: SmartContextPackVariable[] = [];
  const seenVariables = new Set<string>();

  for (const entry of value) {
    const candidate: Record<string, unknown> = isRecord(entry)
      ? entry
      : { name: entry };
    const name = normalizeContextPackVariableName(candidate.name);
    const key = name.toLowerCase();

    if (!name || seenVariables.has(key)) {
      continue;
    }

    seenVariables.add(key);

    const defaultValue = normalizeContextPackToken(
      candidate.defaultValue,
      MAX_CONTEXT_PACK_TRIGGER_LENGTH,
    );

    variables.push({
      name,
      ...(defaultValue ? { defaultValue } : {}),
    });

    if (variables.length >= MAX_CONTEXT_PACK_VARIABLES) {
      break;
    }
  }

  return variables;
};

const normalizeContextPackTrigger = (
  value: unknown,
): SmartContextPackTrigger => {
  const candidate = isRecord(value) ? value : {};

  return {
    phrases: normalizeContextPackTokenArray(candidate.phrases, {
      limit: MAX_CONTEXT_PACK_TRIGGERS,
      maxLength: MAX_CONTEXT_PACK_TRIGGER_LENGTH,
    }),
    pathPatterns: normalizeContextPackTokenArray(candidate.pathPatterns, {
      limit: MAX_CONTEXT_PACK_TRIGGERS,
      maxLength: MAX_CONTEXT_PACK_TRIGGER_LENGTH,
    }),
  };
};

const normalizeSmartContextPacks = (value: unknown): SmartContextPack[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const seenIds = new Set<string>();
  const packs: SmartContextPack[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      continue;
    }

    const idCandidate = normalizeString(entry.id).trim();
    const id = idCandidate || `context-pack-${index}`;

    if (seenIds.has(id)) {
      continue;
    }

    seenIds.add(id);

    const rawName = normalizeString(entry.name).replace(/\s+/gu, " ").trim();
    const name =
      rawName.slice(0, MAX_CONTEXT_PACK_NAME_LENGTH) ||
      `Context pack ${index + 1}`;
    const workspaceCandidate = normalizeString(entry.workspace).trim();
    const provider = isRuntimeProvider(entry.provider)
      ? entry.provider
      : undefined;
    const model =
      provider && normalizeString(entry.model).trim()
        ? normalizeString(entry.model).trim()
        : undefined;
    const mode = normalizeOptionalStoredRunMode(entry.mode);
    const reasoning = normalizeOptionalStoredReasoningMode(entry.reasoning);
    const promptEnhancementMode = normalizeOptionalPromptEnhancementMode(
      entry.promptEnhancementMode,
    );
    const interviewEnabled = normalizeOptionalBoolean(entry.interviewEnabled);
    const sessionMemoryEnabled = normalizeOptionalBoolean(
      entry.sessionMemoryEnabled,
    );
    const useWorkspaceMemory = normalizeOptionalBoolean(
      entry.useWorkspaceMemory,
    );
    const useGlobalMemory = normalizeOptionalBoolean(entry.useGlobalMemory);
    const uiControlEnabled = normalizeOptionalBoolean(entry.uiControlEnabled);
    const createdAt = Math.max(0, normalizeFiniteNumber(entry.createdAt, 0));
    const updatedAt = Math.max(
      createdAt,
      normalizeFiniteNumber(entry.updatedAt, createdAt),
    );
    const lastUsedAt = normalizeOptionalFiniteNumber(entry.lastUsedAt);

    packs.push({
      id,
      workspace: workspaceCandidate || null,
      name,
      instructions: normalizeContextPackText(entry.instructions),
      prompt: normalizeContextPackText(entry.prompt),
      contextAttachments: normalizeContextAttachments(
        entry.contextAttachments,
        `context-pack-${id}`,
      ),
      variables: normalizeContextPackVariables(entry.variables),
      trigger: normalizeContextPackTrigger(entry.trigger),
      ...(provider ? { provider } : {}),
      ...(provider && model ? { model } : {}),
      ...(mode ? { mode } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(promptEnhancementMode !== undefined ? { promptEnhancementMode } : {}),
      ...(interviewEnabled !== undefined ? { interviewEnabled } : {}),
      ...(sessionMemoryEnabled !== undefined ? { sessionMemoryEnabled } : {}),
      ...(useWorkspaceMemory !== undefined ? { useWorkspaceMemory } : {}),
      ...(useGlobalMemory !== undefined ? { useGlobalMemory } : {}),
      ...(uiControlEnabled !== undefined ? { uiControlEnabled } : {}),
      createdAt,
      updatedAt,
      ...(lastUsedAt !== undefined && lastUsedAt >= 0 ? { lastUsedAt } : {}),
      useCount: Math.max(0, normalizeFiniteNumber(entry.useCount, 0)),
    });

    if (packs.length >= MAX_SMART_CONTEXT_PACKS) {
      break;
    }
  }

  return packs.sort((left, right) => {
    const leftTimestamp = Math.max(left.lastUsedAt ?? 0, left.updatedAt);
    const rightTimestamp = Math.max(right.lastUsedAt ?? 0, right.updatedAt);

    return rightTimestamp - leftTimestamp;
  });
};

export const normalizeSessionTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const tags: string[] = [];
  const seenTags = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const tag = entry
      .replace(/^#+/u, "")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, MAX_SESSION_TAG_LENGTH);
    const dedupeKey = tag.toLowerCase();

    if (!tag || seenTags.has(dedupeKey)) {
      continue;
    }

    seenTags.add(dedupeKey);
    tags.push(tag);

    if (tags.length >= MAX_SESSION_TAGS) {
      break;
    }
  }

  return tags;
};

export const createSession = (
  overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord => {
  const provider = overrides.provider ?? DEFAULT_PROVIDER;
  const requestedUpdatedAt = overrides.updatedAt ?? Date.now();
  const createdAt = overrides.createdAt ?? requestedUpdatedAt;
  const draftUpdatedAt = Math.max(
    createdAt,
    normalizeFiniteNumber(overrides.draftUpdatedAt, requestedUpdatedAt),
  );
  const draftAttachmentsUpdatedAt = Math.max(
    createdAt,
    normalizeFiniteNumber(
      overrides.draftAttachmentsUpdatedAt,
      requestedUpdatedAt,
    ),
  );
  const draftContextAttachments = overrides.draftContextAttachments ?? [];
  const draftAttachmentAddedAt = normalizeTimestampRecord(
    overrides.draftAttachmentAddedAt,
  );

  for (const attachment of draftContextAttachments) {
    if (draftAttachmentAddedAt[attachment.id] === undefined) {
      draftAttachmentAddedAt[attachment.id] = draftAttachmentsUpdatedAt;
    }
  }

  const draftAttachmentTombstones = normalizeTimestampRecord(
    overrides.draftAttachmentTombstones,
  );
  const messageTombstones = normalizeTimestampRecord(
    overrides.messageTombstones,
  );
  const now = Math.max(
    requestedUpdatedAt,
    draftUpdatedAt,
    draftAttachmentsUpdatedAt,
    overrides.timeResetAt ?? 0,
    overrides.movedToTopAt ?? 0,
    ...Object.values(draftAttachmentAddedAt),
    ...Object.values(draftAttachmentTombstones),
  );
  const historyClearedAt = normalizeOptionalFiniteNumber(
    overrides.historyClearedAt,
  );
  const mode = normalizeOptionalStoredRunMode(overrides.mode);
  const reasoning = normalizeOptionalStoredReasoningMode(overrides.reasoning);
  const specialSession = isSpecialSessionKind(overrides.specialSession)
    ? overrides.specialSession
    : undefined;
  const isQuickTaskSession = specialSession === QUICK_VOICE_SESSION_KIND;

  return {
    id: overrides.id ?? crypto.randomUUID(),
    createdAt,
    updatedAt: now,
    draftUpdatedAt,
    draftAttachmentsUpdatedAt,
    draftAttachmentAddedAt,
    draftAttachmentTombstones,
    messageTombstones,
    ...(historyClearedAt !== undefined ? { historyClearedAt } : {}),
    lastReadAt:
      typeof overrides.lastReadAt === "number" ? overrides.lastReadAt : now,
    ...(typeof overrides.archivedAt === "number"
      ? { archivedAt: overrides.archivedAt }
      : {}),
    ...(typeof overrides.pinnedAt === "number"
      ? { pinnedAt: overrides.pinnedAt }
      : {}),
    ...(typeof overrides.timeResetAt === "number"
      ? { timeResetAt: overrides.timeResetAt }
      : {}),
    ...(typeof overrides.movedToTopAt === "number"
      ? { movedToTopAt: overrides.movedToTopAt }
      : {}),
    ...(specialSession ? { specialSession } : {}),
    workspace: overrides.workspace ?? null,
    provider,
    model: overrides.model ?? getDefaultModelForProvider(provider),
    ...(mode ? { mode } : {}),
    ...(reasoning ? { reasoning } : {}),
    draft: overrides.draft ?? "",
    draftContextAttachments,
    ...(overrides.manualTitle ? { manualTitle: overrides.manualTitle } : {}),
    tags: normalizeSessionTags(overrides.tags),
    messages: (overrides.messages ?? []).filter(
      (message) => messageTombstones[message.id] === undefined,
    ),
    promptHistory: overrides.promptHistory ?? [],
    promptContextHistory: overrides.promptContextHistory ?? [],
    sessionMemoryEnabled: isQuickTaskSession
      ? false
      : (overrides.sessionMemoryEnabled ?? true),
    useWorkspaceMemory: overrides.useWorkspaceMemory ?? true,
    useGlobalMemory: overrides.useGlobalMemory ?? true,
    uiControlEnabled: overrides.uiControlEnabled ?? false,
    sessionMemory: isQuickTaskSession ? [] : (overrides.sessionMemory ?? []),
  };
};

export const getSessionTitle = (session: ChatSessionRecord): string => {
  if (session.specialSession === QUICK_VOICE_SESSION_KIND) {
    return "Quick Chat";
  }

  if (session.manualTitle?.trim()) {
    return session.manualTitle.trim();
  }

  const firstUserMessage = session.messages.find(
    (message) => message.role === "user" && message.content.trim().length > 0,
  );

  if (!firstUserMessage) {
    return "New session";
  }

  const normalized = firstUserMessage.content.trim();

  if (normalized.length <= 48) {
    return normalized;
  }

  return `${normalized.slice(0, 45)}â€¦`;
};

export const createInitialShellState = (): ShellPersistedState => {
  const initialSession = createSession();

  return {
    version: 2,
    activeSessionId: initialSession.id,
    activeSessionUpdatedAt: 0,
    sessions: [initialSession],
    sessionTombstones: {},
    queuedSessionMessages: [],
    queuedMessageTombstones: {},
    handledFleetCommandIds: [],
    contextPacks: [],
    recentWorkspaces: [],
    voice: createDefaultShellVoiceSettings(),
    lastSelectedProvider: DEFAULT_PROVIDER,
    lastSelectedModelByProvider: {
      openai: getDefaultModelForProvider("openai"),
      anthropic: getDefaultModelForProvider("anthropic"),
      google: getDefaultModelForProvider("google"),
    },
    lastSelectedSessionMemoryEnabled: true,
    lastSelectedUseWorkspaceMemory: true,
    lastSelectedUseGlobalMemory: true,
    lastSelectedUiControlEnabled: false,
  };
};

const normalizePromptHistoryEntries = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalizedEntries: string[] = [];

  for (const entry of value) {
    if (typeof entry === "string") {
      normalizedEntries.push(entry.slice(0, PROMPT_HISTORY_ENTRY_LENGTH_LIMIT));
    }
  }

  return normalizedEntries.slice(-PROMPT_HISTORY_ENTRY_LIMIT);
};

const truncatePersistedText = (value: string): string => {
  if (value.length <= PERSISTED_MESSAGE_CONTENT_LIMIT) {
    return value;
  }

  return `${value.slice(
    0,
    PERSISTED_MESSAGE_CONTENT_LIMIT - PERSISTED_TEXT_TRUNCATION_MARKER.length,
  )}${PERSISTED_TEXT_TRUNCATION_MARKER}`;
};

const normalizeTaskSuggestions = (
  value: unknown,
): TaskRunPreview["suggestedPrompts"] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((entry, index) => {
    const scope =
      entry.scope === "user" ||
      entry.scope === "workspace" ||
      entry.scope === "github"
        ? entry.scope
        : undefined;

    return {
      name: normalizeString(entry.name, `Suggestion ${index + 1}`),
      path: normalizeString(entry.path),
      ...(scope ? { scope } : {}),
      score: normalizeFiniteNumber(entry.score),
      reason: normalizeString(entry.reason),
    };
  });
};

const normalizeTaskPlanSteps = (value: unknown): TaskRunPreview["steps"] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((entry, index) => ({
    title: normalizeString(entry.title, `Step ${index + 1}`),
    description: normalizeString(entry.description),
  }));
};

const normalizeResolvedPromptInvocation = (
  value: unknown,
): TaskRunPreview["invokedPrompt"] => {
  if (!isRecord(value)) {
    return undefined;
  }

  const name = normalizeString(value.name).trim();

  if (!name) {
    return undefined;
  }

  return {
    path: normalizeString(value.path),
    name,
    body: normalizeString(value.body),
    tools: normalizeToolNames(value.tools),
    inputs: normalizeStringArray(value.inputs),
    arguments: normalizeString(value.arguments),
    expectedInputs: normalizeStringArray(value.expectedInputs),
    missingInputs: normalizeStringArray(value.missingInputs),
    inputValues: normalizeStringRecord(value.inputValues),
    resolvedBody: normalizeString(
      value.resolvedBody,
      normalizeString(value.body),
    ),
    ...(normalizeChatSessionOptionalString(value.description)
      ? { description: normalizeChatSessionOptionalString(value.description) }
      : {}),
    ...(normalizeChatSessionOptionalString(value.agent)
      ? { agent: normalizeChatSessionOptionalString(value.agent) }
      : {}),
    ...(normalizeChatSessionOptionalString(value.model)
      ? { model: normalizeChatSessionOptionalString(value.model) }
      : {}),
    ...(normalizeChatSessionOptionalString(value.argumentHint)
      ? { argumentHint: normalizeChatSessionOptionalString(value.argumentHint) }
      : {}),
  };
};

const normalizeCustomizationCounts = (
  value: unknown,
  preview: Pick<TaskRunPreview, "suggestedPrompts" | "suggestedSkills">,
): TaskRunPreview["customizationCounts"] => {
  if (!isRecord(value)) {
    return {
      prompts: preview.suggestedPrompts.length,
      skills: preview.suggestedSkills.length,
    };
  }

  return {
    prompts: normalizeFiniteNumber(
      value.prompts,
      preview.suggestedPrompts.length,
    ),
    skills: normalizeFiniteNumber(value.skills, preview.suggestedSkills.length),
  };
};

const normalizeTaskRunPreview = (
  value: unknown,
  fallbackTask: string,
): TaskRunPreview | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const suggestedPrompts = normalizeTaskSuggestions(value.suggestedPrompts);
  const suggestedSkills = normalizeTaskSuggestions(value.suggestedSkills);
  const previewBase = {
    suggestedPrompts,
    suggestedSkills,
  };

  return {
    task: normalizeString(value.task, fallbackTask || "Untitled task"),
    mode: normalizeStoredRunMode(value.mode),
    summary: normalizeString(
      value.summary,
      "Task preview restored from persisted session.",
    ),
    suggestedTools: normalizeToolNames(value.suggestedTools),
    ...(normalizeResolvedPromptInvocation(value.invokedPrompt)
      ? {
          invokedPrompt: normalizeResolvedPromptInvocation(value.invokedPrompt),
        }
      : {}),
    suggestedPrompts,
    suggestedSkills,
    warnings: normalizeStringArray(value.warnings),
    notes: normalizeStringArray(value.notes),
    steps: normalizeTaskPlanSteps(value.steps),
    customizationCounts: normalizeCustomizationCounts(
      value.customizationCounts,
      previewBase,
    ),
  };
};

const normalizeTaskExecutionSection = (
  value: unknown,
  index: number,
): TaskExecutionSection | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const section: TaskExecutionSection = {
    title: normalizeString(value.title, `Details ${index + 1}`).slice(0, 160),
    lines: normalizeStringArray(value.lines)
      .slice(-EXECUTION_SECTION_LINE_LIMIT)
      .map((line) => line.slice(0, EXECUTION_SECTION_LINE_LENGTH_LIMIT)),
  };

  if (value.audience === "user" || value.audience === "internal") {
    section.audience = value.audience;
  }

  if (isTaskPanelTone(value.tone)) {
    section.tone = value.tone;
  }

  return section;
};

const normalizeTaskExecutionSections = (
  value: unknown,
): TaskExecutionSection[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeTaskExecutionSection)
    .filter((section): section is TaskExecutionSection => section !== undefined)
    .slice(-EXECUTION_SECTION_LIMIT);
};

const normalizeTaskExecutionResponse = (
  value: unknown,
): TaskExecutionNarrative | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const relatedFiles = Array.isArray(value.relatedFiles)
    ? value.relatedFiles
        .filter(isRecord)
        .map((entry) => ({
          path: normalizeString(entry.path),
          description: normalizeString(entry.description),
        }))
        .filter((entry) => entry.path.length > 0)
    : [];

  return {
    markdown: normalizeString(value.markdown).slice(
      0,
      EXECUTION_RESPONSE_MARKDOWN_LIMIT,
    ),
    highlights: normalizeStringArray(value.highlights)
      .slice(0, 20)
      .map((entry) => entry.slice(0, 1_000)),
    relatedFiles: relatedFiles.slice(0, 100),
    verification: normalizeStringArray(value.verification)
      .slice(0, 30)
      .map((entry) => entry.slice(0, 1_000)),
    followUps: normalizeStringArray(value.followUps)
      .slice(0, 20)
      .map((entry) => entry.slice(0, 1_000)),
  };
};

const normalizeNonNegativeInteger = (value: unknown): number | undefined => {
  const normalized = normalizeOptionalFiniteNumber(value);

  return normalized === undefined
    ? undefined
    : Math.max(0, Math.round(normalized));
};

const isTaskExecutionFileChangeOperation = (
  value: unknown,
): value is TaskExecutionFileChangeOperation => {
  return (
    value === "added" ||
    value === "modified" ||
    value === "deleted" ||
    value === "renamed" ||
    value === "type-changed"
  );
};

const isTaskExecutionFileEntryType = (
  value: unknown,
): value is TaskExecutionFileEntryType => {
  return (
    value === "text" ||
    value === "binary" ||
    value === "gitlink" ||
    value === "symlink" ||
    value === "mode"
  );
};

export const normalizeTaskExecutionChangedLineRange = (
  value: unknown,
): TaskExecutionChangedLineRange | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const oldStart = normalizeNonNegativeInteger(value.oldStart);
  const oldLines = normalizeNonNegativeInteger(value.oldLines);
  const newStart = normalizeNonNegativeInteger(value.newStart);
  const newLines = normalizeNonNegativeInteger(value.newLines);

  if (
    oldStart === undefined ||
    oldLines === undefined ||
    newStart === undefined ||
    newLines === undefined
  ) {
    return undefined;
  }

  return { oldStart, oldLines, newStart, newLines };
};

const normalizeTaskExecutionFileLineAnalysis = (
  value: unknown,
): TaskExecutionFileLineAnalysis | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.state === "complete") {
    const additions = normalizeNonNegativeInteger(value.additions);
    const deletions = normalizeNonNegativeInteger(value.deletions);

    return additions === undefined || deletions === undefined
      ? undefined
      : { state: "complete", additions, deletions };
  }

  if (
    value.state === "not-applicable" &&
    (value.reason === "binary" ||
      value.reason === "gitlink" ||
      value.reason === "symlink" ||
      value.reason === "mode-only")
  ) {
    return { state: "not-applicable", reason: value.reason };
  }

  if (value.state === "failed" && value.code === "git-failed") {
    return {
      state: "failed",
      code: value.code,
      message: normalizeString(value.message, "Line analysis failed.").slice(
        0,
        4_000,
      ),
    };
  }

  return undefined;
};

const normalizeFileChangeStage = (
  value: unknown,
): TaskExecutionFileChangeCompleteness["discovery"] | undefined => {
  if (isRecord(value) && value.state === "complete") {
    return { state: "complete" };
  }

  if (isRecord(value) && value.state === "failed") {
    return {
      state: "failed",
      code: normalizeString(value.code, "unknown").slice(0, 100),
      message: normalizeString(
        value.message,
        "File-change stage failed.",
      ).slice(0, 4_000),
    };
  }

  return undefined;
};

export const normalizeTaskExecutionFileChange = (
  value: unknown,
): TaskExecutionFileChange | undefined => {
  if (
    !isRecord(value) ||
    !isTaskExecutionFileChangeOperation(value.operation) ||
    !isTaskExecutionFileEntryType(value.entryType)
  ) {
    return undefined;
  }

  const path = normalizeString(value.path).trim().slice(0, 4_000);
  const oldPath = normalizeString(value.oldPath).trim().slice(0, 4_000);
  const repositoryPath = normalizeString(value.repositoryPath)
    .trim()
    .replace(/\\/gu, "/")
    .slice(0, 4_000);
  const oldMode = normalizeString(value.oldMode).trim().slice(0, 12);
  const newMode = normalizeString(value.newMode).trim().slice(0, 12);
  const lineAnalysis = normalizeTaskExecutionFileLineAnalysis(
    value.lineAnalysis,
  );
  const ranges: TaskExecutionChangedLineRange[] = [];

  if (Array.isArray(value.ranges)) {
    for (const range of value.ranges) {
      const normalizedRange = normalizeTaskExecutionChangedLineRange(range);

      if (normalizedRange) {
        ranges.push(normalizedRange);
      }
    }
  }

  if (!path || !oldMode || !newMode || !lineAnalysis) {
    return undefined;
  }

  const oldObjectId = normalizeString(value.oldObjectId).trim().slice(0, 128);
  const newObjectId = normalizeString(value.newObjectId).trim().slice(0, 128);
  const oldCommit = normalizeString(value.oldCommit).trim().slice(0, 128);
  const newCommit = normalizeString(value.newCommit).trim().slice(0, 128);
  const hunkCount = normalizeNonNegativeInteger(value.hunkCount);
  const storedId = normalizeNonNegativeInteger(value.storedId);

  return {
    path,
    ...(oldPath && oldPath !== path ? { oldPath } : {}),
    operation: value.operation,
    entryType: value.entryType,
    ...(repositoryPath ? { repositoryPath } : {}),
    oldMode,
    newMode,
    ...(oldObjectId ? { oldObjectId } : {}),
    ...(newObjectId ? { newObjectId } : {}),
    ...(oldCommit ? { oldCommit } : {}),
    ...(newCommit ? { newCommit } : {}),
    lineAnalysis,
    ...(ranges.length > 0 ? { ranges } : {}),
    ...(hunkCount !== undefined ? { hunkCount } : {}),
    ...(storedId !== undefined ? { storedId } : {}),
  };
};

export const normalizeTaskExecutionFileChanges = (
  value: unknown,
): TaskExecutionFileChanges | undefined => {
  if (!isRecord(value) || !Array.isArray(value.files)) {
    return undefined;
  }

  const normalizedFiles = new Map<string, TaskExecutionFileChange>();

  for (const entry of value.files) {
    const file = normalizeTaskExecutionFileChange(entry);

    if (!file) {
      continue;
    }
    normalizedFiles.set(
      `${file.repositoryPath ?? "."}\0${file.oldPath ?? ""}\0${file.path}`,
      file,
    );
  }

  const files = Array.from(normalizedFiles.values());
  const totalFiles = normalizeNonNegativeInteger(value.totalFiles);
  const additions = normalizeNonNegativeInteger(value.additions);
  const deletions = normalizeNonNegativeInteger(value.deletions);
  const binaryFiles = normalizeNonNegativeInteger(value.binaryFiles);
  const gitlinkFiles = normalizeNonNegativeInteger(value.gitlinkFiles);
  const symlinkFiles = normalizeNonNegativeInteger(value.symlinkFiles);
  const modeOnlyFiles = normalizeNonNegativeInteger(value.modeOnlyFiles);
  const failedFiles = normalizeNonNegativeInteger(value.failedFiles);
  const repositoryCount = normalizeNonNegativeInteger(value.repositoryCount);

  if (
    totalFiles === undefined ||
    additions === undefined ||
    deletions === undefined ||
    binaryFiles === undefined ||
    gitlinkFiles === undefined ||
    symlinkFiles === undefined ||
    modeOnlyFiles === undefined ||
    failedFiles === undefined ||
    repositoryCount === undefined ||
    totalFiles < files.length ||
    (totalFiles > 0 && repositoryCount === 0) ||
    (value.status !== "complete" &&
      value.status !== "partial" &&
      value.status !== "failed") ||
    value.attribution !== "workspace-observed"
  ) {
    return undefined;
  }

  const normalizedIssues: TaskExecutionFileChangeIssue[] = [];

  if (Array.isArray(value.issues)) {
    for (const entry of value.issues) {
      if (!isRecord(entry)) {
        continue;
      }

      const stage = entry.stage;
      if (
        stage !== "discovery" &&
        stage !== "startSnapshots" &&
        stage !== "finishSnapshots" &&
        stage !== "renameAnalysis" &&
        stage !== "lineAnalysis" &&
        stage !== "persistence"
      ) {
        continue;
      }

      const repositoryPath = normalizeString(entry.repositoryPath)
        .trim()
        .slice(0, 4_000);
      normalizedIssues.push({
        stage,
        code: normalizeString(entry.code, "unknown").slice(0, 100),
        message: normalizeString(
          entry.message,
          "File-change tracking failed.",
        ).slice(0, 4_000),
        ...(repositoryPath ? { repositoryPath } : {}),
      });
    }
  }

  if (totalFiles === 0 && normalizedIssues.length === 0) {
    return undefined;
  }

  if (!isRecord(value.completeness)) {
    return undefined;
  }

  const rawCompleteness = value.completeness;
  const discovery = normalizeFileChangeStage(rawCompleteness.discovery);
  const startSnapshots = normalizeFileChangeStage(
    rawCompleteness.startSnapshots,
  );
  const finishSnapshots = normalizeFileChangeStage(
    rawCompleteness.finishSnapshots,
  );
  const renameAnalysis = normalizeFileChangeStage(
    rawCompleteness.renameAnalysis,
  );
  const lineAnalysis = normalizeFileChangeStage(rawCompleteness.lineAnalysis);
  const persistence = normalizeFileChangeStage(rawCompleteness.persistence);

  if (
    !discovery ||
    !startSnapshots ||
    !finishSnapshots ||
    !renameAnalysis ||
    !lineAnalysis ||
    !persistence
  ) {
    return undefined;
  }

  const completeness: TaskExecutionFileChangeCompleteness = {
    discovery,
    startSnapshots,
    finishSnapshots,
    renameAnalysis,
    lineAnalysis,
    persistence,
  };
  const changeSetId = normalizeString(value.changeSetId).trim().slice(0, 128);

  return {
    files,
    ...(changeSetId ? { changeSetId } : {}),
    totalFiles,
    additions,
    deletions,
    binaryFiles,
    gitlinkFiles,
    symlinkFiles,
    modeOnlyFiles,
    failedFiles,
    status: value.status,
    completeness,
    attribution: "workspace-observed",
    repositoryCount,
    issues: normalizedIssues,
  };
};

const normalizeTaskExecutionResult = (
  value: unknown,
  fallbackTask: string,
): TaskExecutionResult | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const response = normalizeTaskExecutionResponse(value.response);
  const fileChanges = normalizeTaskExecutionFileChanges(value.fileChanges);

  return {
    task: normalizeString(value.task, fallbackTask || "Untitled task").slice(
      0,
      8_000,
    ),
    mode: normalizeStoredRunMode(value.mode),
    status: normalizeTaskExecutionStatus(value.status),
    summary: normalizeString(
      value.summary,
      "Task result restored from persisted session.",
    ).slice(0, 8_000),
    executedTools: normalizeToolNames(value.executedTools),
    ...(normalizeChatSessionOptionalString(value.reason)
      ? { reason: normalizeChatSessionOptionalString(value.reason) }
      : {}),
    ...(isRecord(value.metadata) ? { metadata: { ...value.metadata } } : {}),
    outputSections: normalizeTaskExecutionSections(value.outputSections),
    ...(response ? { response } : {}),
    ...(fileChanges ? { fileChanges } : {}),
  };
};

const normalizeThinkingModelStream = (
  value: unknown,
): TaskThinkingModelStream | undefined => {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !MODEL_STREAM_KINDS.includes(value.kind as TaskThinkingModelStream["kind"])
  ) {
    return undefined;
  }

  return {
    kind: value.kind as TaskThinkingModelStream["kind"],
    label: normalizeString(value.label),
    content: normalizeString(value.content).slice(0, 4_000),
    ...(typeof value.complete === "boolean"
      ? { complete: value.complete }
      : {}),
  };
};

const normalizeThinkingActionOutputLines = (
  value: unknown,
): TaskThinkingActionOutputLine[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord).map((entry, index) => ({
    id: normalizeString(entry.id, `thinking-output-${index}`),
    toolName: normalizeString(entry.toolName),
    stream: entry.stream === "stderr" ? "stderr" : "stdout",
    text: normalizeString(entry.text),
    timestamp: normalizeFiniteNumber(entry.timestamp, index),
  }));
};

const normalizeTokenCount = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }

  return Math.trunc(value);
};

const normalizeThinkingTokenUsage = (
  value: unknown,
): TaskExecutionTokenUsage | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = normalizeTokenCount(value.inputTokens);
  const outputTokens = normalizeTokenCount(value.outputTokens);
  const totalTokens = normalizeTokenCount(value.totalTokens);
  const cachedInputTokens = normalizeTokenCount(value.cachedInputTokens);
  const reasoningTokens = normalizeTokenCount(value.reasoningTokens);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
};

const normalizeThinkingTimelineMetadata = (
  value: unknown,
): Record<string, string | number | boolean> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const metadata = Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string | number | boolean] => {
        const entryValue = entry[1];

        return (
          typeof entryValue === "string" ||
          typeof entryValue === "boolean" ||
          (typeof entryValue === "number" && Number.isFinite(entryValue))
        );
      },
    ),
  );

  return Object.keys(metadata).length > 0 ? metadata : undefined;
};

const normalizeThinkingTimelineEvents = (
  value: unknown,
): TaskThinkingTimelineEvent[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((entry, index) => {
      const tokenUsage = normalizeThinkingTokenUsage(entry.tokenUsage);
      const metadata = normalizeThinkingTimelineMetadata(entry.metadata);
      const provider =
        typeof entry.provider === "string" &&
        MODEL_PROVIDERS.includes(
          entry.provider as (typeof MODEL_PROVIDERS)[number],
        )
          ? (entry.provider as (typeof MODEL_PROVIDERS)[number])
          : undefined;
      const stream: TaskThinkingTimelineEvent["stream"] =
        entry.stream === "stdout" || entry.stream === "stderr"
          ? entry.stream
          : undefined;

      return {
        id: normalizeString(entry.id, `thinking-timeline-${index}`),
        kind: THINKING_TIMELINE_EVENT_KINDS.includes(
          entry.kind as TaskThinkingTimelineEvent["kind"],
        )
          ? (entry.kind as TaskThinkingTimelineEvent["kind"])
          : "state",
        phase: THINKING_TIMELINE_EVENT_PHASES.includes(
          entry.phase as TaskThinkingTimelineEvent["phase"],
        )
          ? (entry.phase as TaskThinkingTimelineEvent["phase"])
          : "started",
        label: normalizeString(entry.label, "Progress"),
        detail: normalizeString(entry.detail),
        tone: isTaskPanelTone(entry.tone) ? entry.tone : "info",
        timestamp: normalizeFiniteNumber(entry.timestamp, index),
        elapsedMs: normalizeFiniteNumber(entry.elapsedMs, 0),
        ...(provider ? { provider } : {}),
        ...(normalizeChatSessionOptionalString(entry.model)
          ? { model: normalizeChatSessionOptionalString(entry.model) }
          : {}),
        ...(normalizeChatSessionOptionalString(entry.toolName)
          ? { toolName: normalizeChatSessionOptionalString(entry.toolName) }
          : {}),
        ...(normalizeChatSessionOptionalString(entry.callId)
          ? { callId: normalizeChatSessionOptionalString(entry.callId) }
          : {}),
        ...(stream ? { stream } : {}),
        ...(tokenUsage ? { tokenUsage } : {}),
        ...(metadata ? { metadata } : {}),
      };
    })
    .slice(-THINKING_TIMELINE_EVENT_LIMIT);
};

const normalizeThinkingTrace = (
  value: unknown,
): TaskThinkingTrace | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const status =
    typeof value.status === "string" &&
    THINKING_STATUSES.includes(value.status as TaskThinkingTrace["status"])
      ? (value.status as TaskThinkingTrace["status"])
      : "complete";
  const modelStream = normalizeThinkingModelStream(value.modelStream);
  const actionOutputLines = normalizeThinkingActionOutputLines(
    value.actionOutputLines,
  );
  const timelineEvents = normalizeThinkingTimelineEvents(value.timelineEvents);
  const tokenUsage = normalizeThinkingTokenUsage(value.tokenUsage);
  const startedAt = normalizeFiniteNumber(
    value.startedAt,
    timelineEvents[0]?.timestamp ?? 0,
  );
  const lastActivityAt = normalizeOptionalFiniteNumber(value.lastActivityAt);
  const timeout = normalizeTaskExecutionTimeoutState(value.timeout);
  const completedAt = normalizeFiniteNumber(value.completedAt, 0);

  return {
    status,
    mode: normalizeStoredRunMode(value.mode),
    startedAt,
    ...(lastActivityAt !== undefined
      ? { lastActivityAt: Math.max(startedAt, lastActivityAt) }
      : {}),
    ...(timeout ? { timeout } : {}),
    timelineEvents:
      status === "complete"
        ? timelineEvents.slice(-COMPLETED_THINKING_TIMELINE_EVENT_LIMIT)
        : timelineEvents,
    ...(normalizeChatSessionOptionalString(value.task)
      ? { task: normalizeChatSessionOptionalString(value.task) }
      : {}),
    ...(completedAt > 0 ? { completedAt } : {}),
    ...(normalizeChatSessionOptionalString(value.assistantText)
      ? {
          assistantText: normalizeChatSessionOptionalString(
            value.assistantText,
          ),
        }
      : {}),
    ...(modelStream ? { modelStream } : {}),
    ...(actionOutputLines.length > 0
      ? {
          actionOutputLines:
            status === "complete"
              ? actionOutputLines.slice(
                  -COMPLETED_THINKING_ACTION_OUTPUT_LINE_LIMIT,
                )
              : actionOutputLines,
        }
      : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
  };
};

const normalizeMessageSource = (
  value: unknown,
  fallbackTask: string,
): ChatSessionMessageSource | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  if (value.kind === "preview") {
    const preview = normalizeTaskRunPreview(value.preview, fallbackTask);

    return preview ? { kind: "preview", preview } : undefined;
  }

  if (value.kind === "execution") {
    const execution = normalizeTaskExecutionResult(
      value.execution,
      fallbackTask,
    );
    const thinking = normalizeThinkingTrace(value.thinking);

    return execution
      ? {
          kind: "execution",
          execution,
          ...(thinking ? { thinking } : {}),
        }
      : undefined;
  }

  if (value.kind === "thinking") {
    const thinking = normalizeThinkingTrace(value.thinking);

    return thinking ? { kind: "thinking", thinking } : undefined;
  }

  if (
    value.kind === "interrupted-task" &&
    value.status === "crashed" &&
    (value.reason === "restart" || value.reason === "inactive")
  ) {
    return {
      kind: "interrupted-task",
      status: "crashed",
      reason: value.reason,
    };
  }

  return undefined;
};

const normalizeMessageTaskAction = (
  value: unknown,
  role: ChatSessionMessage["role"],
): ChatSessionTaskAction | undefined => {
  if (
    role !== "user" ||
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    (value.kind !== "retry-task" && value.kind !== "continue-task") ||
    typeof value.objective !== "string"
  ) {
    return undefined;
  }

  const objective = truncatePersistedText(value.objective).trim();

  return objective ? { kind: value.kind, objective } : undefined;
};

const normalizeMessageLifecycle = (
  value: unknown,
  role: ChatSessionMessage["role"],
  taskId: string | undefined,
  source: ChatSessionMessageSource | undefined,
): ChatSessionMessageLifecycle | undefined => {
  const promptEnhancementPlacements = [
    "edit-composer",
    "message",
    "queued-message",
  ] as const;
  const isPromptEnhancementEdit =
    isRecord(value) &&
    value.owner === "prompt-enhancement" &&
    value.placement === "edit-composer";
  if (
    !isRecord(value) ||
    Object.keys(value).length !==
      (value.owner === "prompt-enhancement"
        ? isPromptEnhancementEdit
          ? 9
          : 8
        : 7) ||
    value.kind !== "transient" ||
    (value.owner !== "prompt-enhancement" &&
      value.owner !== "task-interview") ||
    typeof value.operationId !== "string" ||
    value.operationId.length === 0 ||
    value.operationId !== taskId ||
    typeof value.ownerLaunchId !== "string" ||
    value.ownerLaunchId.length === 0 ||
    typeof value.ownerWindowId !== "string" ||
    value.ownerWindowId.length === 0 ||
    typeof value.ownerInstanceId !== "string" ||
    value.ownerInstanceId.length === 0 ||
    (value.owner === "prompt-enhancement" &&
      !promptEnhancementPlacements.includes(
        value.placement as (typeof promptEnhancementPlacements)[number],
      )) ||
    (isPromptEnhancementEdit
      ? typeof value.targetMessageId !== "string" ||
        value.targetMessageId.trim().length === 0
      : value.targetMessageId !== undefined) ||
    (value.owner === "task-interview" && value.placement !== undefined) ||
    (value.slot !== "user" &&
      value.slot !== "thinking" &&
      value.slot !== "marker")
  ) {
    return undefined;
  }

  if (
    (value.slot === "user" && role !== "user") ||
    (value.slot === "thinking" &&
      (role !== "agent" || source?.kind !== "thinking")) ||
    (value.slot === "marker" && role !== "agent")
  ) {
    return undefined;
  }

  return {
    kind: "transient",
    owner: value.owner,
    operationId: value.operationId,
    slot: value.slot,
    ownerLaunchId: value.ownerLaunchId,
    ownerWindowId: value.ownerWindowId,
    ownerInstanceId: value.ownerInstanceId,
    ...(value.owner === "prompt-enhancement"
      ? {
          placement: value.placement as NonNullable<
            ChatSessionMessageLifecycle["placement"]
          >,
          ...(isPromptEnhancementEdit
            ? { targetMessageId: (value.targetMessageId as string).trim() }
            : {}),
        }
      : {}),
  };
};

const normalizeMessageOutcome = (
  value: unknown,
): ChatSessionTaskOutcome | undefined => {
  if (
    !isRecord(value) ||
    typeof value.status !== "string" ||
    !TASK_OUTCOME_STATUSES.includes(
      value.status as ChatSessionTaskOutcomeStatus,
    )
  ) {
    return undefined;
  }

  const reason = normalizeChatSessionOptionalString(value.reason);
  return {
    status: value.status as ChatSessionTaskOutcomeStatus,
    ...(reason ? { reason } : {}),
  };
};

const normalizeMessagePromptEnhancement = (
  value: unknown,
  content: string,
): ChatSessionMessagePromptEnhancement | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const originalContent = truncatePersistedText(
    normalizeString(value.originalContent),
  ).trim();

  if (!originalContent || originalContent === content.trim()) {
    return undefined;
  }

  return { originalContent };
};

const normalizeQueuedPromptEnhancementRequest = (
  value: unknown,
): ChatSessionQueuedPromptEnhancementRequest | undefined => {
  if (
    !isRecord(value) ||
    (value.mode !== "simple" && value.mode !== "web-search")
  ) {
    return undefined;
  }

  return { mode: value.mode };
};

const normalizeMessageSettings = (
  value: unknown,
): ChatSessionMessageSettings | undefined => {
  if (!isRecord(value) || !isRuntimeProvider(value.provider)) {
    return undefined;
  }

  const model = normalizeString(value.model).trim();

  if (!model) {
    return undefined;
  }

  const mode = normalizeOptionalStoredRunMode(value.mode);
  const reasoning = normalizeOptionalStoredReasoningMode(value.reasoning);
  const promptEnhancementMode =
    typeof value.promptEnhancementMode === "string" &&
    MESSAGE_PROMPT_ENHANCEMENT_MODES.includes(
      value.promptEnhancementMode as ChatSessionMessagePromptEnhancementMode,
    )
      ? (value.promptEnhancementMode as ChatSessionMessagePromptEnhancementMode)
      : "off";
  const workspace =
    typeof value.workspace === "string" && value.workspace.trim()
      ? value.workspace.trim()
      : null;

  return {
    workspace,
    provider: value.provider,
    model,
    ...(mode ? { mode } : {}),
    ...(reasoning ? { reasoning } : {}),
    sessionMemoryEnabled: value.sessionMemoryEnabled === true,
    useWorkspaceMemory: value.useWorkspaceMemory !== false,
    useGlobalMemory: value.useGlobalMemory === true,
    uiControlEnabled: value.uiControlEnabled === true,
    promptEnhancementMode,
    interviewEnabled: value.interviewEnabled === true,
  };
};

const getExecutionTraceCompletionTimestamp = (
  message: ChatSessionMessage,
  thinking: TaskThinkingTrace,
): number => {
  return Math.max(
    thinking.startedAt,
    thinking.timelineEvents.at(-1)?.timestamp ?? thinking.startedAt,
    thinking.completedAt ?? thinking.startedAt,
    message.createdAt ?? thinking.startedAt,
  );
};

/**
 * Moves each task's accumulated live trace onto its following terminal
 * execution message. The separate thinking message can then be hidden or
 * compacted without discarding the execution history.
 */
const attachPriorThinkingTracesToExecutions = (
  messages: ChatSessionMessage[],
): ChatSessionMessage[] => {
  const latestThinkingByTask = new Map<string, TaskThinkingTrace>();
  let changed = false;
  const nextMessages = messages.map((message) => {
    if (
      message.role === "agent" &&
      message.taskId &&
      message.source?.kind === "thinking"
    ) {
      latestThinkingByTask.set(message.taskId, message.source.thinking);
      return message;
    }

    if (message.role !== "agent" || message.source?.kind !== "execution") {
      return message;
    }

    const priorThinking =
      message.source.thinking ??
      (message.taskId ? latestThinkingByTask.get(message.taskId) : undefined);

    if (message.taskId) {
      latestThinkingByTask.delete(message.taskId);
    }

    if (!priorThinking) {
      return message;
    }

    const completedThinking = appendTerminalExecutionToThinkingTrace(
      priorThinking,
      message.source.execution,
      getExecutionTraceCompletionTimestamp(message, priorThinking),
    );

    if (message.source.thinking === completedThinking) {
      return message;
    }

    changed = true;
    return {
      ...message,
      source: {
        ...message.source,
        thinking: completedThinking,
      },
    };
  });

  return changed ? nextMessages : messages;
};

const normalizeSessionMessages = (
  value: unknown,
  sessionId: string,
): ChatSessionMessage[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const messages: ChatSessionMessage[] = [];
  const seenMessageIds = new Set<string>();

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || (entry.role !== "user" && entry.role !== "agent")) {
      continue;
    }

    const content = truncatePersistedText(normalizeString(entry.content));
    let source = normalizeMessageSource(entry.source, content);

    if (
      content.trim().length > 0 &&
      source?.kind === "execution" &&
      source.execution.response?.markdown.trim() === content.trim()
    ) {
      source = {
        ...source,
        execution: {
          ...source.execution,
          outputSections: source.execution.outputSections.filter(
            (section) => section.lines.join("\n").trim() !== content.trim(),
          ),
          response: {
            ...source.execution.response,
            markdown: "",
          },
        },
      };
    }
    const createdAt = normalizeOptionalFiniteNumber(entry.createdAt);
    const taskAction = normalizeMessageTaskAction(entry.taskAction, entry.role);
    const taskId = normalizeChatSessionOptionalString(entry.taskId);
    const contextAttachments = normalizeContextAttachments(
      entry.contextAttachments,
      `message-context-${sessionId}-${index}`,
    );
    const promptEnhancement =
      entry.role === "user"
        ? normalizeMessagePromptEnhancement(entry.promptEnhancement, content)
        : undefined;
    const settings =
      entry.role === "user"
        ? normalizeMessageSettings(entry.settings)
        : undefined;
    const lifecycle = normalizeMessageLifecycle(
      entry.lifecycle,
      entry.role,
      taskId,
      source,
    );
    const outcome = normalizeMessageOutcome(entry.outcome);
    const preferredMessageId = normalizeString(
      entry.id,
      `${sessionId}-message-${index}`,
    );
    let messageId = preferredMessageId;
    let duplicateIndex = 2;

    while (seenMessageIds.has(messageId)) {
      messageId = `${preferredMessageId}-${duplicateIndex}`;
      duplicateIndex += 1;
    }

    seenMessageIds.add(messageId);
    const message: ChatSessionMessage = {
      id: messageId,
      role: entry.role,
      content,
      ...(taskId ? { taskId } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(taskAction ? { taskAction } : {}),
      ...(contextAttachments.length > 0 ? { contextAttachments } : {}),
      ...(promptEnhancement ? { promptEnhancement } : {}),
      ...(settings ? { settings } : {}),
      ...(source ? { source } : {}),
      ...(lifecycle ? { lifecycle } : {}),
      ...(outcome ? { outcome } : {}),
    };

    messages.push(message);
  }

  const messagesWithExecutionTraces =
    attachPriorThinkingTracesToExecutions(messages);
  const tasksWithTerminalAgentMessages = new Set(
    messagesWithExecutionTraces.flatMap((message) =>
      message.role === "agent" &&
      message.taskId &&
      message.source?.kind !== "thinking" &&
      message.source?.kind !== "preview"
        ? [message.taskId]
        : [],
    ),
  );

  return messagesWithExecutionTraces.filter(
    (message) =>
      !(
        message.role === "agent" &&
        message.taskId &&
        message.source?.kind === "thinking" &&
        tasksWithTerminalAgentMessages.has(message.taskId)
      ),
  );
};

const normalizeSessionRecord = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  const provider = isRuntimeProvider(session.provider)
    ? session.provider
    : DEFAULT_PROVIDER;
  const preserveModel = provider === session.provider;
  const mode = normalizeOptionalStoredRunMode(session.mode);
  const reasoning = normalizeOptionalStoredReasoningMode(session.reasoning);
  const specialSession = isSpecialSessionKind(session.specialSession)
    ? session.specialSession
    : undefined;
  const isQuickTaskSession = specialSession === QUICK_VOICE_SESSION_KIND;

  return createSession({
    ...session,
    provider,
    ...(specialSession ? { specialSession } : {}),
    ...(mode ? { mode } : {}),
    ...(reasoning ? { reasoning } : {}),
    model:
      preserveModel &&
      typeof session.model === "string" &&
      session.model.trim().length > 0
        ? session.model
        : undefined,
    draft: typeof session.draft === "string" ? session.draft : "",
    workspace: typeof session.workspace === "string" ? session.workspace : null,
    manualTitle:
      typeof session.manualTitle === "string" ? session.manualTitle : undefined,
    messages: trimSessionTaskGroupsToVisibleMessageLimit(
      normalizeSessionMessages(session.messages, session.id),
      PERSISTED_VISIBLE_MESSAGE_LIMIT,
    ),
    promptHistory: normalizePromptHistoryEntries(session.promptHistory),
    promptContextHistory: normalizePromptContextHistory(
      session.promptContextHistory,
    ),
    draftContextAttachments: normalizeContextAttachments(
      session.draftContextAttachments,
      `draft-context-${session.id}`,
    ),
    sessionMemoryEnabled: isQuickTaskSession
      ? false
      : session.sessionMemoryEnabled !== false,
    useWorkspaceMemory: session.useWorkspaceMemory !== false,
    useGlobalMemory: session.useGlobalMemory !== false,
    uiControlEnabled: session.uiControlEnabled === true,
    sessionMemory: isQuickTaskSession
      ? []
      : normalizeConversationMemoryEntries(session.sessionMemory, "session"),
    createdAt:
      typeof session.createdAt === "number" ? session.createdAt : undefined,
    updatedAt:
      typeof session.updatedAt === "number" ? session.updatedAt : undefined,
    draftUpdatedAt:
      typeof session.draftUpdatedAt === "number"
        ? session.draftUpdatedAt
        : session.updatedAt,
    draftAttachmentsUpdatedAt:
      typeof session.draftAttachmentsUpdatedAt === "number"
        ? session.draftAttachmentsUpdatedAt
        : session.updatedAt,
    lastReadAt:
      typeof session.lastReadAt === "number"
        ? session.lastReadAt
        : session.updatedAt,
    archivedAt:
      typeof session.archivedAt === "number" ? session.archivedAt : undefined,
    pinnedAt:
      typeof session.pinnedAt === "number" ? session.pinnedAt : undefined,
    timeResetAt:
      typeof session.timeResetAt === "number" ? session.timeResetAt : undefined,
    movedToTopAt:
      typeof session.movedToTopAt === "number"
        ? session.movedToTopAt
        : undefined,
    tags: normalizeSessionTags(session.tags),
  });
};

const deriveRecentWorkspacesFromSessions = (
  sessions: readonly ChatSessionRecord[],
): string[] => {
  const orderedSessions = [...sessions].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );

  return normalizeRecentWorkspaces(
    orderedSessions.map((session) => session.workspace),
  );
};

const getSessionNormalizationTimestamp = (
  session: ChatSessionRecord,
): number => {
  let timestamp = Math.max(
    session.updatedAt,
    session.draftUpdatedAt,
    session.draftAttachmentsUpdatedAt,
    session.lastReadAt ?? 0,
    session.archivedAt ?? 0,
    session.pinnedAt ?? 0,
    session.timeResetAt ?? 0,
    session.movedToTopAt ?? 0,
    ...Object.values(session.draftAttachmentAddedAt ?? {}),
    ...Object.values(session.draftAttachmentTombstones ?? {}),
  );

  for (const message of session.messages) {
    timestamp = Math.max(timestamp, message.createdAt ?? 0);
  }

  return timestamp;
};

const normalizeQueuedSessionMessages = (
  value: unknown,
  sessions: readonly ChatSessionRecord[],
): ChatSessionQueuedMessage[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  const sessionIds = new Set(sessions.map((session) => session.id));
  const seenMessageIds = new Set<string>();
  const queuedMessages: ChatSessionQueuedMessage[] = [];

  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      continue;
    }

    const sessionId = normalizeString(entry.sessionId).trim();
    const task = normalizeString(entry.task).trim();

    if (!sessionIds.has(sessionId) || !task) {
      continue;
    }

    const idCandidate = normalizeString(entry.id).trim();
    const id = idCandidate || `queued-message-${index}`;

    if (seenMessageIds.has(id)) {
      continue;
    }

    seenMessageIds.add(id);

    const visibleMessageContent = normalizeString(
      entry.visibleMessageContent,
    ).trim();
    const promptHistoryContent = normalizeString(
      entry.promptHistoryContent,
    ).trim();
    const promptEnhancement = normalizeMessagePromptEnhancement(
      entry.promptEnhancement,
      visibleMessageContent || task,
    );
    const promptEnhancementRequest = normalizeQueuedPromptEnhancementRequest(
      entry.promptEnhancementRequest,
    );
    const dispatchPolicy =
      entry.dispatchPolicy === "after-terminal"
        ? "after-terminal"
        : "after-success";
    const blockedByTaskId = normalizeString(entry.blockedByTaskId).trim();
    const createdAt = normalizeFiniteNumber(entry.createdAt, index);
    const updatedAt = Math.max(
      createdAt,
      normalizeFiniteNumber(entry.updatedAt, createdAt),
    );
    const orderRank = normalizeOptionalFiniteNumber(entry.orderRank);
    const orderUpdatedAt = normalizeOptionalFiniteNumber(entry.orderUpdatedAt);
    const status =
      entry.status === "enhancing" ||
      entry.status === "dispatching" ||
      entry.status === "failed"
        ? entry.status
        : "queued";
    const statusUpdatedAt =
      normalizeOptionalFiniteNumber(entry.statusUpdatedAt) ?? updatedAt;
    const failureMessage = truncatePersistedText(
      normalizeString(entry.failureMessage),
    ).trim();
    const contentUpdatedAt = normalizeOptionalFiniteNumber(
      entry.contentUpdatedAt,
    );
    const attachmentsUpdatedAt = normalizeOptionalFiniteNumber(
      entry.attachmentsUpdatedAt,
    );
    const blockerUpdatedAt = normalizeOptionalFiniteNumber(
      entry.blockerUpdatedAt,
    );
    if (
      orderRank === undefined ||
      orderUpdatedAt === undefined ||
      contentUpdatedAt === undefined ||
      attachmentsUpdatedAt === undefined ||
      blockerUpdatedAt === undefined ||
      !isRecord(entry.attachmentTombstones)
    ) {
      continue;
    }
    const attachmentTombstones = Object.fromEntries(
      Object.entries(entry.attachmentTombstones)
        .flatMap(([attachmentId, deletedAt]) => {
          const normalizedId = attachmentId.trim();
          const normalizedDeletedAt = normalizeOptionalFiniteNumber(deletedAt);

          return normalizedId && normalizedDeletedAt !== undefined
            ? [[normalizedId, normalizedDeletedAt] as const]
            : [];
        })
        .sort((left, right) => right[1] - left[1])
        .slice(0, 512),
    );

    queuedMessages.push({
      id,
      sessionId,
      task,
      ...(visibleMessageContent ? { visibleMessageContent } : {}),
      ...(promptHistoryContent ? { promptHistoryContent } : {}),
      ...(promptEnhancement ? { promptEnhancement } : {}),
      ...(promptEnhancementRequest ? { promptEnhancementRequest } : {}),
      dispatchPolicy,
      ...(blockedByTaskId ? { blockedByTaskId } : {}),
      contentUpdatedAt,
      attachmentsUpdatedAt,
      attachmentTombstones,
      blockerUpdatedAt,
      orderRank,
      orderUpdatedAt,
      status,
      statusUpdatedAt,
      ...(status === "failed" && failureMessage ? { failureMessage } : {}),
      contextAttachments: normalizeContextAttachments(
        entry.contextAttachments,
        `queued-context-${id}`,
      ).filter((attachment) => !(attachment.id in attachmentTombstones)),
      createdAt,
      updatedAt,
    });
  }

  return queuedMessages.sort(
    (left, right) =>
      left.sessionId.localeCompare(right.sessionId) ||
      left.orderRank - right.orderRank ||
      left.createdAt - right.createdAt ||
      left.id.localeCompare(right.id),
  );
};

export const normalizeShellState = (value: unknown): ShellPersistedState => {
  const fallback = createInitialShellState();

  if (!isRecord(value) || value.version !== 2) {
    return fallback;
  }

  const candidate = value as Partial<ShellPersistedState>;
  const sessions: ChatSessionRecord[] = [];
  const sessionIndexById = new Map<string, number>();

  if (Array.isArray(candidate.sessions)) {
    for (const session of candidate.sessions) {
      if (
        !session ||
        typeof session !== "object" ||
        typeof (session as ChatSessionRecord).id !== "string"
      ) {
        continue;
      }

      const normalizedSession = normalizeSessionRecord(
        session as ChatSessionRecord,
      );
      const existingSessionIndex = sessionIndexById.get(normalizedSession.id);

      if (existingSessionIndex === undefined) {
        sessionIndexById.set(normalizedSession.id, sessions.length);
        sessions.push(normalizedSession);
        continue;
      }

      const existingSession = sessions[existingSessionIndex];

      if (
        existingSession &&
        getSessionNormalizationTimestamp(normalizedSession) >=
          getSessionNormalizationTimestamp(existingSession)
      ) {
        sessions[existingSessionIndex] = normalizedSession;
      }
    }
  }

  const normalizedSessions = sessions.length > 0 ? sessions : fallback.sessions;
  let hasActiveSession = false;

  for (const session of normalizedSessions) {
    if (session.id === candidate.activeSessionId) {
      hasActiveSession = true;
      break;
    }
  }

  const lastSelectedProvider = isRuntimeProvider(candidate.lastSelectedProvider)
    ? candidate.lastSelectedProvider
    : fallback.lastSelectedProvider;
  const lastSelectedModelByProvider: Partial<Record<RuntimeProvider, string>> =
    {};

  for (const [provider, model] of Object.entries(
    candidate.lastSelectedModelByProvider ?? {},
  )) {
    if (
      isRuntimeProvider(provider) &&
      typeof model === "string" &&
      model.trim().length > 0
    ) {
      lastSelectedModelByProvider[provider] = model;
    }
  }

  const lastSelectedMode = normalizeOptionalStoredRunMode(
    candidate.lastSelectedMode,
  );
  const lastSelectedReasoning = normalizeOptionalStoredReasoningMode(
    candidate.lastSelectedReasoning,
  );
  const lastSelectedSessionMemoryEnabled =
    typeof candidate.lastSelectedSessionMemoryEnabled === "boolean"
      ? candidate.lastSelectedSessionMemoryEnabled
      : fallback.lastSelectedSessionMemoryEnabled;
  const lastSelectedUseWorkspaceMemory =
    typeof candidate.lastSelectedUseWorkspaceMemory === "boolean"
      ? candidate.lastSelectedUseWorkspaceMemory
      : fallback.lastSelectedUseWorkspaceMemory;
  const lastSelectedUseGlobalMemory =
    typeof candidate.lastSelectedUseGlobalMemory === "boolean"
      ? candidate.lastSelectedUseGlobalMemory
      : fallback.lastSelectedUseGlobalMemory;
  const lastSelectedUiControlEnabled =
    typeof candidate.lastSelectedUiControlEnabled === "boolean"
      ? candidate.lastSelectedUiControlEnabled
      : fallback.lastSelectedUiControlEnabled;
  const lastRecoveredLaunchId =
    typeof candidate.lastRecoveredLaunchId === "string" &&
    candidate.lastRecoveredLaunchId.trim().length > 0
      ? candidate.lastRecoveredLaunchId
      : undefined;
  const fleetManagedSettings = normalizeFleetManagedSettingsState(
    candidate.fleetManagedSettings,
  );
  const voiceCandidate =
    candidate.voice && typeof candidate.voice === "object"
      ? (candidate.voice as Partial<ShellVoiceSettings>)
      : null;
  const normalizedPreferredVoiceURI =
    typeof voiceCandidate?.preferredVoiceURI === "string" &&
    voiceCandidate.preferredVoiceURI.trim().length > 0
      ? voiceCandidate.preferredVoiceURI
      : undefined;
  const normalizedVoice: ShellVoiceSettings = {
    autoSpeakResponses: voiceCandidate?.autoSpeakResponses === true,
    rate: clampVoiceRate(voiceCandidate?.rate),
    ...(normalizedPreferredVoiceURI
      ? { preferredVoiceURI: normalizedPreferredVoiceURI }
      : {}),
  };
  const normalizedRecentWorkspaces = normalizeRecentWorkspaces(
    candidate.recentWorkspaces,
  );
  const recentWorkspaces = Array.isArray(candidate.recentWorkspaces)
    ? normalizedRecentWorkspaces
    : deriveRecentWorkspacesFromSessions(normalizedSessions);
  const handledFleetCommandIds = Array.isArray(candidate.handledFleetCommandIds)
    ? [
        ...new Set(
          candidate.handledFleetCommandIds
            .filter(
              (commandId): commandId is string =>
                typeof commandId === "string" && commandId.trim().length > 0,
            )
            .map((commandId) => commandId.trim()),
        ),
      ].slice(-512)
    : [];
  const queuedMessageTombstones = isRecord(candidate.queuedMessageTombstones)
    ? Object.fromEntries(
        Object.entries(candidate.queuedMessageTombstones)
          .flatMap(([messageId, deletedAt]) => {
            const normalizedId = messageId.trim();
            const normalizedDeletedAt =
              normalizeOptionalFiniteNumber(deletedAt);

            return normalizedId && normalizedDeletedAt !== undefined
              ? [[normalizedId, normalizedDeletedAt] as const]
              : [];
          })
          .sort((left, right) => right[1] - left[1])
          .slice(0, 2_048),
      )
    : {};
  const sessionTombstones = normalizeTimestampRecord(
    candidate.sessionTombstones,
  );

  return {
    version: 2,
    activeSessionId: hasActiveSession
      ? (candidate.activeSessionId as string)
      : normalizedSessions[0].id,
    activeSessionUpdatedAt:
      normalizeOptionalFiniteNumber(candidate.activeSessionUpdatedAt) ?? 0,
    sessions: normalizedSessions,
    sessionTombstones,
    queuedSessionMessages: normalizeQueuedSessionMessages(
      candidate.queuedSessionMessages,
      normalizedSessions,
    ).filter((message) => !(message.id in queuedMessageTombstones)),
    handledFleetCommandIds,
    queuedMessageTombstones,
    contextPacks: normalizeSmartContextPacks(candidate.contextPacks),
    recentWorkspaces,
    voice: normalizedVoice,
    lastSelectedProvider,
    lastSelectedModelByProvider: {
      ...fallback.lastSelectedModelByProvider,
      ...lastSelectedModelByProvider,
    },
    ...(lastSelectedMode ? { lastSelectedMode } : {}),
    ...(lastSelectedReasoning ? { lastSelectedReasoning } : {}),
    lastSelectedSessionMemoryEnabled,
    lastSelectedUseWorkspaceMemory,
    lastSelectedUseGlobalMemory,
    lastSelectedUiControlEnabled,
    ...(fleetManagedSettings ? { fleetManagedSettings } : {}),
    ...(lastRecoveredLaunchId ? { lastRecoveredLaunchId } : {}),
  };
};

const getMessageTaskId = (message: ChatSessionMessage): string => {
  return message.taskId ?? message.id;
};

const getMessageTimestamp = (
  message: ChatSessionMessage,
  fallback: number,
): number => {
  return typeof message.createdAt === "number" ? message.createdAt : fallback;
};

const getLatestUserTaskId = (messages: ChatSessionMessage[]): string | null => {
  let latestTask: { taskId: string; timestamp: number } | null = null;

  for (const [index, message] of messages.entries()) {
    if (message.role !== "user" || isTransientChatOperationMessage(message)) {
      continue;
    }

    const timestamp = getMessageTimestamp(message, index);
    const taskId = getMessageTaskId(message);

    if (!latestTask || timestamp >= latestTask.timestamp) {
      latestTask = { taskId, timestamp };
    }
  }

  return latestTask?.taskId ?? null;
};

const getLatestTerminalAgentMessageForTask = (
  messages: ChatSessionMessage[],
  taskId: string,
): ChatSessionMessage | null => {
  let latestThinkingMessage: ChatSessionMessage | null = null;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (getMessageTaskId(message) !== taskId) {
      continue;
    }

    if (
      message.role !== "agent" ||
      message.source?.kind === "preview" ||
      isTransientChatOperationMessage(message)
    ) {
      continue;
    }

    if (message.source?.kind === "thinking") {
      latestThinkingMessage ??= message;
      continue;
    }

    return message;
  }

  return latestThinkingMessage;
};

const getExecutionTaskOutcomeStatus = (
  status: TaskExecutionStatus,
): ChatSessionTaskOutcomeStatus => {
  const outcomeByExecutionStatus = {
    planned: "succeeded",
    executed: "succeeded",
    blocked: "blocked",
    cancelled: "cancelled",
    unsupported: "unsupported",
  } satisfies Record<TaskExecutionStatus, ChatSessionTaskOutcomeStatus>;

  return outcomeByExecutionStatus[status];
};

export const createTaskOutcomeFromExecution = (
  execution: TaskExecutionResult,
): ChatSessionTaskOutcome => ({
  status: getExecutionTaskOutcomeStatus(execution.status),
  ...(execution.reason ? { reason: execution.reason } : {}),
});

export const getMessageTaskOutcome = (
  message: ChatSessionMessage,
): ChatSessionTaskOutcome | null => {
  if (message.outcome) {
    return message.outcome;
  }

  const source = message.source;

  if (!source) {
    return message.role === "agent" ? { status: "succeeded" } : null;
  }

  if (source.kind === "interrupted-task") {
    return { status: "crashed" };
  }

  if (source.kind === "execution") {
    return createTaskOutcomeFromExecution(source.execution);
  }

  if (source.kind === "thinking") {
    return source.thinking.status === "complete"
      ? { status: "succeeded" }
      : null;
  }

  return null;
};

export const getSessionTaskOutcome = (
  session: ChatSessionRecord,
  taskId: string,
): ChatSessionTaskOutcome | null => {
  const terminalMessage = getLatestTerminalAgentMessageForTask(
    session.messages,
    taskId,
  );

  return terminalMessage ? getMessageTaskOutcome(terminalMessage) : null;
};

export const getActiveChatOperationIds = (
  session: ChatSessionRecord,
): string[] => {
  const activeOperationIds = new Set<string>();
  const taskIds = new Set<string>();

  for (const message of session.messages) {
    if (isTransientChatOperationMessage(message)) {
      activeOperationIds.add(
        message.lifecycle?.operationId ?? message.taskId ?? message.id,
      );
      continue;
    }

    if (message.role === "user") {
      taskIds.add(getMessageTaskId(message));
    }
  }

  for (const taskId of taskIds) {
    if (!getSessionTaskOutcome(session, taskId)) {
      activeOperationIds.add(taskId);
    }
  }

  return [...activeOperationIds].sort();
};

export const isSessionArchived = (session: ChatSessionRecord): boolean => {
  return typeof session.archivedAt === "number";
};

export const isQuickVoiceSession = (session: ChatSessionRecord): boolean => {
  return session.specialSession === QUICK_VOICE_SESSION_KIND;
};

export const isSessionWorkspaceLocked = (
  session: ChatSessionRecord,
): boolean => {
  return (
    !isQuickVoiceSession(session) &&
    session.messages.some(
      (message) =>
        message.role === "user" &&
        !isTransientChatOperationMessage(message) &&
        message.content.trim().length > 0,
    )
  );
};

export const canDeleteSession = (session: ChatSessionRecord): boolean => {
  return (
    !isQuickVoiceSession(session) &&
    getActiveChatOperationIds(session).length === 0
  );
};

export const canRenameSession = (session: ChatSessionRecord): boolean => {
  return !isQuickVoiceSession(session);
};

export const getSessionOverviewStatus = (
  session: ChatSessionRecord,
): SessionOverviewStatus => {
  if (
    session.messages.some((message) => isTransientChatOperationMessage(message))
  ) {
    return "running";
  }

  if (session.messages.length === 0) {
    return "empty";
  }

  const latestUserTaskId = getLatestUserTaskId(session.messages);

  if (!latestUserTaskId) {
    return "empty";
  }

  const latestTerminalAgentMessage = getLatestTerminalAgentMessageForTask(
    session.messages,
    latestUserTaskId,
  );

  if (!latestTerminalAgentMessage) {
    return "running";
  }

  const outcome = getMessageTaskOutcome(latestTerminalAgentMessage);

  if (!outcome) {
    return "running";
  }

  const overviewStatusByOutcome = {
    succeeded: "done",
    failed: "failed",
    blocked: "blocked",
    cancelled: "cancelled",
    "timed-out": "timed-out",
    unsupported: "unsupported",
    crashed: "crashed",
  } satisfies Record<ChatSessionTaskOutcomeStatus, SessionOverviewStatus>;

  return overviewStatusByOutcome[outcome.status];
};

export const isSessionEmpty = (session: ChatSessionRecord): boolean => {
  return getSessionOverviewStatus(session) === "empty";
};

export const canPinSession = (session: ChatSessionRecord): boolean => {
  return !isQuickVoiceSession(session) && !isSessionEmpty(session);
};

export const canDuplicateSession = (session: ChatSessionRecord): boolean => {
  return (
    !isQuickVoiceSession(session) &&
    !isSessionEmpty(session) &&
    getActiveChatOperationIds(session).length === 0
  );
};

export const getLatestCompletedSessionResponseAt = (
  session: ChatSessionRecord,
): number | null => {
  const status = getSessionOverviewStatus(session);

  if (status === "empty" || status === "running") {
    return null;
  }

  const latestUserTaskId = getLatestUserTaskId(session.messages);

  if (!latestUserTaskId) {
    return null;
  }

  const latestTerminalAgentMessage = getLatestTerminalAgentMessageForTask(
    session.messages,
    latestUserTaskId,
  );

  if (!latestTerminalAgentMessage) {
    return null;
  }

  return getMessageTimestamp(latestTerminalAgentMessage, session.updatedAt);
};

export const hasUnreadCompletedSessionResponse = (
  session: ChatSessionRecord,
): boolean => {
  const latestCompletedResponseAt =
    getLatestCompletedSessionResponseAt(session);

  return (
    latestCompletedResponseAt !== null &&
    latestCompletedResponseAt > (session.lastReadAt ?? session.updatedAt)
  );
};

export const markSessionRead = (
  session: ChatSessionRecord,
  readAt = Date.now(),
): ChatSessionRecord => {
  const latestCompletedResponseAt =
    getLatestCompletedSessionResponseAt(session);
  const nextLastReadAt = Math.max(
    session.lastReadAt ?? 0,
    readAt,
    latestCompletedResponseAt ?? 0,
  );

  if ((session.lastReadAt ?? 0) >= nextLastReadAt) {
    return session;
  }

  return {
    ...session,
    lastReadAt: nextLastReadAt,
  };
};

export const getLatestSessionUserRequestAt = (
  session: ChatSessionRecord,
): number => {
  let latestRequestAt: number | null = null;

  for (const [index, message] of session.messages.entries()) {
    if (message.role !== "user" || isTransientChatOperationMessage(message)) {
      continue;
    }

    latestRequestAt = Math.max(
      latestRequestAt ?? Number.NEGATIVE_INFINITY,
      getMessageTimestamp(message, session.createdAt + index),
    );
  }

  // Draft edits and streaming progress update `updatedAt`, but neither should
  // make an existing sidebar row jump. Sessions without a submitted request
  // keep their stable creation order instead.
  return latestRequestAt ?? session.createdAt;
};

export const getSessionTimestamp = (session: ChatSessionRecord): number => {
  return Math.max(
    getLatestSessionUserRequestAt(session),
    session.timeResetAt ?? 0,
  );
};

export const resetSessionTime = (
  session: ChatSessionRecord,
  timestamp = Date.now(),
): ChatSessionRecord => {
  return {
    ...session,
    updatedAt: Math.max(session.updatedAt, timestamp),
    timeResetAt: timestamp,
  };
};

export const moveSessionToTop = (
  session: ChatSessionRecord,
  timestamp = Date.now(),
): ChatSessionRecord => {
  return {
    ...session,
    updatedAt: Math.max(session.updatedAt, timestamp),
    movedToTopAt: timestamp,
  };
};

const getSessionSidebarOrderAt = (session: ChatSessionRecord): number => {
  return Math.max(getSessionTimestamp(session), session.movedToTopAt ?? 0);
};

export const compareSessionsByAttention = (
  left: ChatSessionRecord,
  right: ChatSessionRecord,
): number => {
  const leftIsQuickTaskSession = isQuickVoiceSession(left);
  const rightIsQuickTaskSession = isQuickVoiceSession(right);

  if (leftIsQuickTaskSession !== rightIsQuickTaskSession) {
    return leftIsQuickTaskSession ? -1 : 1;
  }

  const leftIsPinned = typeof left.pinnedAt === "number";
  const rightIsPinned = typeof right.pinnedAt === "number";

  if (leftIsPinned !== rightIsPinned) {
    return leftIsPinned ? -1 : 1;
  }

  const hasManualOrder =
    typeof left.timeResetAt === "number" ||
    typeof left.movedToTopAt === "number" ||
    typeof right.timeResetAt === "number" ||
    typeof right.movedToTopAt === "number";

  if (hasManualOrder) {
    const manualOrderDelta =
      getSessionSidebarOrderAt(right) - getSessionSidebarOrderAt(left);

    if (manualOrderDelta !== 0) {
      return manualOrderDelta;
    }
  }

  if (!leftIsPinned && !rightIsPinned) {
    const leftIsEmpty = isSessionEmpty(left);
    const rightIsEmpty = isSessionEmpty(right);

    if (leftIsEmpty !== rightIsEmpty) {
      return leftIsEmpty ? -1 : 1;
    }
  }

  const leftPinnedAt = left.pinnedAt ?? 0;
  const rightPinnedAt = right.pinnedAt ?? 0;

  if (leftPinnedAt !== rightPinnedAt) {
    return rightPinnedAt - leftPinnedAt;
  }

  const latestRequestDelta =
    getSessionTimestamp(right) - getSessionTimestamp(left);

  if (latestRequestDelta !== 0) {
    return latestRequestDelta;
  }

  const createdAtDelta = right.createdAt - left.createdAt;

  return createdAtDelta !== 0
    ? createdAtDelta
    : left.id.localeCompare(right.id);
};

export const sortSessionsByUpdatedAt = (
  sessions: ChatSessionRecord[],
): ChatSessionRecord[] => {
  return [...sessions].sort(compareSessionsByAttention);
};

export const getLatestRunningTaskId = (
  session: ChatSessionRecord,
): string | null => {
  const latestUserTaskId = getLatestUserTaskId(session.messages);

  if (!latestUserTaskId) {
    return null;
  }

  const latestTerminalAgentMessage = getLatestTerminalAgentMessageForTask(
    session.messages,
    latestUserTaskId,
  );

  if (!latestTerminalAgentMessage) {
    return latestUserTaskId;
  }

  if (
    latestTerminalAgentMessage.source?.kind === "thinking" &&
    latestTerminalAgentMessage.source.thinking.status === "running"
  ) {
    return latestUserTaskId;
  }

  return null;
};

const normalizeTaskIdSet = (
  taskIds: Iterable<string> | undefined,
): Set<string> => {
  const normalizedTaskIds = new Set<string>();

  for (const taskId of taskIds ?? []) {
    const normalizedTaskId = taskId.trim();

    if (normalizedTaskId) {
      normalizedTaskIds.add(normalizedTaskId);
    }
  }

  return normalizedTaskIds;
};

const getInterruptedTaskIds = (
  messages: ChatSessionMessage[],
  activeTaskIds: ReadonlySet<string>,
): Set<string> => {
  const taskIdsWithUserMessage = new Set<string>();
  const latestTerminalAgentMessageByTaskId = new Map<
    string,
    ChatSessionMessage
  >();
  let latestUserTaskId: string | null = null;

  for (const message of messages) {
    if (message.role === "user" && !isTransientChatOperationMessage(message)) {
      const taskId = getMessageTaskId(message);

      latestUserTaskId = taskId;
      taskIdsWithUserMessage.add(taskId);
      continue;
    }

    if (
      message.role !== "agent" ||
      message.source?.kind === "preview" ||
      isTransientChatOperationMessage(message)
    ) {
      continue;
    }

    const taskId = message.taskId ?? latestUserTaskId ?? message.id;

    latestTerminalAgentMessageByTaskId.set(taskId, message);
  }

  const interruptedTaskIds = new Set<string>();

  for (const taskId of taskIdsWithUserMessage) {
    if (activeTaskIds.has(taskId)) {
      continue;
    }

    const latestTerminalAgentMessage =
      latestTerminalAgentMessageByTaskId.get(taskId);

    if (!latestTerminalAgentMessage) {
      interruptedTaskIds.add(taskId);
      continue;
    }

    if (
      latestTerminalAgentMessage.source?.kind === "thinking" &&
      latestTerminalAgentMessage.source.thinking.status === "running"
    ) {
      interruptedTaskIds.add(taskId);
    }
  }

  return interruptedTaskIds;
};

type InterruptedTaskCrashReason = "restart" | "inactive";

const INTERRUPTED_TASK_CRASH_CONTENT_BY_REASON = {
  restart:
    "machdoch restarted before this AI task finished, so it was marked as crashed.",
  inactive:
    "machdoch no longer sees an active desktop task before a final response was produced, so it was marked as crashed.",
} satisfies Record<InterruptedTaskCrashReason, string>;

const createInterruptedTaskCrashMessage = (
  taskId: string,
  timestamp: number,
  index: number,
  reason: InterruptedTaskCrashReason,
): ChatSessionMessage => {
  return {
    id: `interrupted-${taskId}-${timestamp}-${index}`,
    taskId,
    role: "agent",
    content: `${INTERRUPTED_TASK_CRASH_PREFIX} ${INTERRUPTED_TASK_CRASH_CONTENT_BY_REASON[reason]}`,
    createdAt: timestamp,
    source: {
      kind: "interrupted-task",
      status: "crashed",
      reason,
    },
    outcome: {
      status: "crashed",
      reason: INTERRUPTED_TASK_CRASH_CONTENT_BY_REASON[reason],
    },
  };
};

const recoverInterruptedSessionTasks = (
  session: ChatSessionRecord,
  timestamp: number,
  activeTaskIds: ReadonlySet<string>,
  reason: InterruptedTaskCrashReason,
): ChatSessionRecord => {
  const interruptedTaskIds = getInterruptedTaskIds(
    session.messages,
    activeTaskIds,
  );

  if (interruptedTaskIds.size === 0) {
    return session;
  }

  const messageTaskIds: string[] = [];
  const lastMessageIndexByTaskId = new Map<string, number>();
  const hasCrashMessageByTaskId = new Map<string, boolean>();
  let latestUserTaskId: string | null = null;

  for (const [index, message] of session.messages.entries()) {
    const taskId: string =
      message.role === "agent"
        ? (message.taskId ?? latestUserTaskId ?? message.id)
        : getMessageTaskId(message);

    if (message.role === "user") {
      latestUserTaskId = taskId;
    }

    messageTaskIds[index] = taskId;
    lastMessageIndexByTaskId.set(taskId, index);

    if (
      message.role === "agent" &&
      message.source?.kind === "interrupted-task"
    ) {
      hasCrashMessageByTaskId.set(taskId, true);
    }
  }

  const nextMessages: ChatSessionMessage[] = [];
  let crashMessageIndex = 0;

  for (const [index, message] of session.messages.entries()) {
    const taskId = messageTaskIds[index] ?? getMessageTaskId(message);
    const isStaleRunningThinkingMessage =
      interruptedTaskIds.has(taskId) &&
      message.role === "agent" &&
      message.source?.kind === "thinking" &&
      message.source.thinking.status === "running";

    if (!isStaleRunningThinkingMessage) {
      nextMessages.push(message);
    }

    if (
      interruptedTaskIds.has(taskId) &&
      lastMessageIndexByTaskId.get(taskId) === index &&
      hasCrashMessageByTaskId.get(taskId) !== true
    ) {
      nextMessages.push(
        createInterruptedTaskCrashMessage(
          taskId,
          timestamp,
          crashMessageIndex,
          reason,
        ),
      );
      crashMessageIndex += 1;
    }
  }

  return {
    ...session,
    messages: nextMessages,
  };
};

export const recoverInterruptedTasksForLaunch = (
  state: ShellPersistedState,
  launchId: string | null | undefined,
  timestamp = Date.now(),
  activeTaskIds?: Iterable<string>,
): ShellPersistedState => {
  const normalizedLaunchId = launchId?.trim();
  const activeTaskIdSet = normalizeTaskIdSet(activeTaskIds);

  if (
    !normalizedLaunchId ||
    (activeTaskIds === undefined &&
      state.lastRecoveredLaunchId === normalizedLaunchId)
  ) {
    return state;
  }

  let didRecoverInterruptedTasks = false;
  const sessions = state.sessions.map((session) => {
    const recoveredSession = recoverInterruptedSessionTasks(
      session,
      timestamp,
      activeTaskIdSet,
      "restart",
    );

    if (recoveredSession !== session) {
      didRecoverInterruptedTasks = true;
    }

    return recoveredSession;
  });

  return {
    ...state,
    lastRecoveredLaunchId: normalizedLaunchId,
    sessions: didRecoverInterruptedTasks ? sessions : state.sessions,
  };
};

export const recoverInactiveRunningTasks = (
  state: ShellPersistedState,
  activeTaskIds: Iterable<string>,
  timestamp = Date.now(),
): ShellPersistedState => {
  const activeTaskIdSet = normalizeTaskIdSet(activeTaskIds);
  let didRecoverInterruptedTasks = false;
  const sessions = state.sessions.map((session) => {
    const recoveredSession = recoverInterruptedSessionTasks(
      session,
      timestamp,
      activeTaskIdSet,
      "inactive",
    );

    if (recoveredSession !== session) {
      didRecoverInterruptedTasks = true;
    }

    return recoveredSession;
  });

  if (!didRecoverInterruptedTasks) {
    return state;
  }

  return {
    ...state,
    sessions,
  };
};

export const canArchiveSession = (session: ChatSessionRecord): boolean => {
  const status = getSessionOverviewStatus(session);

  return (
    !isQuickVoiceSession(session) &&
    !isSessionArchived(session) &&
    status !== "running" &&
    status !== "empty"
  );
};

export interface SessionRetentionPolicy {
  inactiveSessionArchiveDays: number;
  archivedSessionRetentionDays: number;
}

export interface SessionRetentionProgress {
  phase: "archive" | "delete";
  startedAt: number;
  deadlineAt: number;
  progress: number;
}

const clampRetentionDays = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 7;
  }

  return Math.max(1, Math.round(value));
};

const getRetentionDurationMs = (days: number): number => {
  return clampRetentionDays(days) * SESSION_RETENTION_DAY_MS;
};

const getSessionRetentionDeadline = (
  startedAt: number | undefined,
  days: number,
): number | null => {
  if (typeof startedAt !== "number") {
    return null;
  }

  return startedAt + getRetentionDurationMs(days);
};

const createSessionRetentionProgress = (
  phase: SessionRetentionProgress["phase"],
  startedAt: number,
  deadlineAt: number,
  now: number,
): SessionRetentionProgress => {
  const duration = Math.max(1, deadlineAt - startedAt);
  const progress = Math.min(1, Math.max(0, (now - startedAt) / duration));

  return {
    phase,
    startedAt,
    deadlineAt,
    progress,
  };
};

export const getSessionRetentionProgress = (
  session: ChatSessionRecord,
  policy: SessionRetentionPolicy,
  now = Date.now(),
): SessionRetentionProgress | null => {
  if (isQuickVoiceSession(session)) {
    return null;
  }

  if (isSessionArchived(session)) {
    const deadlineAt = getSessionRetentionDeadline(
      session.archivedAt,
      policy.archivedSessionRetentionDays,
    );

    return deadlineAt === null
      ? null
      : createSessionRetentionProgress(
          "delete",
          session.archivedAt as number,
          deadlineAt,
          now,
        );
  }

  if (!canArchiveSession(session)) {
    return null;
  }

  const deadlineAt = getSessionRetentionDeadline(
    session.updatedAt,
    policy.inactiveSessionArchiveDays,
  );

  return deadlineAt === null
    ? null
    : createSessionRetentionProgress(
        "archive",
        session.updatedAt,
        deadlineAt,
        now,
      );
};

const createRetentionReplacementSession = (
  state: ShellPersistedState,
  timestamp: number,
): ChatSessionRecord => {
  const provider = state.lastSelectedProvider;

  return createSession({
    createdAt: timestamp,
    updatedAt: timestamp,
    provider,
    ...(state.lastSelectedMode ? { mode: state.lastSelectedMode } : {}),
    ...(state.lastSelectedReasoning
      ? { reasoning: state.lastSelectedReasoning }
      : {}),
    model:
      state.lastSelectedModelByProvider[provider] ??
      getDefaultModelForProvider(provider),
    sessionMemoryEnabled: state.lastSelectedSessionMemoryEnabled,
    useWorkspaceMemory: state.lastSelectedUseWorkspaceMemory,
    useGlobalMemory: state.lastSelectedUseGlobalMemory,
    uiControlEnabled: state.lastSelectedUiControlEnabled,
  });
};

export const applySessionRetentionPolicy = (
  state: ShellPersistedState,
  policy: SessionRetentionPolicy,
  now = Date.now(),
): ShellPersistedState => {
  let changed = false;
  const archivedRetentionMs = getRetentionDurationMs(
    policy.archivedSessionRetentionDays,
  );
  const inactiveArchiveMs = getRetentionDurationMs(
    policy.inactiveSessionArchiveDays,
  );
  const sessions: ChatSessionRecord[] = [];

  for (const session of state.sessions) {
    if (
      !isQuickVoiceSession(session) &&
      typeof session.archivedAt === "number" &&
      now - session.archivedAt >= archivedRetentionMs &&
      canDeleteSession(session)
    ) {
      changed = true;
      continue;
    }

    if (
      !isQuickVoiceSession(session) &&
      !isSessionArchived(session) &&
      canArchiveSession(session) &&
      now - session.updatedAt >= inactiveArchiveMs
    ) {
      changed = true;
      sessions.push({
        ...session,
        archivedAt: now,
      });
      continue;
    }

    sessions.push(session);
  }

  if (!changed) {
    return state;
  }

  const nextSessions =
    sessions.length > 0
      ? sessions
      : [createRetentionReplacementSession(state, now)];
  const activeSessionExists = nextSessions.some(
    (session) => session.id === state.activeSessionId,
  );
  const fallbackActiveSessionId = sortSessionsByUpdatedAt(nextSessions)[0]?.id;

  return {
    ...state,
    activeSessionId: activeSessionExists
      ? state.activeSessionId
      : (fallbackActiveSessionId ?? state.activeSessionId),
    sessions: nextSessions,
  };
};

export const deleteExpiredArchivedSessions = (
  state: ShellPersistedState,
  archivedSessionRetentionDays: number,
  now = Date.now(),
): ShellPersistedState => {
  let changed = false;
  const archivedRetentionMs = getRetentionDurationMs(
    archivedSessionRetentionDays,
  );
  const sessions = state.sessions.filter((session) => {
    const expired =
      !isQuickVoiceSession(session) &&
      typeof session.archivedAt === "number" &&
      now - session.archivedAt >= archivedRetentionMs &&
      canDeleteSession(session);

    if (expired) {
      changed = true;
      return false;
    }

    return true;
  });

  if (!changed) {
    return state;
  }

  const nextSessions =
    sessions.length > 0
      ? sessions
      : [createRetentionReplacementSession(state, now)];
  const activeSessionExists = nextSessions.some(
    (session) => session.id === state.activeSessionId,
  );
  const fallbackActiveSessionId = sortSessionsByUpdatedAt(nextSessions)[0]?.id;

  return {
    ...state,
    activeSessionId: activeSessionExists
      ? state.activeSessionId
      : (fallbackActiveSessionId ?? state.activeSessionId),
    sessions: nextSessions,
  };
};

export const createVisibleConversationMessages = (
  messages: ChatSessionMessage[],
): ChatSessionMessage[] => {
  const messagesWithExecutionTraces =
    attachPriorThinkingTracesToExecutions(messages);
  const tasksWithTerminalAgentMessages = new Set<string>();
  const latestThinkingAgentMessageByTask = new Map<string, string>();

  for (const message of messagesWithExecutionTraces) {
    if (message.lifecycle?.slot === "marker") {
      continue;
    }

    if (message.role !== "agent" || !message.taskId) {
      continue;
    }

    if (message.source?.kind === "preview") {
      continue;
    }

    if (message.source?.kind === "thinking") {
      latestThinkingAgentMessageByTask.set(message.taskId, message.id);
      continue;
    }

    tasksWithTerminalAgentMessages.add(message.taskId);
  }

  const visibleMessages: ChatSessionMessage[] = [];

  for (const message of messagesWithExecutionTraces) {
    if (message.lifecycle?.slot === "marker") {
      continue;
    }

    if (message.role !== "agent" || !message.taskId) {
      visibleMessages.push(message);
      continue;
    }

    if (message.source?.kind === "preview") {
      continue;
    }

    if (message.source?.kind !== "thinking") {
      visibleMessages.push(message);
      continue;
    }

    if (tasksWithTerminalAgentMessages.has(message.taskId)) {
      continue;
    }

    if (latestThinkingAgentMessageByTask.get(message.taskId) === message.id) {
      visibleMessages.push(message);
    }
  }

  return visibleMessages;
};

export function trimSessionTaskGroupsToVisibleMessageLimit(
  messages: ChatSessionMessage[],
  maxVisibleMessages: number,
): ChatSessionMessage[] {
  if (!Number.isFinite(maxVisibleMessages) || maxVisibleMessages <= 0) {
    return [];
  }

  const normalizedLimit = Math.max(1, Math.floor(maxVisibleMessages));
  const taskGroups: ChatSessionMessage[][] = [];

  for (const message of messages) {
    const taskGroupId = getMessageTaskId(message);
    const currentGroup = taskGroups.at(-1);
    const currentGroupId = currentGroup?.[0]
      ? getMessageTaskId(currentGroup[0])
      : null;

    if (currentGroup && currentGroupId === taskGroupId) {
      currentGroup.push(message);
      continue;
    }

    taskGroups.push([message]);
  }

  let visibleMessageCount = 0;
  const keptGroups: ChatSessionMessage[][] = [];

  for (let index = taskGroups.length - 1; index >= 0; index -= 1) {
    const taskGroup = taskGroups[index];
    const taskGroupVisibleMessages =
      createVisibleConversationMessages(taskGroup).length;

    if (
      keptGroups.length > 0 &&
      visibleMessageCount + taskGroupVisibleMessages > normalizedLimit
    ) {
      break;
    }

    visibleMessageCount += taskGroupVisibleMessages;
    keptGroups.unshift(taskGroup);
  }

  return keptGroups.flat();
}
