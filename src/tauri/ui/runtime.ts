import * as tauriCore from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AgentModelImageMediaType,
  ConversationMemoryEntry,
  TaskConversationContext,
  TaskActionOutput,
  TaskExecutionProgress,
  TaskExecutionResult,
  TaskRunPreview,
} from "../../core/types.js";
import {
  AGENT_LIMIT_BOUNDS,
  DEFAULT_USER_AGENT_LIMITS_SETTINGS,
  DEFAULT_USER_REVIEW_MODEL_SETTINGS,
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
  MODEL_PROVIDERS,
  RUN_MODES,
  USER_AUDIO_AI_PROVIDERS,
  USER_WEB_SEARCH_PROVIDERS,
  VALID_MODEL_PROVIDERS,
} from "../../core/runtime-contract.generated.js";
import type {
  AudioProvider,
  AudioProviderAvailability as SharedAudioProviderAvailability,
  RuntimeAgentLimits as SharedRuntimeAgentLimits,
  RuntimeCompatibilityConfig as SharedRuntimeCompatibilityConfig,
  RuntimeProfileSummary as SharedRuntimeProfileSummary,
  RuntimeSnapshot as SharedRuntimeSnapshot,
  RuntimeWebSearchConfig as SharedRuntimeWebSearchConfig,
  SpeechToTextProvider as SharedSpeechToTextProvider,
  UserAgentLimitsSettings as SharedUserAgentLimitsSettings,
  UserDesktopSettings as SharedUserDesktopSettings,
  UserReviewModelSettings as SharedUserReviewModelSettings,
  UserProviderApiKeys as SharedUserProviderApiKeys,
  UserSpeechToTextSettings as SharedUserSpeechToTextSettings,
  UserWebSearchApiKeys as SharedUserWebSearchApiKeys,
  UserWebSearchProvider,
  UserWebSearchSettings as SharedUserWebSearchSettings,
  UserVoiceSettings as SharedUserVoiceSettings,
  VoiceAiProvider as SharedVoiceAiProvider,
  WebSearchProvider as SharedWebSearchProvider,
  WebSearchProviderAvailability as SharedWebSearchProviderAvailability,
  ProviderAvailability as SharedRuntimeProviderAvailability,
} from "../../core/runtime-contract.generated.js";
import {
  SUPPORTED_PROVIDER_ORDER,
  type ProviderModelCatalogSnapshot,
  type RuntimeProvider,
} from "./model-catalog";
import {
  createMockExecutionFixture,
  createPreviewFixture,
} from "./preview/fixtures";

export type UserApiKeyProvider = RuntimeProvider;

export type WebSearchProvider = SharedWebSearchProvider;

export type VoiceAiProvider = SharedVoiceAiProvider;

export type SpeechToTextProvider = SharedSpeechToTextProvider;

export type UserWebSearchApiKeyProvider = UserWebSearchProvider;

export type UserVoiceAiProvider = AudioProvider;

export type UserSpeechToTextProvider = AudioProvider;

export const MAIN_WINDOW_LABEL = "main";
export const ASSISTANT_BUBBLE_WINDOW_LABEL = "assistant-bubble";
export const ASSISTANT_POPUP_WINDOW_LABEL = "assistant-popup";
export const QUICK_VOICE_WINDOW_LABEL = "quick-voice";
export const DESKTOP_SETTINGS_CHANGED_EVENT =
  "machdoch://desktop-settings-changed";
export const QUICK_VOICE_START_EVENT = "machdoch://quick-voice-start";

export const USER_API_KEY_PROVIDER_ORDER: UserApiKeyProvider[] = [
  ...VALID_MODEL_PROVIDERS,
];

export const USER_VOICE_AI_PROVIDER_ORDER: UserVoiceAiProvider[] = [
  ...USER_AUDIO_AI_PROVIDERS,
];

export const USER_SPEECH_TO_TEXT_PROVIDER_ORDER: UserSpeechToTextProvider[] = [
  ...USER_AUDIO_AI_PROVIDERS,
];

export const USER_API_KEY_PROVIDER_PORTAL_URLS: Record<
  UserApiKeyProvider,
  string
> = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://platform.claude.com/settings/keys",
  google: "https://aistudio.google.com/app/apikey",
};

export const USER_WEB_SEARCH_PROVIDER_ORDER: UserWebSearchApiKeyProvider[] = [
  ...USER_WEB_SEARCH_PROVIDERS,
];

export type UserProviderApiKeys = SharedUserProviderApiKeys;

export type UserWebSearchApiKeys = SharedUserWebSearchApiKeys;

export type RuntimeProviderAvailability = SharedRuntimeProviderAvailability;

export type WebSearchProviderAvailability = SharedWebSearchProviderAvailability;

export type VoiceProviderAvailability = SharedAudioProviderAvailability;

export type SpeechToTextProviderAvailability = SharedAudioProviderAvailability;

export type RuntimeWebSearchConfig = SharedRuntimeWebSearchConfig;

export type UserWebSearchSettings = SharedUserWebSearchSettings;

export type UserVoiceSettings = SharedUserVoiceSettings;

export type UserSpeechToTextSettings = SharedUserSpeechToTextSettings;

export interface UserMemorySettings {
  globalEnabled: boolean;
  entries: ConversationMemoryEntry[];
}

export type UserAgentLimitsSettings = SharedUserAgentLimitsSettings;

export type UserReviewModelSettings = SharedUserReviewModelSettings;

export type UserDesktopSettings = SharedUserDesktopSettings;

export interface MonitorBoundsInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DroppedPathEntry {
  path: string;
  kind: "directory" | "file" | "other" | string;
  name: string;
  parent?: string;
}

export interface DroppedPathsResolution {
  entries: DroppedPathEntry[];
  workspaceRoot: string | null;
}

export interface ClipboardImageAttachmentInput {
  blob: Blob;
  mediaType?: AgentModelImageMediaType;
  fileName?: string;
}

export interface SynthesizedVoiceAudio {
  provider: UserVoiceAiProvider;
  mimeType: string;
  audioBase64: string;
}

export interface TranscribedSpeechText {
  provider: UserSpeechToTextProvider;
  text: string;
  mimeType: string;
  detectedLanguage?: string;
}

export type RuntimeProfileSummary = SharedRuntimeProfileSummary;

export type RuntimeCompatibilityConfig = SharedRuntimeCompatibilityConfig;

export type RuntimeAgentLimits = SharedRuntimeAgentLimits;

export type RuntimeSnapshot = SharedRuntimeSnapshot;

export interface DesktopTaskRunResponse {
  execution: TaskExecutionResult;
  preview?: TaskRunPreview;
}

export interface DesktopTaskProgressEvent {
  taskId: string;
  progress: TaskExecutionProgress;
  timestamp: number;
}

export interface RemoteControlLogEntry {
  createdAt: number;
  stream: "stdout" | "stderr" | string;
  toolName?: string;
  chunk: string;
}

export interface RemoteControlTimelineEntry {
  createdAt: number;
  kind: string;
  phase: string;
  label: string;
  detail?: string;
  tone?: string;
  toolName?: string;
}

export interface RemoteControlTaskSession {
  taskId: string;
  task: string;
  mode: string;
  state: string;
  message: string;
  cancellable: boolean;
  startedAt: number;
  updatedAt: number;
  progressCount: number;
  logs: RemoteControlLogEntry[];
  timeline: RemoteControlTimelineEntry[];
}

export interface RemoteControlStatus {
  enabled: boolean;
  localUrl?: string;
  lanUrl?: string;
  displayUrl?: string;
  qrSvg?: string;
  tokenHint?: string;
  startedAt?: number;
  bindAddress?: string;
  port?: number;
  pairedDeviceCount?: number;
  eventId: number;
  sessions: RemoteControlTaskSession[];
}

export type RemoteControlCommandKind =
  | "cancel"
  | "retry"
  | "continue"
  | "follow-up"
  | "approval-decision";

export interface RemoteControlCommandEvent {
  commandId: string;
  kind: RemoteControlCommandKind;
  taskId?: string;
  prompt?: string;
  decision?: "approve" | "reject" | string;
  promptId?: string;
  createdAt: number;
}

export type SchedulerJobStatus =
  | "active"
  | "paused"
  | "completed"
  | "deleted";

export type SchedulerRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "expired"
  | "skipped";

export type SchedulerRunSource = "schedule" | "manual" | "manual-retry";

export type SchedulerMissedRunPolicy =
  | "skip"
  | "enqueue-latest"
  | "enqueue-all";

export type SchedulerScheduleSummary =
  | {
      type: "cron";
      expression: string;
      timezone: string;
    }
  | {
      type: "interval";
      intervalMs: number;
      anchorAt: number;
    }
  | {
      type: "delay";
      runAt: number;
    };

export type SchedulerCreateScheduleInput =
  | {
      type: "cron";
      expression: string;
      timezone?: string;
    }
  | {
      type: "interval";
      intervalMs: number;
    }
  | {
      type: "delay";
      delayMs?: number;
      runAt?: number;
    };

export interface SchedulerRetrySummary {
  maxAttempts: number;
  factor: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  randomize: boolean;
}

export interface SchedulerQueueSummary {
  concurrencyKey: string;
  concurrencyLimit: number;
}

export interface SchedulerJobSummary {
  id: string;
  name: string;
  status: SchedulerJobStatus;
  schedule: SchedulerScheduleSummary;
  workspaceRoot: string;
  prompt: string;
  nextRunAt: number | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  queue: SchedulerQueueSummary;
  retry: SchedulerRetrySummary;
  dedupeKey: string | null;
  ttlMs: number | null;
  maxDurationMs: number | null;
}

export interface SchedulerRunSummary {
  id: string;
  jobId: string;
  source: SchedulerRunSource;
  status: SchedulerRunStatus;
  scheduledFor: number;
  enqueuedAt: number;
  updatedAt: number;
  attempt: number;
  maxAttempts: number;
  queueKey: string;
  startedAt: number | null;
  finishedAt: number | null;
  nextAttemptAt: number | null;
  expiresAt: number | null;
  error: string | null;
  summary: string | null;
}

export interface SchedulerContextPackInput {
  name: string;
  instructions?: string;
  prompt?: string;
  contextPaths?: string[];
  variableValues?: Record<string, string>;
}

export interface SchedulerCreateJobInput {
  name?: string;
  schedule: SchedulerCreateScheduleInput;
  prompt?: string;
  promptFile?: string;
  contextPaths?: string[];
  imagePaths?: string[];
  contextPacks?: SchedulerContextPackInput[];
  macros?: string[];
  missedRunPolicy?: SchedulerMissedRunPolicy;
  missedRunGraceMs?: number;
  retryAttempts?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  retryFactor?: number;
  retryRandomize?: boolean;
  dedupeKey?: string;
  ttlMs?: number;
  maxDurationMs?: number;
  concurrencyKey?: string;
  concurrencyLimit?: number;
  historyLimit?: number;
  maxCatchUpRuns?: number;
  mode?: RuntimeSnapshot["mode"];
  profile?: string;
  provider?: RuntimeProvider;
  model?: string;
}

export interface SchedulerListJobsResult {
  workspaceRoot: string;
  jobs: SchedulerJobSummary[];
}

export interface SchedulerListRunsResult {
  workspaceRoot: string;
  runs: SchedulerRunSummary[];
}

export interface SchedulerJobActionResult {
  job: SchedulerJobSummary;
}

export interface SchedulerRunActionResult {
  run: SchedulerRunSummary;
}

export interface SchedulerRunHandle {
  jobId: string;
  runId: string;
}

export interface SchedulerEnqueueSummary {
  handle: SchedulerRunHandle;
  run: SchedulerRunSummary;
  deduplicated: boolean;
}

export interface SchedulerRunDueResult {
  queued: SchedulerRunSummary[];
  runs: SchedulerRunSummary[];
}

export interface SchedulerTriggerResult {
  queued: SchedulerEnqueueSummary;
  runs: SchedulerRunSummary[];
}

export interface SchedulerRetryResult {
  handle: SchedulerRunHandle;
  runs: SchedulerRunSummary[];
}

export interface SchedulerPromptDefinitionSummary {
  path: string;
  name: string;
  enabled: boolean;
  warnings: string[];
}

export interface SchedulerPromptSyncResult {
  workspaceRoot: string;
  discovered: SchedulerPromptDefinitionSummary[];
  syncedJobs: SchedulerJobSummary[];
  pausedJobs: SchedulerJobSummary[];
}

const DEFAULT_MOCK_WORKSPACE_ROOT = "/mock/home/path";
const DESKTOP_TASK_PROGRESS_EVENT = "desktop-task-progress";
const REMOTE_CONTROL_COMMAND_EVENT = "remote-control-command";
const REMOTE_CONTROL_COMMAND_KINDS = [
  "cancel",
  "retry",
  "continue",
  "follow-up",
  "approval-decision",
] as const satisfies ReadonlyArray<RemoteControlCommandKind>;
const SCHEDULER_JOB_STATUSES = [
  "active",
  "paused",
  "completed",
  "deleted",
] as const satisfies ReadonlyArray<SchedulerJobStatus>;
const SCHEDULER_RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
  "skipped",
] as const satisfies ReadonlyArray<SchedulerRunStatus>;
const SCHEDULER_RUN_SOURCES = [
  "schedule",
  "manual",
  "manual-retry",
] as const satisfies ReadonlyArray<SchedulerRunSource>;
const CLIPBOARD_IMAGE_EXTENSION_BY_MEDIA_TYPE: Record<
  AgentModelImageMediaType,
  string
> = {
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};
const TASK_EXECUTION_PROGRESS_STATES = [
  "starting",
  "resolving-context",
  "checking-inputs",
  "checking-tools",
  "planning",
  "executing",
  "verifying",
  "monitoring",
  "planned",
  "completed",
  "blocked",
  "unsupported",
  "cancelled",
] as const satisfies ReadonlyArray<TaskExecutionProgress["state"]>;
const TASK_EXECUTION_SECTION_AUDIENCES = [
  "user",
  "internal",
] as const satisfies ReadonlyArray<
  NonNullable<TaskExecutionProgress["outputSections"][number]["audience"]>
>;
const TASK_EXECUTION_SECTION_TONES = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
] as const satisfies ReadonlyArray<
  NonNullable<TaskExecutionProgress["outputSections"][number]["tone"]>
>;
const TASK_ACTION_OUTPUT_STREAMS = ["stdout", "stderr"] as const satisfies ReadonlyArray<
  TaskActionOutput["stream"]
>;
const MODEL_STREAM_KINDS = [
  "assistant",
  "tool-call",
  "reasoning",
  "status",
  "tool-result",
] as const satisfies ReadonlyArray<
  NonNullable<TaskExecutionProgress["modelStream"]>["kind"]
>;
const TASK_TIMELINE_EVENT_KINDS = [
  "state",
  "model-call",
  "tool-call",
  "retry",
  "validator",
  "output",
] as const satisfies ReadonlyArray<
  NonNullable<TaskExecutionProgress["timelineEvent"]>["kind"]
>;
const TASK_TIMELINE_EVENT_PHASES = [
  "started",
  "streaming",
  "completed",
  "failed",
  "skipped",
  "usage",
  "passed",
  "requested-continuation",
  "rejected",
] as const satisfies ReadonlyArray<
  NonNullable<TaskExecutionProgress["timelineEvent"]>["phase"]
>;
const TASK_TIMELINE_EVENT_TONES = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
] as const satisfies ReadonlyArray<
  NonNullable<TaskExecutionProgress["timelineEvent"]>["tone"]
>;

const canListenToDesktopTaskProgress = (): boolean => {
  const importMeta = import.meta as ImportMeta & {
    env?: { MODE?: string };
  };

  return tauriCore.isTauri() || importMeta.env?.MODE === "test";
};

const canInvokeTauriCommands = (): boolean => {
  return tauriCore.isTauri() && typeof tauriCore.invoke === "function";
};

const canEmitTauriWindowEvents = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  return tauriCore.isTauri() && "__TAURI_INTERNALS__" in window;
};

const normalizeWorkspaceRoot = (
  workspaceRoot: string | null | undefined,
): string | null => {
  const normalizedWorkspaceRoot = workspaceRoot?.trim();

  return normalizedWorkspaceRoot ? normalizedWorkspaceRoot : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isTimelineMetadataValue = (value: unknown): boolean => {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
};

const isTaskExecutionTokenUsage = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  return [
    value.inputTokens,
    value.outputTokens,
    value.totalTokens,
    value.cachedInputTokens,
    value.reasoningTokens,
  ].every(
    (entry) =>
      entry === undefined ||
      (typeof entry === "number" && Number.isFinite(entry) && entry >= 0),
  );
};

const isTaskExecutionTimelineEvent = (value: unknown): boolean => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    TASK_TIMELINE_EVENT_KINDS.includes(
      value.kind as NonNullable<TaskExecutionProgress["timelineEvent"]>["kind"],
    ) &&
    TASK_TIMELINE_EVENT_PHASES.includes(
      value.phase as NonNullable<
        TaskExecutionProgress["timelineEvent"]
      >["phase"],
    ) &&
    typeof value.label === "string" &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.tone === undefined ||
      TASK_TIMELINE_EVENT_TONES.includes(
        value.tone as NonNullable<
          TaskExecutionProgress["timelineEvent"]
        >["tone"],
      )) &&
    (value.provider === undefined ||
      MODEL_PROVIDERS.includes(
        value.provider as (typeof MODEL_PROVIDERS)[number],
      )) &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.toolName === undefined || typeof value.toolName === "string") &&
    (value.callId === undefined || typeof value.callId === "string") &&
    (value.stream === undefined ||
      TASK_ACTION_OUTPUT_STREAMS.includes(
        value.stream as TaskActionOutput["stream"],
      )) &&
    (value.tokenUsage === undefined ||
      isTaskExecutionTokenUsage(value.tokenUsage)) &&
    (value.metadata === undefined ||
      (isRecord(value.metadata) &&
        Object.values(value.metadata).every(isTimelineMetadataValue)))
  );
};

const isTaskExecutionProgress = (
  value: unknown,
): value is TaskExecutionProgress => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.task === "string" &&
    RUN_MODES.includes(value.mode as RuntimeSnapshot["mode"]) &&
    TASK_EXECUTION_PROGRESS_STATES.includes(
      value.state as TaskExecutionProgress["state"],
    ) &&
    typeof value.message === "string" &&
    Array.isArray(value.executedTools) &&
    value.executedTools.every((tool) => typeof tool === "string") &&
    Array.isArray(value.outputSections) &&
    value.outputSections.every((section) => {
      if (!isRecord(section)) {
        return false;
      }

      return (
        typeof section.title === "string" &&
        Array.isArray(section.lines) &&
        section.lines.every((line) => typeof line === "string") &&
        (section.audience === undefined ||
          TASK_EXECUTION_SECTION_AUDIENCES.includes(
            section.audience as NonNullable<
              TaskExecutionProgress["outputSections"][number]["audience"]
            >,
          )) &&
        (section.tone === undefined ||
          TASK_EXECUTION_SECTION_TONES.includes(
            section.tone as NonNullable<
              TaskExecutionProgress["outputSections"][number]["tone"]
            >,
          ))
      );
    }) &&
    typeof value.cancellable === "boolean" &&
    (value.reason === undefined || typeof value.reason === "string") &&
    (value.assistantText === undefined ||
      typeof value.assistantText === "string") &&
    (value.modelStream === undefined ||
      (isRecord(value.modelStream) &&
        MODEL_STREAM_KINDS.includes(
          value.modelStream.kind as NonNullable<
            TaskExecutionProgress["modelStream"]
          >["kind"],
        ) &&
        typeof value.modelStream.label === "string" &&
        typeof value.modelStream.content === "string" &&
        (value.modelStream.complete === undefined ||
          typeof value.modelStream.complete === "boolean"))) &&
    (value.actionOutput === undefined ||
      (isRecord(value.actionOutput) &&
        typeof value.actionOutput.toolName === "string" &&
        TASK_ACTION_OUTPUT_STREAMS.includes(
          value.actionOutput.stream as TaskActionOutput["stream"],
        ) &&
        typeof value.actionOutput.chunk === "string")) &&
    (value.timelineEvent === undefined ||
      isTaskExecutionTimelineEvent(value.timelineEvent))
  );
};

const isDesktopTaskProgressEvent = (
  value: unknown,
): value is DesktopTaskProgressEvent => {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.taskId === "string" &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    isTaskExecutionProgress(value.progress)
  );
};

const isRemoteControlLogEntry = (
  value: unknown,
): value is RemoteControlLogEntry => {
  return (
    isRecord(value) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.stream === "string" &&
    (value.toolName === undefined || typeof value.toolName === "string") &&
    typeof value.chunk === "string"
  );
};

const isRemoteControlTimelineEntry = (
  value: unknown,
): value is RemoteControlTimelineEntry => {
  return (
    isRecord(value) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.kind === "string" &&
    typeof value.phase === "string" &&
    typeof value.label === "string" &&
    (value.detail === undefined || typeof value.detail === "string") &&
    (value.tone === undefined || typeof value.tone === "string") &&
    (value.toolName === undefined || typeof value.toolName === "string")
  );
};

const isRemoteControlTaskSession = (
  value: unknown,
): value is RemoteControlTaskSession => {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.task === "string" &&
    typeof value.mode === "string" &&
    typeof value.state === "string" &&
    typeof value.message === "string" &&
    typeof value.cancellable === "boolean" &&
    typeof value.startedAt === "number" &&
    Number.isFinite(value.startedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt) &&
    typeof value.progressCount === "number" &&
    Number.isFinite(value.progressCount) &&
    Array.isArray(value.logs) &&
    value.logs.every(isRemoteControlLogEntry) &&
    Array.isArray(value.timeline) &&
    value.timeline.every(isRemoteControlTimelineEntry)
  );
};

const normalizeOptionalStringField = (
  value: unknown,
): string | undefined | null => {
  if (value === undefined || value === null) {
    return undefined;
  }

  return typeof value === "string" ? value : null;
};

const normalizeOptionalNumberField = (
  value: unknown,
): number | undefined | null => {
  if (value === undefined || value === null) {
    return undefined;
  }

  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const normalizeNullableStringField = (value: unknown): string | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === "string" ? value : null;
};

const normalizeNullableNumberField = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const isNullableStringPayloadField = (value: unknown): boolean => {
  return value === null || value === undefined || typeof value === "string";
};

const isNullableNumberPayloadField = (value: unknown): boolean => {
  return (
    value === null ||
    value === undefined ||
    (typeof value === "number" && Number.isFinite(value))
  );
};

const assignOptionalStringField = <Key extends keyof RemoteControlStatus>(
  status: RemoteControlStatus,
  key: Key,
  value: string | undefined,
): void => {
  if (value !== undefined) {
    Object.assign(status, { [key]: value });
  }
};

const assignOptionalNumberField = <Key extends keyof RemoteControlStatus>(
  status: RemoteControlStatus,
  key: Key,
  value: number | undefined,
): void => {
  if (value !== undefined) {
    Object.assign(status, { [key]: value });
  }
};

const normalizeRemoteControlStatus = (
  value: unknown,
): RemoteControlStatus | null => {
  if (
    !isRecord(value) ||
    typeof value.enabled !== "boolean" ||
    typeof value.eventId !== "number" ||
    !Number.isFinite(value.eventId) ||
    !Array.isArray(value.sessions) ||
    !value.sessions.every(isRemoteControlTaskSession)
  ) {
    return null;
  }

  const localUrl = normalizeOptionalStringField(value.localUrl);
  const lanUrl = normalizeOptionalStringField(value.lanUrl);
  const displayUrl = normalizeOptionalStringField(value.displayUrl);
  const qrSvg = normalizeOptionalStringField(value.qrSvg);
  const tokenHint = normalizeOptionalStringField(value.tokenHint);
  const startedAt = normalizeOptionalNumberField(value.startedAt);
  const bindAddress = normalizeOptionalStringField(value.bindAddress);
  const port = normalizeOptionalNumberField(value.port);
  const pairedDeviceCount = normalizeOptionalNumberField(value.pairedDeviceCount);

  if (
    localUrl === null ||
    lanUrl === null ||
    displayUrl === null ||
    qrSvg === null ||
    tokenHint === null ||
    startedAt === null ||
    bindAddress === null ||
    port === null ||
    pairedDeviceCount === null
  ) {
    return null;
  }

  const status: RemoteControlStatus = {
    enabled: value.enabled,
    eventId: value.eventId,
    sessions: value.sessions,
  };

  assignOptionalStringField(status, "localUrl", localUrl);
  assignOptionalStringField(status, "lanUrl", lanUrl);
  assignOptionalStringField(status, "displayUrl", displayUrl);
  assignOptionalStringField(status, "qrSvg", qrSvg);
  assignOptionalStringField(status, "tokenHint", tokenHint);
  assignOptionalNumberField(status, "startedAt", startedAt);
  assignOptionalStringField(status, "bindAddress", bindAddress);
  assignOptionalNumberField(status, "port", port);
  assignOptionalNumberField(status, "pairedDeviceCount", pairedDeviceCount);

  return status;
};

const isRemoteControlCommandEvent = (
  value: unknown,
): value is RemoteControlCommandEvent => {
  return (
    isRecord(value) &&
    typeof value.commandId === "string" &&
    REMOTE_CONTROL_COMMAND_KINDS.includes(
      value.kind as RemoteControlCommandKind,
    ) &&
    (value.taskId === undefined || typeof value.taskId === "string") &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    (value.decision === undefined || typeof value.decision === "string") &&
    (value.promptId === undefined || typeof value.promptId === "string") &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt)
  );
};

const isSchedulerScheduleSummary = (
  value: unknown,
): value is SchedulerScheduleSummary => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "cron":
      return (
        typeof value.expression === "string" &&
        typeof value.timezone === "string"
      );
    case "interval":
      return (
        typeof value.intervalMs === "number" &&
        Number.isFinite(value.intervalMs) &&
        typeof value.anchorAt === "number" &&
        Number.isFinite(value.anchorAt)
      );
    case "delay":
      return typeof value.runAt === "number" && Number.isFinite(value.runAt);
    default:
      return false;
  }
};

const isSchedulerRetrySummary = (
  value: unknown,
): value is SchedulerRetrySummary => {
  return (
    isRecord(value) &&
    typeof value.maxAttempts === "number" &&
    Number.isFinite(value.maxAttempts) &&
    typeof value.factor === "number" &&
    Number.isFinite(value.factor) &&
    typeof value.minTimeoutMs === "number" &&
    Number.isFinite(value.minTimeoutMs) &&
    typeof value.maxTimeoutMs === "number" &&
    Number.isFinite(value.maxTimeoutMs) &&
    typeof value.randomize === "boolean"
  );
};

const isSchedulerQueueSummary = (
  value: unknown,
): value is SchedulerQueueSummary => {
  return (
    isRecord(value) &&
    typeof value.concurrencyKey === "string" &&
    typeof value.concurrencyLimit === "number" &&
    Number.isFinite(value.concurrencyLimit)
  );
};

const normalizeSchedulerJobSummary = (
  value: unknown,
): SchedulerJobSummary | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !SCHEDULER_JOB_STATUSES.includes(value.status as SchedulerJobStatus) ||
    !isSchedulerScheduleSummary(value.schedule) ||
    typeof value.workspaceRoot !== "string" ||
    typeof value.prompt !== "string" ||
    !isNullableNumberPayloadField(value.nextRunAt) ||
    !isNullableNumberPayloadField(value.lastStartedAt) ||
    !isNullableNumberPayloadField(value.lastFinishedAt) ||
    !isSchedulerQueueSummary(value.queue) ||
    !isSchedulerRetrySummary(value.retry) ||
    !isNullableStringPayloadField(value.dedupeKey) ||
    !isNullableNumberPayloadField(value.ttlMs) ||
    !isNullableNumberPayloadField(value.maxDurationMs)
  ) {
    return null;
  }

  return {
    id: value.id,
    name: value.name,
    status: value.status as SchedulerJobStatus,
    schedule: value.schedule,
    workspaceRoot: value.workspaceRoot,
    prompt: value.prompt,
    nextRunAt: normalizeNullableNumberField(value.nextRunAt),
    lastStartedAt: normalizeNullableNumberField(value.lastStartedAt),
    lastFinishedAt: normalizeNullableNumberField(value.lastFinishedAt),
    queue: value.queue,
    retry: value.retry,
    dedupeKey: normalizeNullableStringField(value.dedupeKey),
    ttlMs: normalizeNullableNumberField(value.ttlMs),
    maxDurationMs: normalizeNullableNumberField(value.maxDurationMs),
  };
};

const normalizeSchedulerRunSummary = (
  value: unknown,
): SchedulerRunSummary | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.jobId !== "string" ||
    !SCHEDULER_RUN_SOURCES.includes(value.source as SchedulerRunSource) ||
    !SCHEDULER_RUN_STATUSES.includes(value.status as SchedulerRunStatus) ||
    typeof value.scheduledFor !== "number" ||
    !Number.isFinite(value.scheduledFor) ||
    typeof value.enqueuedAt !== "number" ||
    !Number.isFinite(value.enqueuedAt) ||
    typeof value.updatedAt !== "number" ||
    !Number.isFinite(value.updatedAt) ||
    typeof value.attempt !== "number" ||
    !Number.isFinite(value.attempt) ||
    typeof value.maxAttempts !== "number" ||
    !Number.isFinite(value.maxAttempts) ||
    typeof value.queueKey !== "string" ||
    !isNullableNumberPayloadField(value.startedAt) ||
    !isNullableNumberPayloadField(value.finishedAt) ||
    !isNullableNumberPayloadField(value.nextAttemptAt) ||
    !isNullableNumberPayloadField(value.expiresAt) ||
    !isNullableStringPayloadField(value.error) ||
    !isNullableStringPayloadField(value.summary)
  ) {
    return null;
  }

  return {
    id: value.id,
    jobId: value.jobId,
    source: value.source as SchedulerRunSource,
    status: value.status as SchedulerRunStatus,
    scheduledFor: value.scheduledFor,
    enqueuedAt: value.enqueuedAt,
    updatedAt: value.updatedAt,
    attempt: value.attempt,
    maxAttempts: value.maxAttempts,
    queueKey: value.queueKey,
    startedAt: normalizeNullableNumberField(value.startedAt),
    finishedAt: normalizeNullableNumberField(value.finishedAt),
    nextAttemptAt: normalizeNullableNumberField(value.nextAttemptAt),
    expiresAt: normalizeNullableNumberField(value.expiresAt),
    error: normalizeNullableStringField(value.error),
    summary: normalizeNullableStringField(value.summary),
  };
};

const normalizeSchedulerRunHandle = (
  value: unknown,
): SchedulerRunHandle | null => {
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    typeof value.runId !== "string"
  ) {
    return null;
  }

  return {
    jobId: value.jobId,
    runId: value.runId,
  };
};

const normalizeSchedulerEnqueueSummary = (
  value: unknown,
): SchedulerEnqueueSummary | null => {
  if (!isRecord(value) || typeof value.deduplicated !== "boolean") {
    return null;
  }

  const handle = normalizeSchedulerRunHandle(value.handle);
  const run = normalizeSchedulerRunSummary(value.run);

  if (!handle || !run) {
    return null;
  }

  return {
    handle,
    run,
    deduplicated: value.deduplicated,
  };
};

const normalizeSchedulerJobList = (
  value: unknown,
): SchedulerJobSummary[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const jobs = value.map(normalizeSchedulerJobSummary);

  return jobs.every((job): job is SchedulerJobSummary => Boolean(job))
    ? jobs
    : null;
};

const normalizeSchedulerRunList = (
  value: unknown,
): SchedulerRunSummary[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const runs = value.map(normalizeSchedulerRunSummary);

  return runs.every((run): run is SchedulerRunSummary => Boolean(run))
    ? runs
    : null;
};

const normalizeSchedulerListJobsResult = (
  value: unknown,
): SchedulerListJobsResult | null => {
  if (!isRecord(value) || typeof value.workspaceRoot !== "string") {
    return null;
  }

  const jobs = normalizeSchedulerJobList(value.jobs);

  if (!jobs) {
    return null;
  }

  return {
    workspaceRoot: value.workspaceRoot,
    jobs,
  };
};

const normalizeSchedulerListRunsResult = (
  value: unknown,
): SchedulerListRunsResult | null => {
  if (!isRecord(value) || typeof value.workspaceRoot !== "string") {
    return null;
  }

  const runs = normalizeSchedulerRunList(value.runs);

  if (!runs) {
    return null;
  }

  return {
    workspaceRoot: value.workspaceRoot,
    runs,
  };
};

const normalizeSchedulerJobActionResult = (
  value: unknown,
): SchedulerJobActionResult | null => {
  if (!isRecord(value)) {
    return null;
  }

  const job = normalizeSchedulerJobSummary(value.job);

  return job ? { job } : null;
};

const normalizeSchedulerRunActionResult = (
  value: unknown,
): SchedulerRunActionResult | null => {
  if (!isRecord(value)) {
    return null;
  }

  const run = normalizeSchedulerRunSummary(value.run);

  return run ? { run } : null;
};

const normalizeSchedulerRunDueResult = (
  value: unknown,
): SchedulerRunDueResult | null => {
  if (!isRecord(value)) {
    return null;
  }

  const queued = normalizeSchedulerRunList(value.queued);
  const runs = normalizeSchedulerRunList(value.runs);

  if (!queued || !runs) {
    return null;
  }

  return {
    queued,
    runs,
  };
};

const normalizeSchedulerTriggerResult = (
  value: unknown,
): SchedulerTriggerResult | null => {
  if (!isRecord(value)) {
    return null;
  }

  const queued = normalizeSchedulerEnqueueSummary(value.queued);
  const runs = normalizeSchedulerRunList(value.runs);

  if (!queued || !runs) {
    return null;
  }

  return {
    queued,
    runs,
  };
};

const normalizeSchedulerRetryResult = (
  value: unknown,
): SchedulerRetryResult | null => {
  if (!isRecord(value)) {
    return null;
  }

  const handle = normalizeSchedulerRunHandle(value.handle);
  const runs = normalizeSchedulerRunList(value.runs);

  if (!handle || !runs) {
    return null;
  }

  return {
    handle,
    runs,
  };
};

const normalizeSchedulerPromptDefinitionSummary = (
  value: unknown,
): SchedulerPromptDefinitionSummary | null => {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.name !== "string" ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((warning) => typeof warning === "string")
  ) {
    return null;
  }

  return {
    path: value.path,
    name: value.name,
    enabled: value.enabled,
    warnings: value.warnings,
  };
};

const normalizeSchedulerPromptSyncResult = (
  value: unknown,
): SchedulerPromptSyncResult | null => {
  if (
    !isRecord(value) ||
    typeof value.workspaceRoot !== "string" ||
    !Array.isArray(value.discovered)
  ) {
    return null;
  }

  const discovered = value.discovered.map(
    normalizeSchedulerPromptDefinitionSummary,
  );
  const syncedJobs = normalizeSchedulerJobList(value.syncedJobs);
  const pausedJobs = normalizeSchedulerJobList(value.pausedJobs ?? []);

  if (
    !syncedJobs ||
    !pausedJobs ||
    !discovered.every(
      (definition): definition is SchedulerPromptDefinitionSummary =>
        Boolean(definition),
    )
  ) {
    return null;
  }

  return {
    workspaceRoot: value.workspaceRoot,
    discovered,
    syncedJobs,
    pausedJobs,
  };
};

const createProviderAvailabilitySnapshot = (
  configuredProviders: RuntimeProvider[],
): RuntimeProviderAvailability[] => {
  return SUPPORTED_PROVIDER_ORDER.map((provider) => ({
    provider,
    configured: configuredProviders.includes(provider),
  }));
};

const createOptimisticProviderAvailability =
  (): RuntimeProviderAvailability[] => {
    return createProviderAvailabilitySnapshot([...SUPPORTED_PROVIDER_ORDER]);
  };

const createUnavailableProviderAvailability =
  (): RuntimeProviderAvailability[] => {
    return createProviderAvailabilitySnapshot([]);
  };

const createUnavailableProviderModelCatalog =
  (): ProviderModelCatalogSnapshot => ({
    generatedAt: Date.now(),
    providers: SUPPORTED_PROVIDER_ORDER.map((provider) => ({
      provider,
      source: "curated-fallback",
      available: false,
      error: "Provider model discovery is unavailable in this runtime.",
      models: [],
    })),
  });

const createWebSearchAvailabilitySnapshot = (
  configuredProviders: UserWebSearchApiKeyProvider[],
): WebSearchProviderAvailability[] => {
  return USER_WEB_SEARCH_PROVIDER_ORDER.map((provider) => ({
    provider,
    configured: configuredProviders.includes(provider),
  }));
};

const createUnavailableWebSearchAvailability =
  (): WebSearchProviderAvailability[] => {
    return createWebSearchAvailabilitySnapshot([]);
  };

const createDefaultUserWebSearchSettings = (): UserWebSearchSettings => {
  return {
    activeProvider: "none",
    apiKeys: {},
    providerAvailability: createUnavailableWebSearchAvailability(),
  };
};

const createVoiceAvailabilitySnapshot = (
  configuredProviders: UserVoiceAiProvider[],
): VoiceProviderAvailability[] => {
  return USER_VOICE_AI_PROVIDER_ORDER.map((provider) => ({
    provider,
    configured: configuredProviders.includes(provider),
  }));
};

const createDefaultUserVoiceSettings = (): UserVoiceSettings => {
  return {
    activeProvider: "none",
    providerAvailability: createVoiceAvailabilitySnapshot([]),
  };
};

const createSpeechToTextAvailabilitySnapshot = (
  configuredProviders: UserSpeechToTextProvider[],
): SpeechToTextProviderAvailability[] => {
  return USER_SPEECH_TO_TEXT_PROVIDER_ORDER.map((provider) => ({
    provider,
    configured: configuredProviders.includes(provider),
  }));
};

const createDefaultUserSpeechToTextSettings = (): UserSpeechToTextSettings => {
  return {
    activeProvider: "none",
    inputDeviceId: null,
    providerAvailability: createSpeechToTextAvailabilitySnapshot([]),
  };
};

const createDefaultUserMemorySettings = (): UserMemorySettings => {
  return {
    globalEnabled: false,
    entries: [],
  };
};

const clampIntegerSetting = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
};

const clampNumberSetting = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, value));
};

const createDefaultUserAgentLimitsSettings =
  (): UserAgentLimitsSettings => {
    return { ...DEFAULT_USER_AGENT_LIMITS_SETTINGS };
  };

const createDefaultUserReviewModelSettings =
  (): UserReviewModelSettings => {
    return { ...DEFAULT_USER_REVIEW_MODEL_SETTINGS };
  };

const normalizeUserAgentLimitsSettings = (
  settings: UserAgentLimitsSettings,
): UserAgentLimitsSettings => {
  return {
    infinite: settings.infinite === true,
    executorTurns: clampIntegerSetting(
      settings.executorTurns,
      AGENT_LIMIT_BOUNDS.executorTurns.min,
      AGENT_LIMIT_BOUNDS.executorTurns.max,
      DEFAULT_USER_AGENT_LIMITS_SETTINGS.executorTurns,
    ),
    autopilotExecutorIterations: clampIntegerSetting(
      settings.autopilotExecutorIterations,
      AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.min,
      AGENT_LIMIT_BOUNDS.autopilotExecutorIterations.max,
      DEFAULT_USER_AGENT_LIMITS_SETTINGS.autopilotExecutorIterations,
    ),
  };
};

const normalizeUserReviewModelSettings = (
  settings: UserReviewModelSettings,
): UserReviewModelSettings => {
  const provider = settings.provider?.trim();
  const model = settings.model?.trim();

  if (
    settings.mode !== "dedicated" ||
    !provider ||
    !VALID_MODEL_PROVIDERS.includes(provider as (typeof VALID_MODEL_PROVIDERS)[number]) ||
    !model
  ) {
    return { mode: "base" };
  }

  return {
    mode: "dedicated",
    provider: provider as (typeof VALID_MODEL_PROVIDERS)[number],
    model,
  };
};

const createDefaultUserDesktopSettings = (): UserDesktopSettings => {
  return { ...DEFAULT_USER_DESKTOP_SETTINGS };
};

const normalizeUserDesktopSettings = (
  settings: UserDesktopSettings,
): UserDesktopSettings => {
  const quickVoiceShortcut =
    settings.quickVoiceShortcut.trim() ||
    DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceShortcut;

  return {
    ...settings,
    quickVoiceShortcut,
    assistantBubbleTemporarilyHideSeconds: clampIntegerSetting(
      settings.assistantBubbleTemporarilyHideSeconds,
      DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.min,
      DESKTOP_SETTING_BOUNDS.assistantBubbleTemporarilyHideSeconds.max,
      DEFAULT_USER_DESKTOP_SETTINGS.assistantBubbleTemporarilyHideSeconds,
    ),
    aiContextMaxMessages: clampIntegerSetting(
      settings.aiContextMaxMessages,
      DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.min,
      DESKTOP_SETTING_BOUNDS.aiContextMaxMessages.max,
      DEFAULT_USER_DESKTOP_SETTINGS.aiContextMaxMessages,
    ),
    inactiveSessionArchiveDays: clampIntegerSetting(
      settings.inactiveSessionArchiveDays,
      DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays.min,
      DESKTOP_SETTING_BOUNDS.inactiveSessionArchiveDays.max,
      DEFAULT_USER_DESKTOP_SETTINGS.inactiveSessionArchiveDays,
    ),
    archivedSessionRetentionDays: clampIntegerSetting(
      settings.archivedSessionRetentionDays,
      DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays.min,
      DESKTOP_SETTING_BOUNDS.archivedSessionRetentionDays.max,
      DEFAULT_USER_DESKTOP_SETTINGS.archivedSessionRetentionDays,
    ),
    quickVoiceSilenceSeconds: clampNumberSetting(
      settings.quickVoiceSilenceSeconds,
      DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.min,
      DESKTOP_SETTING_BOUNDS.quickVoiceSilenceSeconds.max,
      DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceSilenceSeconds,
    ),
    quickVoiceMaxMessages: clampIntegerSetting(
      settings.quickVoiceMaxMessages,
      DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.min,
      DESKTOP_SETTING_BOUNDS.quickVoiceMaxMessages.max,
      DEFAULT_USER_DESKTOP_SETTINGS.quickVoiceMaxMessages,
    ),
  };
};

const getFallbackDroppedPathName = (path: string): string => {
  const normalizedPath = path.replace(/\\/gu, "/");
  const name = normalizedPath.split("/").filter(Boolean).at(-1);

  return name ?? path;
};

const getFallbackDroppedPathParent = (path: string): string | undefined => {
  const lastSeparatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));

  if (lastSeparatorIndex <= 0) {
    return undefined;
  }

  return path.slice(0, lastSeparatorIndex);
};

const createFallbackDroppedPathsResolution = (
  paths: string[],
): DroppedPathsResolution => {
  const entries = paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .map((path) => {
      const parent = getFallbackDroppedPathParent(path);

      return {
        path,
        kind: "other",
        name: getFallbackDroppedPathName(path),
        ...(parent ? { parent } : {}),
      } satisfies DroppedPathEntry;
    });

  return {
    entries,
    workspaceRoot: entries[0]?.parent ?? null,
  };
};

const normalizeClipboardImageMediaType = (
  mediaType: string | undefined,
): AgentModelImageMediaType | undefined => {
  const normalizedMediaType = mediaType?.trim().toLowerCase();

  return normalizedMediaType &&
    normalizedMediaType in CLIPBOARD_IMAGE_EXTENSION_BY_MEDIA_TYPE
    ? (normalizedMediaType as AgentModelImageMediaType)
    : undefined;
};

const getFallbackClipboardImagePath = (
  mediaType: AgentModelImageMediaType,
  fileName: string | undefined,
): string => {
  const normalizedFileName = fileName?.trim();

  return `/mock/${normalizedFileName || `clipboard-image.${CLIPBOARD_IMAGE_EXTENSION_BY_MEDIA_TYPE[mediaType]}`}`;
};

const encodeBinaryStringAsBase64 = (binary: string): string => {
  if (typeof btoa === "function") {
    return btoa(binary);
  }

  return Buffer.from(binary, "binary").toString("base64");
};

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 32_768;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return encodeBinaryStringAsBase64(binary);
};

const emitDesktopSettingsChanged = async (
  settings: UserDesktopSettings,
): Promise<void> => {
  if (!canEmitTauriWindowEvents()) {
    return;
  }

  try {
    await getCurrentWindow().emit(DESKTOP_SETTINGS_CHANGED_EVENT, settings);
  } catch (error) {
    console.error("Failed to broadcast desktop settings update", error);
  }
};

const loadTauriValueOrFallback = async <T>(
  command: string,
  fallback: () => T,
  errorMessage: string,
  errorFallback: () => T = fallback,
): Promise<T> => {
  if (!canInvokeTauriCommands()) {
    return fallback();
  }

  try {
    return await tauriCore.invoke<T>(command);
  } catch (error) {
    console.error(errorMessage, error);
    return errorFallback();
  }
};

export const loadGlobalProviderAvailability = async (): Promise<
  RuntimeProviderAvailability[]
> => {
  return loadTauriValueOrFallback(
    "get_global_provider_availability",
    createOptimisticProviderAvailability,
    "Failed to load global provider availability",
    createUnavailableProviderAvailability,
  );
};

export const loadProviderModelCatalog =
  async (): Promise<ProviderModelCatalogSnapshot> => {
    return loadTauriValueOrFallback(
      "get_provider_model_catalog",
      createUnavailableProviderModelCatalog,
      "Failed to load provider model catalog",
    );
  };

export const loadUserProviderApiKeys =
  async (): Promise<UserProviderApiKeys> => {
    return loadTauriValueOrFallback(
      "get_user_provider_api_keys",
      () => ({}),
      "Failed to load user provider API keys",
    );
  };

export const saveUserProviderApiKey = async (
  provider: UserApiKeyProvider,
  apiKey: string,
): Promise<RuntimeProviderAvailability[]> => {
  const normalizedApiKey = apiKey.trim();

  if (!normalizedApiKey) {
    throw new Error("Expected a non-empty API key.");
  }

  if (!canInvokeTauriCommands()) {
    return createProviderAvailabilitySnapshot([provider]);
  }

  try {
    return await tauriCore.invoke<RuntimeProviderAvailability[]>(
      "save_user_provider_api_key",
      {
        provider,
        apiKey: normalizedApiKey,
      },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const openUserProviderApiKeyPortal = async (
  provider: UserApiKeyProvider,
): Promise<void> => {
  const portalUrl = USER_API_KEY_PROVIDER_PORTAL_URLS[provider];

  if (tauriCore.isTauri()) {
    try {
      await openUrl(portalUrl);
      return;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(portalUrl, "_blank", "noopener,noreferrer");
    return;
  }

  throw new Error("The provider API key page could not be opened.");
};

export const loadUserWebSearchSettings =
  async (): Promise<UserWebSearchSettings> => {
    return loadTauriValueOrFallback(
      "get_user_web_search_settings",
      createDefaultUserWebSearchSettings,
      "Failed to load user web-search settings",
    );
  };

export const loadUserVoiceSettings = async (): Promise<UserVoiceSettings> => {
  return loadTauriValueOrFallback(
    "get_user_voice_settings",
    createDefaultUserVoiceSettings,
    "Failed to load user voice settings",
  );
};

export const loadUserSpeechToTextSettings =
  async (): Promise<UserSpeechToTextSettings> => {
    return loadTauriValueOrFallback(
      "get_user_speech_to_text_settings",
      createDefaultUserSpeechToTextSettings,
      "Failed to load user speech-to-text settings",
    );
  };

export const loadUserDesktopSettings =
  async (): Promise<UserDesktopSettings> => {
    return loadTauriValueOrFallback(
      "get_user_desktop_settings",
      createDefaultUserDesktopSettings,
      "Failed to load user desktop settings",
    );
  };

export const loadUserMemorySettings = async (): Promise<UserMemorySettings> => {
  return loadTauriValueOrFallback(
    "get_user_memory_settings",
    createDefaultUserMemorySettings,
    "Failed to load user memory settings",
  );
};

export const loadUserAgentLimitsSettings =
  async (): Promise<UserAgentLimitsSettings> => {
    return loadTauriValueOrFallback(
      "get_user_agent_limits_settings",
      createDefaultUserAgentLimitsSettings,
      "Failed to load user agent limit settings",
    );
  };

export const loadUserReviewModelSettings =
  async (): Promise<UserReviewModelSettings> => {
    return loadTauriValueOrFallback(
      "get_user_review_model_settings",
      createDefaultUserReviewModelSettings,
      "Failed to load user review-model settings",
    );
  };

export const loadDesktopLaunchId = async (): Promise<string | null> => {
  return loadTauriValueOrFallback<string | null>(
    "get_desktop_launch_id",
    () => null,
    "Failed to load desktop launch ID",
    () => null,
  );
};

export const loadActiveDesktopTaskIds = async (): Promise<string[] | null> => {
  if (!canInvokeTauriCommands()) {
    return null;
  }

  try {
    return await tauriCore.invoke<string[]>("get_active_desktop_task_ids");
  } catch (error) {
    console.error("Failed to load active desktop task IDs", error);
    return null;
  }
};

export const saveUserGlobalMemoryEnabled = async (
  enabled: boolean,
): Promise<UserMemorySettings> => {
  if (!canInvokeTauriCommands()) {
    return {
      ...createDefaultUserMemorySettings(),
      globalEnabled: enabled,
    };
  }

  try {
    return await tauriCore.invoke<UserMemorySettings>(
      "save_user_global_memory_enabled",
      { enabled },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveUserDesktopSettings = async (
  settings: UserDesktopSettings,
): Promise<UserDesktopSettings> => {
  const normalizedSettings = normalizeUserDesktopSettings(settings);

  if (!canInvokeTauriCommands()) {
    const nextSettings = {
      ...createDefaultUserDesktopSettings(),
      ...normalizedSettings,
    };

    await emitDesktopSettingsChanged(nextSettings);
    return nextSettings;
  }

  try {
    const nextSettings = await tauriCore.invoke<UserDesktopSettings>(
      "save_user_desktop_settings",
      { settings: normalizedSettings },
    );

    await emitDesktopSettingsChanged(nextSettings);
    return nextSettings;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveUserAgentLimitsSettings = async (
  settings: UserAgentLimitsSettings,
): Promise<UserAgentLimitsSettings> => {
  const normalizedSettings = normalizeUserAgentLimitsSettings(settings);

  if (!canInvokeTauriCommands()) {
    return normalizedSettings;
  }

  try {
    return await tauriCore.invoke<UserAgentLimitsSettings>(
      "save_user_agent_limits_settings",
      { settings: normalizedSettings },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveUserReviewModelSettings = async (
  settings: UserReviewModelSettings,
): Promise<UserReviewModelSettings> => {
  const normalizedSettings = normalizeUserReviewModelSettings(settings);

  if (!canInvokeTauriCommands()) {
    return normalizedSettings;
  }

  try {
    return await tauriCore.invoke<UserReviewModelSettings>(
      "save_user_review_model_settings",
      { settings: normalizedSettings },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const subscribeToDesktopSettingsChanged = async (
  onChange: (settings: UserDesktopSettings) => void,
): Promise<() => void> => {
  if (!canEmitTauriWindowEvents()) {
    return () => {};
  }

  try {
    return await listen<UserDesktopSettings>(
      DESKTOP_SETTINGS_CHANGED_EVENT,
      (event) => {
        onChange(event.payload);
      },
    );
  } catch (error) {
    console.error("Failed to subscribe to desktop settings updates", error);
    return () => {};
  }
};

export const detectFullscreenWindowOnMonitor = async (
  monitor: MonitorBoundsInput,
): Promise<boolean> => {
  if (!canInvokeTauriCommands()) {
    return false;
  }

  try {
    return await tauriCore.invoke<boolean>(
      "detect_fullscreen_window_on_monitor",
      { monitor },
    );
  } catch (error) {
    console.error("Failed to detect fullscreen window on monitor", error);
    return false;
  }
};

export const saveUserWebSearchApiKey = async (
  provider: UserWebSearchApiKeyProvider,
  apiKey: string,
): Promise<UserWebSearchSettings> => {
  const normalizedApiKey = apiKey.trim();

  if (!normalizedApiKey) {
    throw new Error("Expected a non-empty API key.");
  }

  if (!canInvokeTauriCommands()) {
    return {
      ...createDefaultUserWebSearchSettings(),
      apiKeys: {
        [provider]: normalizedApiKey,
      },
      providerAvailability: createWebSearchAvailabilitySnapshot([provider]),
    };
  }

  try {
    return await tauriCore.invoke<UserWebSearchSettings>(
      "save_user_web_search_api_key",
      {
        provider,
        apiKey: normalizedApiKey,
      },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveUserWebSearchActiveProvider = async (
  provider: WebSearchProvider,
): Promise<UserWebSearchSettings> => {
  if (!canInvokeTauriCommands()) {
    return {
      ...createDefaultUserWebSearchSettings(),
      activeProvider: provider,
    };
  }

  try {
    return await tauriCore.invoke<UserWebSearchSettings>(
      "save_user_web_search_active_provider",
      {
        provider,
      },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveUserVoiceActiveProvider = async (
  provider: VoiceAiProvider,
): Promise<UserVoiceSettings> => {
  if (!canInvokeTauriCommands()) {
    return {
      ...createDefaultUserVoiceSettings(),
      activeProvider: provider,
    };
  }

  try {
    return await tauriCore.invoke<UserVoiceSettings>(
      "save_user_voice_active_provider",
      { provider },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveUserSpeechToTextActiveProvider = async (
  provider: SpeechToTextProvider,
): Promise<UserSpeechToTextSettings> => {
  if (!canInvokeTauriCommands()) {
    return {
      ...createDefaultUserSpeechToTextSettings(),
      activeProvider: provider,
    };
  }

  try {
    return await tauriCore.invoke<UserSpeechToTextSettings>(
      "save_user_speech_to_text_active_provider",
      { provider },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveUserSpeechToTextInputDevice = async (
  inputDeviceId: string | null,
): Promise<UserSpeechToTextSettings> => {
  const normalizedInputDeviceId = inputDeviceId?.trim() || null;

  if (!canInvokeTauriCommands()) {
    return {
      ...createDefaultUserSpeechToTextSettings(),
      inputDeviceId: normalizedInputDeviceId,
    };
  }

  try {
    return await tauriCore.invoke<UserSpeechToTextSettings>(
      "save_user_speech_to_text_input_device",
      { inputDeviceId: normalizedInputDeviceId },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const synthesizeUserVoiceAudio = async (options: {
  provider: UserVoiceAiProvider;
  text: string;
  languageCode?: string;
  rate?: number;
}): Promise<SynthesizedVoiceAudio> => {
  const normalizedText = options.text.trim();

  if (!normalizedText) {
    throw new Error("Expected non-empty text to synthesize.");
  }

  if (!canInvokeTauriCommands()) {
    throw new Error(
      "AI voice synthesis is only available in the desktop runtime.",
    );
  }

  try {
    return await tauriCore.invoke<SynthesizedVoiceAudio>(
      "synthesize_user_voice_audio",
      {
        provider: options.provider,
        text: normalizedText,
        ...(options.languageCode?.trim()
          ? { languageCode: options.languageCode.trim() }
          : {}),
        ...(typeof options.rate === "number" && Number.isFinite(options.rate)
          ? { rate: options.rate }
          : {}),
      },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const transcribeUserSpeechAudio = async (options: {
  provider: UserSpeechToTextProvider;
  audioBase64: string;
  mimeType: string;
  languageCode?: string;
}): Promise<TranscribedSpeechText> => {
  const normalizedAudioBase64 = options.audioBase64.trim();
  const normalizedMimeType = options.mimeType.trim();

  if (!normalizedAudioBase64) {
    throw new Error("Expected non-empty audio data to transcribe.");
  }

  if (!normalizedMimeType) {
    throw new Error("Expected an audio MIME type.");
  }

  if (!canInvokeTauriCommands()) {
    throw new Error(
      "AI speech-to-text is only available in the desktop runtime.",
    );
  }

  try {
    return await tauriCore.invoke<TranscribedSpeechText>(
      "transcribe_user_speech_audio",
      {
        provider: options.provider,
        audioBase64: normalizedAudioBase64,
        mimeType: normalizedMimeType,
        ...(options.languageCode?.trim()
          ? { languageCode: options.languageCode.trim() }
          : {}),
      },
    );
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const loadWorkspaceRuntimeSnapshot = async (
  workspaceRoot: string | null | undefined,
  profile?: string | null,
): Promise<RuntimeSnapshot | null> => {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const normalizedProfile = profile?.trim();

  if (!canInvokeTauriCommands()) {
    return null;
  }

  try {
    return await tauriCore.invoke<RuntimeSnapshot>("get_runtime_snapshot", {
      workspaceRoot: normalizedWorkspaceRoot ?? "",
      ...(normalizedProfile ? { profile: normalizedProfile } : {}),
    });
  } catch (error) {
    console.error("Failed to load runtime snapshot", error);
    return null;
  }
};

export const cancelDesktopTask = async (taskId: string): Promise<void> => {
  if (canInvokeTauriCommands()) {
    return await tauriCore.invoke("cancel_desktop_task", { taskId });
  }
};

export const getRemoteControlStatus =
  async (): Promise<RemoteControlStatus | null> => {
    if (!canInvokeTauriCommands()) {
      return {
        enabled: false,
        eventId: 0,
        sessions: [],
      };
    }

    const status = normalizeRemoteControlStatus(
      await tauriCore.invoke<unknown>("get_remote_control_status"),
    );

    if (!status) {
      throw new Error("The Mission Control status payload was invalid.");
    }

    return status;
  };

export const enableRemoteControlServer =
  async (): Promise<RemoteControlStatus | null> => {
    if (!canInvokeTauriCommands()) {
      return {
        enabled: false,
        eventId: 0,
        sessions: [],
      };
    }

    const status = normalizeRemoteControlStatus(
      await tauriCore.invoke<unknown>("enable_remote_control_server"),
    );

    if (!status) {
      throw new Error("The Mission Control enable payload was invalid.");
    }

    return status;
  };

export const disableRemoteControlServer =
  async (): Promise<RemoteControlStatus | null> => {
    if (!canInvokeTauriCommands()) {
      return {
        enabled: false,
        eventId: 0,
        sessions: [],
      };
    }

    const status = normalizeRemoteControlStatus(
      await tauriCore.invoke<unknown>("disable_remote_control_server"),
    );

    if (!status) {
      throw new Error("The Mission Control disable payload was invalid.");
    }

    return status;
  };

export const setRemoteControlPort = async (
  port: number,
): Promise<RemoteControlStatus | null> => {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Mission Control port must be between 1024 and 65535.");
  }

  if (!canInvokeTauriCommands()) {
    return {
      enabled: false,
      eventId: 0,
      port,
      sessions: [],
    };
  }

  const status = normalizeRemoteControlStatus(
    await tauriCore.invoke<unknown>("set_remote_control_port", { port }),
  );

  if (!status) {
    throw new Error("The Mission Control port payload was invalid.");
  }

  return status;
};

export const forgetRemoteControlPairings =
  async (): Promise<RemoteControlStatus | null> => {
    if (!canInvokeTauriCommands()) {
      return {
        enabled: false,
        eventId: 0,
        pairedDeviceCount: 0,
        sessions: [],
      };
    }

    const status = normalizeRemoteControlStatus(
      await tauriCore.invoke<unknown>("forget_remote_control_pairings"),
    );

    if (!status) {
      throw new Error("The Mission Control pairing payload was invalid.");
    }

    return status;
  };

export const openRemoteControlUrl = async (
  displayUrl?: string,
): Promise<void> => {
  if (canInvokeTauriCommands()) {
    return await tauriCore.invoke("open_remote_control_url");
  }

  if (
    displayUrl &&
    typeof window !== "undefined" &&
    typeof window.open === "function"
  ) {
    window.open(displayUrl, "_blank", "noopener,noreferrer");
    return;
  }

  throw new Error("Mission Control could not be opened.");
};

const assertSchedulerDesktopAvailable = (): never => {
  throw new Error("Scheduler management is only available in the desktop app.");
};

const normalizeSchedulerCommandWorkspace = (
  workspaceRoot: string | null | undefined,
): string => {
  return normalizeWorkspaceRoot(workspaceRoot) ?? "";
};

const runSchedulerCommand = async <Result>(
  workspaceRoot: string | null | undefined,
  argumentsList: string[],
  normalize: (value: unknown) => Result | null,
  invalidPayloadMessage: string,
  fallback: () => Result,
): Promise<Result> => {
  if (!canInvokeTauriCommands()) {
    return fallback();
  }

  try {
    const response = await tauriCore.invoke<unknown>("run_scheduler_command", {
      request: {
        workspaceRoot: normalizeSchedulerCommandWorkspace(workspaceRoot),
        arguments: argumentsList,
      },
    });
    const normalizedResponse = normalize(response);

    if (!normalizedResponse) {
      throw new Error(invalidPayloadMessage);
    }

    return normalizedResponse;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

const normalizeSchedulerCliString = (
  value: string | null | undefined,
): string | undefined => {
  const normalizedValue = value?.trim();

  return normalizedValue ? normalizedValue : undefined;
};

const normalizeSchedulerCliStringList = (
  values: string[] | undefined,
): string[] => {
  return Array.from(
    new Set(
      (values ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
};

const appendSchedulerOption = (
  argumentsList: string[],
  flag: string,
  value: string | number | boolean | undefined,
): void => {
  if (value === undefined || value === "") {
    return;
  }

  argumentsList.push(flag);
  argumentsList.push(typeof value === "boolean" ? (value ? "on" : "off") : String(value));
};

const appendSchedulerRepeatedOption = (
  argumentsList: string[],
  flag: string,
  values: string[] | undefined,
): void => {
  for (const value of normalizeSchedulerCliStringList(values)) {
    argumentsList.push(flag);
    argumentsList.push(value);
  }
};

const serializeSchedulerContextPack = (
  pack: SchedulerContextPackInput,
): string => {
  const name = normalizeSchedulerCliString(pack.name);

  if (!name) {
    throw new Error("Expected each scheduled context pack to include a name.");
  }

  const instructions = normalizeSchedulerCliString(pack.instructions);
  const prompt = normalizeSchedulerCliString(pack.prompt);
  const contextPaths = normalizeSchedulerCliStringList(pack.contextPaths);
  const variableValues = pack.variableValues
    ? Object.fromEntries(
        Object.entries(pack.variableValues).filter(
          (entry): entry is [string, string] =>
            typeof entry[1] === "string" && entry[1].trim().length > 0,
        ),
      )
    : undefined;

  return JSON.stringify({
    name,
    ...(instructions ? { instructions } : {}),
    ...(prompt ? { prompt } : {}),
    ...(contextPaths.length > 0 ? { contextPaths } : {}),
    ...(variableValues && Object.keys(variableValues).length > 0
      ? { variableValues }
      : {}),
  });
};

const appendSchedulerCreateSchedule = (
  argumentsList: string[],
  schedule: SchedulerCreateScheduleInput,
): void => {
  switch (schedule.type) {
    case "cron":
      appendSchedulerOption(argumentsList, "--cron", schedule.expression);
      appendSchedulerOption(
        argumentsList,
        "--timezone",
        normalizeSchedulerCliString(schedule.timezone),
      );
      return;
    case "interval":
      appendSchedulerOption(argumentsList, "--interval-ms", schedule.intervalMs);
      return;
    case "delay":
      appendSchedulerOption(argumentsList, "--delay-ms", schedule.delayMs);
      appendSchedulerOption(argumentsList, "--run-at", schedule.runAt);
      return;
  }
};

const createSchedulerCreateArguments = (
  input: SchedulerCreateJobInput,
): string[] => {
  const argumentsList = ["create"];
  const prompt = normalizeSchedulerCliString(input.prompt);
  const promptFile = normalizeSchedulerCliString(input.promptFile);

  if (!prompt && !promptFile) {
    throw new Error("Expected a prompt or prompt file before creating a scheduled job.");
  }

  appendSchedulerOption(argumentsList, "--name", normalizeSchedulerCliString(input.name));
  appendSchedulerCreateSchedule(argumentsList, input.schedule);
  appendSchedulerOption(argumentsList, "--prompt", prompt);
  appendSchedulerOption(argumentsList, "--prompt-file", promptFile);
  appendSchedulerRepeatedOption(argumentsList, "--context", input.contextPaths);
  appendSchedulerRepeatedOption(argumentsList, "--image", input.imagePaths);
  appendSchedulerRepeatedOption(
    argumentsList,
    "--context-pack",
    input.contextPacks?.map(serializeSchedulerContextPack),
  );
  appendSchedulerRepeatedOption(argumentsList, "--macro", input.macros);
  appendSchedulerOption(argumentsList, "--missed-run-policy", input.missedRunPolicy);
  appendSchedulerOption(argumentsList, "--missed-run-grace-ms", input.missedRunGraceMs);
  appendSchedulerOption(argumentsList, "--retry-attempts", input.retryAttempts);
  appendSchedulerOption(argumentsList, "--retry-min-ms", input.retryMinMs);
  appendSchedulerOption(argumentsList, "--retry-max-ms", input.retryMaxMs);
  appendSchedulerOption(argumentsList, "--retry-factor", input.retryFactor);
  appendSchedulerOption(argumentsList, "--retry-randomize", input.retryRandomize);
  appendSchedulerOption(argumentsList, "--dedupe-key", normalizeSchedulerCliString(input.dedupeKey));
  appendSchedulerOption(argumentsList, "--ttl-ms", input.ttlMs);
  appendSchedulerOption(argumentsList, "--max-duration-ms", input.maxDurationMs);
  appendSchedulerOption(
    argumentsList,
    "--concurrency-key",
    normalizeSchedulerCliString(input.concurrencyKey),
  );
  appendSchedulerOption(argumentsList, "--concurrency-limit", input.concurrencyLimit);
  appendSchedulerOption(argumentsList, "--history-limit", input.historyLimit);
  appendSchedulerOption(argumentsList, "--max-catch-up-runs", input.maxCatchUpRuns);
  appendSchedulerOption(argumentsList, "--mode", input.mode);
  appendSchedulerOption(argumentsList, "--profile", normalizeSchedulerCliString(input.profile));
  appendSchedulerOption(argumentsList, "--runtime-provider", input.provider);
  appendSchedulerOption(argumentsList, "--model", normalizeSchedulerCliString(input.model));

  return argumentsList;
};

export const listSchedulerJobs = async (
  workspaceRoot: string | null | undefined,
): Promise<SchedulerListJobsResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["list"],
    normalizeSchedulerListJobsResult,
    "The scheduler jobs payload was invalid.",
    () => ({
      workspaceRoot: normalizeSchedulerCommandWorkspace(workspaceRoot),
      jobs: [],
    }),
  );
};

export const createSchedulerJob = async (
  workspaceRoot: string | null | undefined,
  input: SchedulerCreateJobInput,
): Promise<SchedulerJobActionResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    createSchedulerCreateArguments(input),
    normalizeSchedulerJobActionResult,
    "The scheduler create payload was invalid.",
    assertSchedulerDesktopAvailable,
  );
};

export const pauseSchedulerJob = async (
  workspaceRoot: string | null | undefined,
  jobId: string,
): Promise<SchedulerJobActionResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["pause", jobId],
    normalizeSchedulerJobActionResult,
    "The scheduler pause payload was invalid.",
    assertSchedulerDesktopAvailable,
  );
};

export const resumeSchedulerJob = async (
  workspaceRoot: string | null | undefined,
  jobId: string,
): Promise<SchedulerJobActionResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["resume", jobId],
    normalizeSchedulerJobActionResult,
    "The scheduler resume payload was invalid.",
    assertSchedulerDesktopAvailable,
  );
};

export const deleteSchedulerJob = async (
  workspaceRoot: string | null | undefined,
  jobId: string,
): Promise<SchedulerJobActionResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["delete", jobId],
    normalizeSchedulerJobActionResult,
    "The scheduler delete payload was invalid.",
    assertSchedulerDesktopAvailable,
  );
};

export const listSchedulerRuns = async (
  workspaceRoot: string | null | undefined,
  jobId?: string | null,
): Promise<SchedulerListRunsResult> => {
  const normalizedJobId = normalizeSchedulerCliString(jobId);

  return runSchedulerCommand(
    workspaceRoot,
    normalizedJobId ? ["runs", normalizedJobId] : ["runs"],
    normalizeSchedulerListRunsResult,
    "The scheduler runs payload was invalid.",
    () => ({
      workspaceRoot: normalizeSchedulerCommandWorkspace(workspaceRoot),
      runs: [],
    }),
  );
};

export const runDueSchedulerJobs = async (
  workspaceRoot: string | null | undefined,
): Promise<SchedulerRunDueResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["run-due"],
    normalizeSchedulerRunDueResult,
    "The scheduler run-due payload was invalid.",
    () => ({ queued: [], runs: [] }),
  );
};

export const triggerSchedulerJob = async (
  workspaceRoot: string | null | undefined,
  jobId: string,
): Promise<SchedulerTriggerResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["trigger", jobId],
    normalizeSchedulerTriggerResult,
    "The scheduler trigger payload was invalid.",
    assertSchedulerDesktopAvailable,
  );
};

export const retrySchedulerRun = async (
  workspaceRoot: string | null | undefined,
  runId: string,
): Promise<SchedulerRetryResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["retry", runId],
    normalizeSchedulerRetryResult,
    "The scheduler retry payload was invalid.",
    assertSchedulerDesktopAvailable,
  );
};

export const cancelSchedulerRun = async (
  workspaceRoot: string | null | undefined,
  runId: string,
): Promise<SchedulerRunActionResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["cancel", runId],
    normalizeSchedulerRunActionResult,
    "The scheduler cancel payload was invalid.",
    assertSchedulerDesktopAvailable,
  );
};

export const syncScheduledPrompts = async (
  workspaceRoot: string | null | undefined,
): Promise<SchedulerPromptSyncResult> => {
  return runSchedulerCommand(
    workspaceRoot,
    ["sync-prompts"],
    normalizeSchedulerPromptSyncResult,
    "The scheduled prompt sync payload was invalid.",
    () => ({
      workspaceRoot: normalizeSchedulerCommandWorkspace(workspaceRoot),
      discovered: [],
      syncedJobs: [],
      pausedJobs: [],
    }),
  );
};

export const subscribeToRemoteControlCommands = async (
  onCommand: (event: RemoteControlCommandEvent) => void,
): Promise<() => void> => {
  if (!canListenToDesktopTaskProgress()) {
    return () => {};
  }

  try {
    return await listen<unknown>(REMOTE_CONTROL_COMMAND_EVENT, (event) => {
      if (isRemoteControlCommandEvent(event.payload)) {
        onCommand(event.payload);
      }
    });
  } catch (error) {
    console.error("Failed to subscribe to Mission Control commands", error);
    return () => {};
  }
};

export const runDesktopTask = async (
  workspaceRoot: string | null | undefined,
  task: string,
  context: {
    conversationContext?: TaskConversationContext;
    imagePaths?: string[];
    mode?: RuntimeSnapshot["mode"];
    model?: string;
    profile?: string;
    provider?: RuntimeProvider;
    taskId?: string;
  } = {},
): Promise<DesktopTaskRunResponse> => {
  const normalizedTask = task.trim();
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);

  if (!normalizedTask) {
    throw new Error("Expected a non-empty task.");
  }

  const normalizedModel = context.model?.trim();
  const normalizedImagePaths = (context.imagePaths ?? [])
    .map((imagePath) => imagePath.trim())
    .filter((imagePath) => imagePath.length > 0);
  const normalizedMode = context.mode;
  const normalizedProfile = context.profile?.trim();
  const normalizedProvider = context.provider;
  const normalizedTaskId = context.taskId?.trim();

  if (!canInvokeTauriCommands()) {
    return {
      preview: createPreviewFixture(normalizedTask, context),
      execution: createMockExecutionFixture(
        normalizedTask,
        normalizedWorkspaceRoot ?? DEFAULT_MOCK_WORKSPACE_ROOT,
        context,
      ),
    };
  }

  try {
    return await tauriCore.invoke<DesktopTaskRunResponse>("run_desktop_task", {
      request: {
        workspaceRoot: normalizedWorkspaceRoot ?? "",
        task: normalizedTask,
        ...(normalizedMode ? { mode: normalizedMode } : {}),
        ...(normalizedProfile ? { profile: normalizedProfile } : {}),
        ...(normalizedTaskId ? { taskId: normalizedTaskId } : {}),
        ...(normalizedProvider ? { provider: normalizedProvider } : {}),
        ...(normalizedModel ? { model: normalizedModel } : {}),
        ...(normalizedImagePaths.length > 0
          ? { imagePaths: normalizedImagePaths }
          : {}),
        ...(context.conversationContext
          ? { conversationContext: context.conversationContext }
          : {}),
      },
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const subscribeToDesktopTaskProgress = async (
  onProgress: (event: DesktopTaskProgressEvent) => void,
): Promise<() => void> => {
  if (!canListenToDesktopTaskProgress()) {
    return () => {};
  }

  try {
    return await listen<unknown>(
      DESKTOP_TASK_PROGRESS_EVENT,
      (event) => {
        if (isDesktopTaskProgressEvent(event.payload)) {
          onProgress(event.payload);
        }
      },
    );
  } catch (error) {
    console.error("Failed to subscribe to desktop task progress", error);
    return () => {};
  }
};

export const openWorkspacePath = async (
  workspaceRoot: string | null | undefined,
  relativePath: string,
): Promise<void> => {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);
  const normalizedRelativePath = relativePath.trim();

  if (!normalizedRelativePath) {
    throw new Error("Expected a workspace-relative path.");
  }

  if (!canInvokeTauriCommands()) {
    return;
  }

  try {
    await tauriCore.invoke("open_workspace_path", {
      workspaceRoot: normalizedWorkspaceRoot ?? "",
      relativePath: normalizedRelativePath,
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const openAttachedPath = async (path: string): Promise<void> => {
  const normalizedPath = path.trim();

  if (!normalizedPath) {
    throw new Error("Expected an attached file path.");
  }

  if (!canInvokeTauriCommands()) {
    return;
  }

  try {
    await tauriCore.invoke("open_attached_path", {
      path: normalizedPath,
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveClipboardImageAttachment = async (
  input: ClipboardImageAttachmentInput,
): Promise<string> => {
  const mediaType =
    input.mediaType ?? normalizeClipboardImageMediaType(input.blob.type);

  if (!mediaType) {
    throw new Error("Unsupported clipboard image format.");
  }

  const fileName = input.fileName?.trim() || undefined;

  if (!canInvokeTauriCommands()) {
    return getFallbackClipboardImagePath(mediaType, fileName);
  }

  try {
    return await tauriCore.invoke<string>("save_clipboard_image_attachment", {
      request: {
        dataBase64: await blobToBase64(input.blob),
        mediaType,
        ...(fileName ? { fileName } : {}),
      },
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const resolveDroppedPaths = async (
  paths: string[],
): Promise<DroppedPathsResolution> => {
  const normalizedPaths = paths
    .map((path) => path.trim())
    .filter((path) => path.length > 0);

  if (normalizedPaths.length === 0) {
    return {
      entries: [],
      workspaceRoot: null,
    };
  }

  if (!canInvokeTauriCommands()) {
    return createFallbackDroppedPathsResolution(normalizedPaths);
  }

  try {
    return await tauriCore.invoke<DroppedPathsResolution>("resolve_dropped_paths", {
      paths: normalizedPaths,
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};
