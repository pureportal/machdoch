import * as tauriCore from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  CustomizationDiagnostic,
  DiscoveredInstruction,
  AgentModelImageMediaType,
  ConversationMemoryEntry,
  InstructionAudience,
  InstructionMode,
  InstructionScope,
  TaskConversationContext,
  TaskActionOutput,
  TaskExecutionProgress,
  TaskExecutionResult,
  TaskRunPreview,
} from "../../core/types.js";
import type { RunMode } from "../../core/runtime-contract.generated.js";
import type {
  RalphGenerationEvent,
  RalphGenerationInterviewSession,
  RalphGenerationInterviewStatus,
} from "../../core/ralph-generation.js";
import type {
  RalphFlow,
  RalphFlowDeleteResult,
  RalphFlowScope,
  RalphInputField,
  RalphInputValue,
  RalphFlowRevisionSummary,
  RalphFlowSummary,
  RalphInputResponse,
  RalphRunLogReadResult,
  RalphRunRecord,
  RalphRunResult,
  RalphRunSummary,
  RalphValidationResult,
} from "../../core/ralph.js";
import {
  AGENT_LIMIT_BOUNDS,
  DEFAULT_USER_AGENT_LIMITS_SETTINGS,
  DEFAULT_USER_REVIEW_MODEL_SETTINGS,
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
  MODEL_PROVIDERS,
  REASONING_MODES,
  RUN_MODES,
  USER_API_PROVIDERS,
  USER_AUDIO_AI_PROVIDERS,
  USER_WEB_SEARCH_PROVIDERS,
  VALID_MODEL_PROVIDERS,
} from "../../core/runtime-contract.generated.js";
import { MCP_PRESETS } from "../../core/mcp/presets.js";
import {
  MCP_CONFIG_SCHEMA_VERSION,
  type McpConfigFile,
  type McpOAuthFlowResult,
  type McpServerConfig,
} from "../../core/mcp/types.js";
import type {
  AudioProvider,
  AudioProviderAvailability as SharedAudioProviderAvailability,
  RuntimeAgentLimits as SharedRuntimeAgentLimits,
  RuntimeCompatibilityConfig as SharedRuntimeCompatibilityConfig,
  RuntimeProfileSummary as SharedRuntimeProfileSummary,
  RuntimeSnapshot as SharedRuntimeSnapshot,
  ReasoningMode as SharedReasoningMode,
  RuntimeWebSearchConfig as SharedRuntimeWebSearchConfig,
  SpeechToTextProvider as SharedSpeechToTextProvider,
  UserAgentLimitsSettings as SharedUserAgentLimitsSettings,
  UserDesktopSettings as SharedUserDesktopSettings,
  UserApiProvider as SharedUserApiProvider,
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
import { normalizeRemoteControlStatus } from "./_helpers/normalize-remote-control-status.helper";

export type UserApiKeyProvider = SharedUserApiProvider;

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
export const TRAY_MENU_WINDOW_LABEL = "tray-menu";
export const DESKTOP_SETTINGS_CHANGED_EVENT =
  "machdoch://desktop-settings-changed";
export const QUICK_VOICE_START_EVENT = "machdoch://quick-voice-start";

export const USER_API_KEY_PROVIDER_ORDER: UserApiKeyProvider[] = [
  ...USER_API_PROVIDERS,
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

export const MCP_CONFIG_SCOPE_OPTIONS: ReadonlyArray<{
  value: McpConfigScope;
  label: string;
}> = [
  { value: "user", label: "Global" },
  { value: "workspace", label: "Workspace" },
];

export const MCP_PRESET_SUMMARIES: readonly McpPresetSummary[] =
  MCP_PRESETS.map((preset) => ({
    id: preset.id,
    title: preset.title,
    description: preset.description,
    serverId: preset.server.id,
    serverTitle: preset.server.title ?? preset.server.id,
  }));

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

export type McpConfigScope = "user" | "workspace";

export interface McpConfigDocument {
  scope: McpConfigScope;
  path: string;
  exists: boolean;
  raw: string;
}

export interface McpPresetSummary {
  id: string;
  title: string;
  description: string;
  serverId: string;
  serverTitle: string;
}

export type WritableInstructionScope = Extract<
  InstructionScope,
  "user" | "workspace"
>;

export interface InstructionRegistryResult {
  workspaceRoot: string;
  instructions: DiscoveredInstruction[];
  diagnostics: CustomizationDiagnostic[];
}

export interface InstructionValidationResult {
  valid: boolean;
  diagnostics: CustomizationDiagnostic[];
}

export interface InstructionWriteResult {
  path: string;
  scope: WritableInstructionScope;
  name: string;
  created?: boolean;
}

export interface InstructionGenerationResult {
  status: "created" | "updated" | "blocked";
  path: string;
  scope: WritableInstructionScope;
  name: string;
  rounds: number;
  validation: InstructionValidationResult;
  generatorResults: TaskExecutionResult[];
  summary: string;
}

export interface InstructionMutationInput {
  name: string;
  prompt: string;
  path?: string;
  scope?: WritableInstructionScope;
  mode?: InstructionMode;
  audience?: InstructionAudience;
  applyTo?: string[];
  exclude?: string[];
  keywords?: string[];
  priority?: number;
  maxRounds?: number;
}

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

export type ReasoningMode = SharedReasoningMode;

export const REASONING_MODE_ORDER: readonly ReasoningMode[] = [
  ...REASONING_MODES,
];

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
  | "create-session"
  | "activate-session"
  | "archive-session"
  | "pin-session"
  | "duplicate-session"
  | "branch-session"
  | "delete-session"
  | "rename-session"
  | "tag-session"
  | "clear-session-history"
  | "update-draft"
  | "set-session-model"
  | "set-session-mode"
  | "set-session-reasoning"
  | "set-session-profile"
  | "set-session-memory"
  | "set-global-memory"
  | "set-ui-control"
  | "remove-attachment"
  | "clear-attachments"
  | "apply-context-pack"
  | "delete-context-pack"
  | "save-message-context-pack"
  | "speak-message"
  | "stop-speaking"
  | "scheduler-trigger"
  | "scheduler-pause"
  | "scheduler-resume"
  | "scheduler-delete"
  | "scheduler-retry-run"
  | "scheduler-cancel-run";

export interface RemoteControlCommandEvent {
  commandId: string;
  kind: RemoteControlCommandKind;
  taskId?: string;
  sessionId?: string;
  prompt?: string;
  title?: string;
  tags?: string[];
  provider?: string;
  model?: string;
  mode?: string;
  reasoning?: string;
  profile?: string;
  workspace?: string;
  enabled?: boolean;
  attachmentId?: string;
  contextPackId?: string;
  messageId?: string;
  jobId?: string;
  runId?: string;
  createdAt: number;
}

export interface RemoteShellAttachmentSnapshot {
  id: string;
  kind: string;
  name: string;
  path: string;
  parent?: string;
}

export interface RemoteShellSessionSnapshot {
  id: string;
  title: string;
  status: string;
  workspace?: string;
  profile?: string;
  provider: string;
  model: string;
  mode?: string;
  effectiveMode: string;
  reasoning?: string;
  effectiveReasoning?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  pinnedAt?: number;
  tags: string[];
  messageCount: number;
  promptHistoryCount: number;
  attachmentCount: number;
  runningTaskId?: string;
  canRename: boolean;
  canDelete: boolean;
  canArchive: boolean;
  canPin: boolean;
  canDuplicate: boolean;
  canBranch: boolean;
  specialKind?: string;
}

export interface RemoteShellTraceEntrySnapshot {
  label: string;
  detail: string;
  tone?: string;
  timestamp?: number;
}

export interface RemoteShellMessageSourceSnapshot {
  kind: string;
  status?: string;
  title?: string;
  summary?: string;
  mode?: string;
  entries: RemoteShellTraceEntrySnapshot[];
  timeline: RemoteShellTraceEntrySnapshot[];
}

export interface RemoteShellMessageActionsSnapshot {
  canRetry: boolean;
  canContinue: boolean;
  canSaveAsContextPack: boolean;
  canSpeak: boolean;
  isSpeaking: boolean;
}

export interface RemoteShellMessageSnapshot {
  id: string;
  role: string;
  content: string;
  createdAt?: number;
  taskId?: string;
  intent?: string;
  attachments: RemoteShellAttachmentSnapshot[];
  source?: RemoteShellMessageSourceSnapshot;
  actions: RemoteShellMessageActionsSnapshot;
}

export interface RemoteShellComposerSnapshot {
  sessionId: string;
  draft: string;
  provider: string;
  model: string;
  mode: string;
  defaultMode: string;
  reasoning: string;
  defaultReasoning: string;
  workspace?: string;
  workspaceLabel: string;
  canSend: boolean;
  sendDisabledReason?: string;
  isExecuting: boolean;
  sessionMemoryEnabled: boolean;
  globalMemoryAvailable: boolean;
  globalMemoryEnabled: boolean;
  uiControlAvailable: boolean;
  uiControlEnabled: boolean;
  uiControlDescription: string;
  attachments: RemoteShellAttachmentSnapshot[];
  chooserProviders: string[];
  matchedContextPackIds: string[];
}

export interface RemoteShellProviderStatusSnapshot {
  provider: string;
  available: boolean;
  reason?: string;
}

export interface RemoteShellRuntimeCapabilitySnapshot {
  available: boolean;
  reason?: string;
}

export interface RemoteShellRuntimeSnapshot {
  loading: boolean;
  error?: string;
  hasAnyProvider: boolean;
  providerStatuses: RemoteShellProviderStatusSnapshot[];
  mode?: string;
  reasoning?: string;
  profile?: string;
  uiControl?: RemoteShellRuntimeCapabilitySnapshot;
  webSearch?: RemoteShellRuntimeCapabilitySnapshot;
}

export interface RemoteShellSchedulerJobSnapshot {
  id: string;
  name: string;
  status: string;
  schedule: string;
  promptPreview: string;
  nextRunAt?: number;
  lastStartedAt?: number;
  lastFinishedAt?: number;
}

export interface RemoteShellSchedulerRunSnapshot {
  id: string;
  jobId: string;
  source: string;
  status: string;
  scheduledFor: number;
  updatedAt: number;
  attempt: number;
  maxAttempts: number;
  startedAt?: number;
  finishedAt?: number;
  nextAttemptAt?: number;
  error?: string;
  summary?: string;
}

export interface RemoteShellSchedulerSnapshot {
  workspaceRoot?: string;
  loading: boolean;
  error?: string;
  jobs: RemoteShellSchedulerJobSnapshot[];
  runs: RemoteShellSchedulerRunSnapshot[];
  updatedAt: number;
}

export interface RemoteShellContextPackSnapshot {
  id: string;
  name: string;
  workspace?: string;
  instructionsPreview: string;
  promptPreview: string;
  attachmentCount: number;
  variables: string[];
  matched: boolean;
  provider?: string;
  model?: string;
  mode?: string;
  reasoning?: string;
}

export interface RemoteShellVoiceSnapshot {
  supported: boolean;
  autoSpeakResponses: boolean;
  speakingMessageId?: string;
  speechInputSupported: boolean;
  speechInputEnabled: boolean;
  speechInputStatus?: string;
}

export interface RemoteShellQuickTaskSnapshot {
  status: string;
  draft: string;
  isExecuting: boolean;
  provider: string;
  model: string;
  autopilotEnabled: boolean;
  globalMemoryEnabled: boolean;
  uiControlEnabled: boolean;
  attachmentCount: number;
}

export interface RemoteControlShellSnapshot {
  version: 1;
  capturedAt: number;
  activeSessionId?: string;
  sessions: RemoteShellSessionSnapshot[];
  visibleMessages: RemoteShellMessageSnapshot[];
  composer?: RemoteShellComposerSnapshot;
  runtime?: RemoteShellRuntimeSnapshot;
  scheduler?: RemoteShellSchedulerSnapshot;
  contextPacks: RemoteShellContextPackSnapshot[];
  promptHistory: string[];
  voice?: RemoteShellVoiceSnapshot;
  quickTask?: RemoteShellQuickTaskSnapshot;
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

export type SchedulerRunSource =
  | "schedule"
  | "manual"
  | "manual-retry"
  | "event";

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

export interface SchedulerTriggerSummary {
  id: string;
  kind: string;
  enabled: boolean;
  name?: string;
  eventType?: string;
  schedule?: SchedulerScheduleSummary;
  nextRunAt?: number;
  filters?: Record<string, unknown>;
  recoveryFilters?: Record<string, unknown>;
  firingMode?: "event" | "state";
  cooldownMs?: number;
  repeatIntervalMs?: number;
  debounceMs?: number;
  dedupeKeyTemplate?: string;
  maxEventsPerWindow?: {
    maxEvents: number;
    windowMs: number;
  };
}

export interface SchedulerCreateTriggerInput {
  id?: string;
  kind: string;
  enabled?: boolean;
  name?: string;
  eventType?: string;
  schedule?: SchedulerCreateScheduleInput;
  filters?: Record<string, unknown>;
  recoveryFilters?: Record<string, unknown>;
  firingMode?: "event" | "state";
  cooldownMs?: number;
  repeatIntervalMs?: number;
  debounceMs?: number;
  dedupeKeyTemplate?: string;
  maxEventsPerWindow?: {
    maxEvents: number;
    windowMs: number;
  };
}

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
  schedule: SchedulerScheduleSummary | null;
  triggers: SchedulerTriggerSummary[];
  triggerLabel: string;
  targetType: "prompt" | "ralph-flow";
  workspaceRoot: string;
  prompt: string;
  ralphFlow: SchedulerRalphFlowSummary | null;
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

export interface SchedulerRalphFlowPermissionsInput {
  allowedRoots: string[];
  allowCommands: boolean;
  allowWrites: boolean;
  allowNetwork: boolean;
  allowMcpTools: boolean;
}

export interface SchedulerRalphFlowInput {
  scope?: "workspace" | "user";
  id: string;
  params?: Record<string, string>;
  maxTransitions?: number;
  runLogScope?: "workspace" | "user";
  permissions: SchedulerRalphFlowPermissionsInput;
}

export interface SchedulerRalphFlowSummary extends SchedulerRalphFlowInput {
  scope: "workspace" | "user";
  params: Record<string, string>;
}

export interface SchedulerCreateJobInput {
  name?: string;
  schedule?: SchedulerCreateScheduleInput;
  triggers?: SchedulerCreateTriggerInput[];
  targetType?: "prompt" | "ralph-flow";
  prompt?: string;
  promptFile?: string;
  ralphFlow?: SchedulerRalphFlowInput;
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
  reasoning?: RuntimeSnapshot["reasoning"];
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

export interface McpCommandDiscoveryResult {
  workspaceRoot: string;
  discovery: unknown;
  cachePath?: string | null;
}

export interface McpCommandServersResult {
  workspaceRoot: string;
  defaults?: unknown;
  paths?: unknown;
  servers: unknown[];
}

export interface McpCommandCacheResult {
  workspaceRoot: string;
  cachePath?: string;
  servers: Record<string, unknown>;
}

export interface McpCommandOAuthResult {
  workspaceRoot: string;
  result: McpOAuthFlowResult;
}

export interface RalphListFlowsResult {
  workspaceRoot: string;
  scope?: RalphFlowScope;
  flows: RalphFlowSummary[];
}

export interface RalphFlowResult {
  path: string;
  scope?: RalphFlowScope;
  flow: RalphFlow;
}

export interface RalphValidateFlowResult {
  path: string;
  scope?: RalphFlowScope;
  validation: RalphValidationResult;
}

export interface RalphListFlowRevisionsResult {
  flow: string;
  scope?: RalphFlowScope;
  revisions: RalphFlowRevisionSummary[];
}

export interface RalphCreateFlowInput {
  name?: string;
  scope?: RalphFlowScope;
  prompt: string;
  maxRounds?: number;
  existingFlow?: RalphFlow;
  target?: "flow" | "prompt-block" | "refactor";
  generationMode?: "do-it" | "interview";
  mode?: RunMode;
  profile?: string;
  provider?: RuntimeProvider;
  model?: string;
  reasoning?: RuntimeSnapshot["reasoning"];
  taskId?: string;
  maxTransitions?: number;
}

export interface RalphCreateFlowResult {
  generationRunId?: string | null;
  status: "created" | "blocked";
  flowPath: string;
  generationLogPath?: string | null;
  traceLogPath?: string | null;
  rounds: number;
  validation: RalphValidationResult;
  summary: string;
  flow: RalphFlow | null;
  events?: RalphGenerationEvent[];
  generatorResults?: Array<Pick<TaskExecutionResult, "status" | "summary" | "reason" | "executedTools">>;
  validatorResults?: Array<Pick<TaskExecutionResult, "status" | "summary" | "reason" | "executedTools">>;
}

export interface RalphGenerationInterviewInput {
  name?: string;
  scope?: RalphFlowScope;
  prompt: string;
  maxTurns?: number;
  existingFlow?: RalphFlow;
  target?: "flow" | "prompt-block" | "refactor";
  session?: RalphGenerationInterviewSession;
  answers?: Record<string, RalphInputValue>;
  answerComments?: Record<string, string>;
  mode?: RunMode;
  profile?: string;
  provider?: RuntimeProvider;
  model?: string;
  reasoning?: RuntimeSnapshot["reasoning"];
  taskId?: string;
}

export interface RalphGenerationInterviewResult {
  status: RalphGenerationInterviewStatus;
  session: RalphGenerationInterviewSession;
  fields: RalphInputField[];
  summary: string;
  finalPrompt?: string | null;
  provider?: string | null;
  model?: string | null;
  result?: Pick<TaskExecutionResult, "status" | "summary" | "reason" | "executedTools"> | null;
}

export interface RalphSaveFlowInput {
  flow: RalphFlow;
  scope?: RalphFlowScope;
}

export interface RalphSaveFlowResult {
  path: string;
  flow: RalphFlow;
  validation: RalphValidationResult;
}

export type RalphDeleteFlowResult = RalphFlowDeleteResult;

export interface RalphRestoreFlowRevisionInput {
  name: string;
  revision: string;
  scope?: RalphFlowScope;
}

export interface RalphRestoreFlowRevisionResult {
  path: string;
  flow: RalphFlow;
  validation: RalphValidationResult;
  revision: RalphFlowRevisionSummary;
}

export interface RalphRunFlowInput {
  name: string;
  scope?: RalphFlowScope;
  params?: Record<string, string>;
  mode?: RunMode;
  profile?: string;
  provider?: RuntimeProvider;
  model?: string;
  reasoning?: RuntimeSnapshot["reasoning"];
  taskId?: string;
  maxTransitions?: number;
}

export interface RalphRunFlowResult {
  run: RalphRunResult;
  runLogPath?: string;
  runRecordPath?: string;
  traceLogPath?: string;
}

export interface RalphResumeRunInput {
  runId: string;
  inputResponse: RalphInputResponse;
  scope?: RalphFlowScope;
  mode?: RunMode;
  profile?: string;
  provider?: RuntimeProvider;
  model?: string;
  reasoning?: RuntimeSnapshot["reasoning"];
  taskId?: string;
  maxTransitions?: number;
}

export interface RalphListRunsResult {
  runs: RalphRunSummary[];
}

export interface RalphRunDetailResult {
  scope?: RalphFlowScope;
  path: string;
  record: RalphRunRecord;
}

export type RalphRunLogResult = RalphRunLogReadResult;

export interface ActiveDesktopTaskSummary {
  id: string;
  kind: string;
  workspaceRoot: string;
  arguments: string[];
  startedAt: number;
}

const DEFAULT_MOCK_WORKSPACE_ROOT = "/mock/home/path";
const DESKTOP_TASK_PROGRESS_EVENT = "desktop-task-progress";
const REMOTE_CONTROL_COMMAND_EVENT = "remote-control-command";
const REMOTE_CONTROL_COMMAND_KINDS = [
  "cancel",
  "retry",
  "continue",
  "follow-up",
  "create-session",
  "activate-session",
  "archive-session",
  "pin-session",
  "duplicate-session",
  "branch-session",
  "delete-session",
  "rename-session",
  "tag-session",
  "clear-session-history",
  "update-draft",
  "set-session-model",
  "set-session-mode",
  "set-session-reasoning",
  "set-session-profile",
  "set-session-memory",
  "set-global-memory",
  "set-ui-control",
  "remove-attachment",
  "clear-attachments",
  "apply-context-pack",
  "delete-context-pack",
  "save-message-context-pack",
  "speak-message",
  "stop-speaking",
  "scheduler-trigger",
  "scheduler-pause",
  "scheduler-resume",
  "scheduler-delete",
  "scheduler-retry-run",
  "scheduler-cancel-run",
] as const satisfies ReadonlyArray<RemoteControlCommandKind>;
const REMOTE_CONTROL_RUN_MODES = ["ask", "machdoch"] as const;
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
  "event",
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

const isRuntimeRunMode = (mode: string): mode is RuntimeSnapshot["mode"] => {
  return RUN_MODES.includes(mode as RuntimeSnapshot["mode"]);
};

const isRuntimeReasoningMode = (
  reasoning: string,
): reasoning is RuntimeSnapshot["reasoning"] => {
  return REASONING_MODES.includes(reasoning as RuntimeSnapshot["reasoning"]);
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
    (value.sessionId === undefined || typeof value.sessionId === "string") &&
    (value.prompt === undefined || typeof value.prompt === "string") &&
    (value.title === undefined || typeof value.title === "string") &&
    (value.tags === undefined ||
      (Array.isArray(value.tags) &&
        value.tags.every((tag) => typeof tag === "string"))) &&
    (value.provider === undefined || typeof value.provider === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.mode === undefined || typeof value.mode === "string") &&
    (value.kind !== "set-session-mode" ||
      REMOTE_CONTROL_RUN_MODES.includes(
        value.mode as (typeof REMOTE_CONTROL_RUN_MODES)[number],
      )) &&
    (value.reasoning === undefined || typeof value.reasoning === "string") &&
    (value.kind !== "set-session-reasoning" ||
      value.reasoning === undefined ||
      isRuntimeReasoningMode(value.reasoning)) &&
    (value.profile === undefined || typeof value.profile === "string") &&
    (value.workspace === undefined || typeof value.workspace === "string") &&
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.attachmentId === undefined ||
      typeof value.attachmentId === "string") &&
    (value.contextPackId === undefined ||
      typeof value.contextPackId === "string") &&
    (value.messageId === undefined || typeof value.messageId === "string") &&
    (value.jobId === undefined || typeof value.jobId === "string") &&
    (value.runId === undefined || typeof value.runId === "string") &&
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

const normalizeSchedulerTriggerSummary = (
  value: unknown,
): SchedulerTriggerSummary | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.enabled !== "boolean"
  ) {
    return null;
  }

  return {
    id: value.id,
    kind: value.kind,
    enabled: value.enabled,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.eventType === "string"
      ? { eventType: value.eventType }
      : {}),
    ...(isSchedulerScheduleSummary(value.schedule)
      ? { schedule: value.schedule }
      : {}),
    ...(typeof value.nextRunAt === "number" && Number.isFinite(value.nextRunAt)
      ? { nextRunAt: value.nextRunAt }
      : {}),
    ...(isRecord(value.filters) ? { filters: value.filters } : {}),
    ...(isRecord(value.recoveryFilters)
      ? { recoveryFilters: value.recoveryFilters }
      : {}),
    ...(value.firingMode === "event" || value.firingMode === "state"
      ? { firingMode: value.firingMode }
      : {}),
    ...(typeof value.cooldownMs === "number" && Number.isFinite(value.cooldownMs)
      ? { cooldownMs: value.cooldownMs }
      : {}),
    ...(typeof value.repeatIntervalMs === "number" &&
    Number.isFinite(value.repeatIntervalMs)
      ? { repeatIntervalMs: value.repeatIntervalMs }
      : {}),
    ...(typeof value.debounceMs === "number" && Number.isFinite(value.debounceMs)
      ? { debounceMs: value.debounceMs }
      : {}),
    ...(typeof value.dedupeKeyTemplate === "string"
      ? { dedupeKeyTemplate: value.dedupeKeyTemplate }
      : {}),
    ...(isRecord(value.maxEventsPerWindow) &&
    typeof value.maxEventsPerWindow.maxEvents === "number" &&
    Number.isFinite(value.maxEventsPerWindow.maxEvents) &&
    typeof value.maxEventsPerWindow.windowMs === "number" &&
    Number.isFinite(value.maxEventsPerWindow.windowMs)
      ? {
          maxEventsPerWindow: {
            maxEvents: value.maxEventsPerWindow.maxEvents,
            windowMs: value.maxEventsPerWindow.windowMs,
          },
        }
      : {}),
  };
};

const normalizeSchedulerTriggerList = (
  value: unknown,
): SchedulerTriggerSummary[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }

  const triggers = value.map(normalizeSchedulerTriggerSummary);

  return triggers.every(
    (trigger): trigger is SchedulerTriggerSummary => Boolean(trigger),
  )
    ? triggers
    : null;
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

const normalizeStringRecord = (value: unknown): Record<string, string> | null => {
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value);

  if (entries.some((entry) => typeof entry[1] !== "string")) {
    return null;
  }

  return Object.fromEntries(entries) as Record<string, string>;
};

const normalizeSchedulerRalphFlowPermissions = (
  value: unknown,
): SchedulerRalphFlowPermissionsInput | null => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.allowedRoots) ||
    value.allowedRoots.some((entry) => typeof entry !== "string") ||
    typeof value.allowCommands !== "boolean" ||
    typeof value.allowWrites !== "boolean" ||
    typeof value.allowNetwork !== "boolean" ||
    typeof value.allowMcpTools !== "boolean"
  ) {
    return null;
  }

  return {
    allowedRoots: value.allowedRoots,
    allowCommands: value.allowCommands,
    allowWrites: value.allowWrites,
    allowNetwork: value.allowNetwork,
    allowMcpTools: value.allowMcpTools,
  };
};

const normalizeSchedulerRalphFlowSummary = (
  value: unknown,
): SchedulerRalphFlowSummary | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.scope !== "workspace" && value.scope !== "user")
  ) {
    return null;
  }

  const params = normalizeStringRecord(value.params);
  const permissions = normalizeSchedulerRalphFlowPermissions(value.permissions);

  if (!params || !permissions) {
    return null;
  }

  return {
    id: value.id,
    scope: value.scope,
    params,
    ...(typeof value.maxTransitions === "number" &&
    Number.isFinite(value.maxTransitions)
      ? { maxTransitions: value.maxTransitions }
      : {}),
    ...(value.runLogScope === "workspace" || value.runLogScope === "user"
      ? { runLogScope: value.runLogScope }
      : {}),
    permissions,
  };
};

const normalizeSchedulerJobSummary = (
  value: unknown,
): SchedulerJobSummary | null => {
  const targetType =
    value && isRecord(value) && value.targetType === "ralph-flow"
      ? "ralph-flow"
      : "prompt";
  const ralphFlow =
    value && isRecord(value) && value.ralphFlow !== null
      ? normalizeSchedulerRalphFlowSummary(value.ralphFlow)
      : null;

  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    !SCHEDULER_JOB_STATUSES.includes(value.status as SchedulerJobStatus) ||
    !(value.schedule === null || isSchedulerScheduleSummary(value.schedule)) ||
    !normalizeSchedulerTriggerList(value.triggers) ||
    typeof value.triggerLabel !== "string" ||
    (value.targetType !== undefined &&
      value.targetType !== "prompt" &&
      value.targetType !== "ralph-flow") ||
    (targetType === "ralph-flow" && !ralphFlow) ||
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
    triggers: normalizeSchedulerTriggerList(value.triggers) ?? [],
    triggerLabel: value.triggerLabel,
    targetType,
    workspaceRoot: value.workspaceRoot,
    prompt: value.prompt,
    ralphFlow,
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

const createDefaultMcpConfig = (): McpConfigFile => {
  return {
    schemaVersion: MCP_CONFIG_SCHEMA_VERSION,
    defaults: {
      enabled: true,
      securityProfile: "weak",
      exposure: "hybrid",
      directTools: true,
      timeoutMs: 60_000,
      maxTotalTimeoutMs: 300_000,
      idleShutdownMs: 900_000,
      maxResponseChars: 60_000,
      cache: {
        enabled: true,
        ttlMs: 900_000,
        forceRefresh: false,
      },
      roots: "workspace",
      sampling: "disabled",
      tasks: "optional",
      elicitation: "disabled",
    },
    servers: [],
  };
};

export const createDefaultMcpConfigRaw = (): string => {
  return `${JSON.stringify(createDefaultMcpConfig(), null, 2)}\n`;
};

const createFallbackMcpConfigPath = (
  scope: McpConfigScope,
  workspaceRoot?: string | null,
): string => {
  if (scope === "user") {
    return "Global MCP config path is available in the desktop app.";
  }

  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);

  if (!normalizedWorkspaceRoot) {
    return "Select a workspace to edit workspace MCP config.";
  }

  return `${normalizedWorkspaceRoot.replace(/\\/gu, "/")}/.machdoch/mcp/mcp.json`;
};

export const createFallbackMcpConfigDocument = (
  scope: McpConfigScope,
  workspaceRoot?: string | null,
): McpConfigDocument => {
  return {
    scope,
    path: createFallbackMcpConfigPath(scope, workspaceRoot),
    exists: false,
    raw: createDefaultMcpConfigRaw(),
  };
};

const parseMcpConfigObject = (raw: string): Record<string, unknown> => {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MCP config must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error("MCP config must be a JSON object.");
  }

  return parsed;
};

export const normalizeMcpConfigRaw = (raw: string): string => {
  return `${JSON.stringify(parseMcpConfigObject(raw), null, 2)}\n`;
};

const normalizeMcpServerId = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
};

const cloneMcpServerConfig = (
  server: McpServerConfig,
): Record<string, unknown> => {
  return JSON.parse(JSON.stringify(server)) as Record<string, unknown>;
};

const getMcpConfigServerArray = (
  value: unknown,
): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (isRecord(entry) ? [{ ...entry }] : []));
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([id, entry]) => {
    if (!isRecord(entry)) {
      return [];
    }

    return [{ id, ...entry }];
  });
};

export const createMcpConfigRawWithPreset = (
  raw: string,
  presetId: string,
): string => {
  const config = parseMcpConfigObject(raw);
  const preset = MCP_PRESETS.find((candidate) => candidate.id === presetId);

  if (!preset) {
    throw new Error(`Unknown MCP preset \`${presetId}\`.`);
  }

  const servers = getMcpConfigServerArray(config.servers);
  const presetServer = {
    ...cloneMcpServerConfig(preset.server),
    id: preset.server.id,
    preset: preset.id,
    enabled: true,
  };
  const existingIndex = servers.findIndex((server) => {
    return (
      typeof server.id === "string" &&
      normalizeMcpServerId(server.id) === preset.server.id
    );
  });

  if (existingIndex >= 0) {
    servers[existingIndex] = {
      ...presetServer,
      ...servers[existingIndex],
      id: preset.server.id,
      preset: preset.id,
      enabled: true,
    };
  } else {
    servers.push(presetServer);
  }

  return `${JSON.stringify(
    {
      ...config,
      schemaVersion: MCP_CONFIG_SCHEMA_VERSION,
      defaults: isRecord(config.defaults)
        ? config.defaults
        : createDefaultMcpConfig().defaults,
      servers,
    },
    null,
    2,
  )}\n`;
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

export const loadMcpConfigDocument = async (
  scope: McpConfigScope,
  workspaceRoot?: string | null,
): Promise<McpConfigDocument> => {
  if (scope === "workspace") {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);

    if (!normalizedWorkspaceRoot) {
      return createFallbackMcpConfigDocument("workspace", workspaceRoot);
    }

    if (!canInvokeTauriCommands()) {
      return createFallbackMcpConfigDocument("workspace", normalizedWorkspaceRoot);
    }

    try {
      return await tauriCore.invoke<McpConfigDocument>(
        "get_workspace_mcp_config_document",
        { workspaceRoot: normalizedWorkspaceRoot },
      );
    } catch (error) {
      console.error("Failed to load workspace MCP config", error);
      return createFallbackMcpConfigDocument("workspace", normalizedWorkspaceRoot);
    }
  }

  if (!canInvokeTauriCommands()) {
    return createFallbackMcpConfigDocument("user");
  }

  try {
    return await tauriCore.invoke<McpConfigDocument>(
      "get_user_mcp_config_document",
    );
  } catch (error) {
    console.error("Failed to load global MCP config", error);
    return createFallbackMcpConfigDocument("user");
  }
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

export const loadActiveDesktopTasks = async (): Promise<
  ActiveDesktopTaskSummary[] | null
> => {
  if (!canInvokeTauriCommands()) {
    return null;
  }

  try {
    return await tauriCore.invoke<ActiveDesktopTaskSummary[]>(
      "get_active_desktop_tasks",
    );
  } catch (error) {
    console.error("Failed to load active desktop tasks", error);
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

export const saveMcpConfigDocument = async (
  scope: McpConfigScope,
  raw: string,
  workspaceRoot?: string | null,
): Promise<McpConfigDocument> => {
  const normalizedRaw = normalizeMcpConfigRaw(raw);

  if (scope === "workspace") {
    const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);

    if (!normalizedWorkspaceRoot) {
      throw new Error("Select a workspace before saving workspace MCP config.");
    }

    if (!canInvokeTauriCommands()) {
      return {
        ...createFallbackMcpConfigDocument("workspace", normalizedWorkspaceRoot),
        exists: true,
        raw: normalizedRaw,
      };
    }

    try {
      return await tauriCore.invoke<McpConfigDocument>(
        "save_workspace_mcp_config_document",
        {
          workspaceRoot: normalizedWorkspaceRoot,
          raw: normalizedRaw,
        },
      );
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  if (!canInvokeTauriCommands()) {
    return {
      ...createFallbackMcpConfigDocument("user"),
      exists: true,
      raw: normalizedRaw,
    };
  }

  try {
    return await tauriCore.invoke<McpConfigDocument>(
      "save_user_mcp_config_document",
      { raw: normalizedRaw },
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

export const saveWorkspaceDefaultMode = async (
  workspaceRoot: string | null | undefined,
  mode: RuntimeSnapshot["mode"],
): Promise<string | null> => {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);

  if (!normalizedWorkspaceRoot) {
    throw new Error("Select a workspace before changing its default mode.");
  }

  if (!isRuntimeRunMode(mode)) {
    throw new Error("Expected workspace mode to be one of ask or machdoch.");
  }

  if (!canInvokeTauriCommands()) {
    return null;
  }

  try {
    return await tauriCore.invoke<string>("save_workspace_default_mode", {
      workspaceRoot: normalizedWorkspaceRoot,
      mode,
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const saveWorkspaceReasoningMode = async (
  workspaceRoot: string | null | undefined,
  reasoning: RuntimeSnapshot["reasoning"],
): Promise<string | null> => {
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);

  if (!normalizedWorkspaceRoot) {
    throw new Error("Select a workspace before changing its reasoning mode.");
  }

  if (!isRuntimeReasoningMode(reasoning)) {
    throw new Error(
      "Expected workspace reasoning to be one of default, none, minimal, low, medium, high, xhigh, or max.",
    );
  }

  if (!canInvokeTauriCommands()) {
    return null;
  }

  try {
    return await tauriCore.invoke<string>("save_workspace_reasoning_mode", {
      workspaceRoot: normalizedWorkspaceRoot,
      reasoning,
    });
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

export const updateRemoteControlShellSnapshot = async (
  snapshot: RemoteControlShellSnapshot,
): Promise<void> => {
  if (!canInvokeTauriCommands()) {
    return;
  }

  await tauriCore.invoke("update_remote_control_shell_snapshot", {
    snapshot,
  });
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

const assertRalphDesktopAvailable = (): never => {
  throw new Error("Ralph flow management is only available in the desktop app.");
};

const assertMcpDesktopAvailable = (): never => {
  throw new Error("MCP management is only available in the desktop app.");
};

const assertInstructionDesktopAvailable = (): never => {
  throw new Error("Instruction management is only available in the desktop app.");
};

const normalizeSchedulerCommandWorkspace = (
  workspaceRoot: string | null | undefined,
): string => {
  return normalizeWorkspaceRoot(workspaceRoot) ?? "";
};

const normalizeMcpCommandWorkspace = (
  workspaceRoot: string | null | undefined,
): string => {
  return normalizeWorkspaceRoot(workspaceRoot) ?? "";
};

const normalizeRalphCommandWorkspace = (
  workspaceRoot: string | null | undefined,
): string => {
  return normalizeWorkspaceRoot(workspaceRoot) ?? "";
};

const normalizeInstructionCommandWorkspace = (
  workspaceRoot: string | null | undefined,
): string => {
  return normalizeWorkspaceRoot(workspaceRoot) ?? "";
};

const normalizeInstructionCliString = (
  value: string | null | undefined,
): string | undefined => {
  const normalizedValue = value?.trim();

  return normalizedValue ? normalizedValue : undefined;
};

const normalizeInstructionCliStringList = (
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

const appendInstructionOption = (
  argumentsList: string[],
  flag: string,
  value: string | number | undefined,
): void => {
  if (value === undefined || value === "") {
    return;
  }

  argumentsList.push(flag);
  argumentsList.push(String(value));
};

const appendInstructionRepeatedOption = (
  argumentsList: string[],
  flag: string,
  values: string[] | undefined,
): void => {
  for (const value of normalizeInstructionCliStringList(values)) {
    argumentsList.push(flag);
    argumentsList.push(value);
  }
};

const createInstructionMutationArguments = (
  action: "create" | "save" | "generate",
  input: InstructionMutationInput,
): string[] => {
  const name = normalizeInstructionCliString(input.name);
  const prompt = normalizeInstructionCliString(input.prompt);

  if (!name) {
    throw new Error("Expected an instruction name.");
  }

  if (!prompt) {
    throw new Error("Expected instruction text or generation prompt.");
  }

  const argumentsList = [action, name];
  appendInstructionOption(argumentsList, "--prompt", prompt);
  appendInstructionOption(argumentsList, "--path", input.path);
  appendInstructionOption(argumentsList, "--scope", input.scope);
  appendInstructionOption(argumentsList, "--instruction-mode", input.mode);
  appendInstructionOption(argumentsList, "--audience", input.audience);
  appendInstructionOption(argumentsList, "--priority", input.priority);
  if (action === "generate") {
    appendInstructionOption(argumentsList, "--max-rounds", input.maxRounds);
  }
  appendInstructionRepeatedOption(argumentsList, "--apply-to", input.applyTo);
  appendInstructionRepeatedOption(argumentsList, "--exclude", input.exclude);
  appendInstructionRepeatedOption(argumentsList, "--keyword", input.keywords);

  return argumentsList;
};

const runInstructionCommand = async <Result>(
  workspaceRoot: string | null | undefined,
  argumentsList: string[],
  fallback: () => Result,
): Promise<Result> => {
  if (!canInvokeTauriCommands()) {
    return fallback();
  }

  try {
    return await tauriCore.invoke<Result>("run_instruction_command", {
      request: {
        workspaceRoot: normalizeInstructionCommandWorkspace(workspaceRoot),
        arguments: argumentsList,
      },
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const listInstructions = async (
  workspaceRoot: string | null | undefined,
): Promise<InstructionRegistryResult> => {
  return runInstructionCommand(
    workspaceRoot,
    ["list"],
    () => ({
      workspaceRoot: normalizeInstructionCommandWorkspace(workspaceRoot),
      instructions: [],
      diagnostics: [],
    }),
  );
};

export const showInstruction = async (
  workspaceRoot: string | null | undefined,
  subject: string,
): Promise<DiscoveredInstruction> => {
  const normalizedSubject = normalizeInstructionCliString(subject);

  if (!normalizedSubject) {
    throw new Error("Expected an instruction name or path.");
  }

  return runInstructionCommand(
    workspaceRoot,
    ["show", normalizedSubject],
    assertInstructionDesktopAvailable,
  );
};

export const validateInstructions = async (
  workspaceRoot: string | null | undefined,
): Promise<InstructionValidationResult> => {
  return runInstructionCommand(
    workspaceRoot,
    ["validate"],
    () => ({ valid: true, diagnostics: [] }),
  );
};

export const createInstruction = async (
  workspaceRoot: string | null | undefined,
  input: InstructionMutationInput,
): Promise<InstructionWriteResult> => {
  return runInstructionCommand(
    workspaceRoot,
    createInstructionMutationArguments("create", input),
    assertInstructionDesktopAvailable,
  );
};

export const saveInstruction = async (
  workspaceRoot: string | null | undefined,
  input: InstructionMutationInput,
): Promise<InstructionWriteResult> => {
  return runInstructionCommand(
    workspaceRoot,
    createInstructionMutationArguments("save", input),
    assertInstructionDesktopAvailable,
  );
};

export const generateInstruction = async (
  workspaceRoot: string | null | undefined,
  input: InstructionMutationInput,
): Promise<InstructionGenerationResult> => {
  return runInstructionCommand(
    workspaceRoot,
    createInstructionMutationArguments("generate", input),
    assertInstructionDesktopAvailable,
  );
};

const runMcpCommand = async <Result>(
  workspaceRoot: string | null | undefined,
  argumentsList: string[],
  fallback: () => Result,
): Promise<Result> => {
  if (!canInvokeTauriCommands()) {
    return fallback();
  }

  try {
    return await tauriCore.invoke<Result>("run_mcp_command", {
      request: {
        workspaceRoot: normalizeMcpCommandWorkspace(workspaceRoot),
        arguments: argumentsList,
      },
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

export const listMcpServers = async (
  workspaceRoot: string | null | undefined,
  includeDisabled = false,
): Promise<McpCommandServersResult> => {
  const argumentsList = includeDisabled
    ? ["servers", "--include-disabled"]
    : ["servers"];

  return runMcpCommand(
    workspaceRoot,
    argumentsList,
    () => ({
      workspaceRoot: normalizeMcpCommandWorkspace(workspaceRoot),
      servers: [],
    }),
  );
};

export const listMcpCachedCapabilities = async (
  workspaceRoot: string | null | undefined,
): Promise<McpCommandCacheResult> => {
  return runMcpCommand(
    workspaceRoot,
    ["cache"],
    () => ({
      workspaceRoot: normalizeMcpCommandWorkspace(workspaceRoot),
      servers: {},
    }),
  );
};

export const discoverMcpServer = async (
  workspaceRoot: string | null | undefined,
  serverId: string,
): Promise<McpCommandDiscoveryResult> => {
  const normalizedServerId = serverId.trim();

  if (!normalizedServerId) {
    throw new Error("Expected an MCP server id.");
  }

  return runMcpCommand(
    workspaceRoot,
    ["discover", normalizedServerId],
    assertMcpDesktopAvailable,
  );
};

export const refreshMcpDiscoveryCache = async (
  workspaceRoot: string | null | undefined,
  serverId: string,
): Promise<McpCommandDiscoveryResult> => {
  const normalizedServerId = serverId.trim();

  if (!normalizedServerId) {
    throw new Error("Expected an MCP server id.");
  }

  return runMcpCommand(
    workspaceRoot,
    ["refresh", normalizedServerId],
    assertMcpDesktopAvailable,
  );
};

export const beginMcpOAuth = async (
  workspaceRoot: string | null | undefined,
  serverId: string,
): Promise<McpCommandOAuthResult> => {
  const normalizedServerId = serverId.trim();

  if (!normalizedServerId) {
    throw new Error("Expected an MCP server id.");
  }

  return runMcpCommand(
    workspaceRoot,
    ["oauth-start", normalizedServerId],
    assertMcpDesktopAvailable,
  );
};

export const finishMcpOAuth = async (
  workspaceRoot: string | null | undefined,
  serverId: string,
  authorizationResponse: string,
): Promise<McpCommandOAuthResult> => {
  const normalizedServerId = serverId.trim();
  const normalizedAuthorizationResponse = authorizationResponse.trim();

  if (!normalizedServerId) {
    throw new Error("Expected an MCP server id.");
  }

  if (!normalizedAuthorizationResponse) {
    throw new Error("Expected an OAuth callback URL or authorization code.");
  }

  return runMcpCommand(
    workspaceRoot,
    ["oauth-finish", normalizedServerId, normalizedAuthorizationResponse],
    assertMcpDesktopAvailable,
  );
};

export const openMcpOAuthAuthorizationUrl = async (
  authorizationUrl: string,
): Promise<void> => {
  const parsedUrl = new URL(authorizationUrl);

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new Error("OAuth authorization URL must use HTTP or HTTPS.");
  }

  if (tauriCore.isTauri()) {
    try {
      await openUrl(parsedUrl.href);
      return;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(parsedUrl.href, "_blank", "noopener,noreferrer");
    return;
  }

  throw new Error("The OAuth authorization URL could not be opened.");
};

const runRalphCommand = async <Result>(
  workspaceRoot: string | null | undefined,
  argumentsList: string[],
  fallback: () => Result,
  options?: { taskId?: string },
): Promise<Result> => {
  if (!canInvokeTauriCommands()) {
    return fallback();
  }

  try {
    return await tauriCore.invoke<Result>("run_ralph_command", {
      request: {
        workspaceRoot: normalizeRalphCommandWorkspace(workspaceRoot),
        arguments: argumentsList,
        ...(options?.taskId ? { taskId: options.taskId } : {}),
      },
    });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};

const createRalphRunArguments = (
  input: RalphRunFlowInput,
): string[] => {
  const normalizedName = input.name.trim();

  if (!normalizedName) {
    throw new Error("Expected a Ralph flow id or alias.");
  }

  const argumentsList = ["run", normalizedName];

  appendSchedulerOption(argumentsList, "--scope", input.scope);
  appendSchedulerOption(argumentsList, "--mode", input.mode);
  appendSchedulerOption(argumentsList, "--profile", normalizeSchedulerCliString(input.profile));
  appendSchedulerOption(argumentsList, "--runtime-provider", input.provider);
  appendSchedulerOption(argumentsList, "--model", normalizeSchedulerCliString(input.model));
  appendSchedulerOption(argumentsList, "--reasoning", input.reasoning);
  appendSchedulerOption(argumentsList, "--max-transitions", input.maxTransitions);

  for (const [name, value] of Object.entries(input.params ?? {})) {
    const normalizedParamName = name.trim();

    if (!normalizedParamName) {
      continue;
    }

    argumentsList.push("--param");
    argumentsList.push(`${normalizedParamName}=${value}`);
  }

  return argumentsList;
};

const createRalphResumeArguments = (
  input: RalphResumeRunInput,
): string[] => {
  const normalizedRunId = input.runId.trim();

  if (!normalizedRunId) {
    throw new Error("Expected a Ralph run id.");
  }

  const argumentsList = [
    "resume",
    normalizedRunId,
    "--input-json",
    JSON.stringify(input.inputResponse),
  ];

  appendSchedulerOption(argumentsList, "--scope", input.scope);
  appendSchedulerOption(argumentsList, "--mode", input.mode);
  appendSchedulerOption(argumentsList, "--profile", normalizeSchedulerCliString(input.profile));
  appendSchedulerOption(argumentsList, "--runtime-provider", input.provider);
  appendSchedulerOption(argumentsList, "--model", normalizeSchedulerCliString(input.model));
  appendSchedulerOption(argumentsList, "--reasoning", input.reasoning);
  appendSchedulerOption(argumentsList, "--max-transitions", input.maxTransitions);

  return argumentsList;
};

const createRalphCreateArguments = (
  input: RalphCreateFlowInput,
): string[] => {
  const prompt = input.prompt.trim();

  if (!prompt) {
    throw new Error("Expected a prompt before creating a Ralph flow.");
  }

  const argumentsList = ["create"];

  appendSchedulerOption(argumentsList, "--scope", input.scope);
  appendSchedulerOption(argumentsList, "--mode", input.mode);
  appendSchedulerOption(argumentsList, "--profile", normalizeSchedulerCliString(input.profile));
  appendSchedulerOption(argumentsList, "--runtime-provider", input.provider);
  appendSchedulerOption(argumentsList, "--model", normalizeSchedulerCliString(input.model));
  appendSchedulerOption(argumentsList, "--reasoning", input.reasoning);
  appendSchedulerOption(argumentsList, "--name", normalizeSchedulerCliString(input.name));
  appendSchedulerOption(argumentsList, "--prompt", prompt);
  appendSchedulerOption(argumentsList, "--existing-flow-json", input.existingFlow
    ? JSON.stringify(input.existingFlow)
    : undefined);
  appendSchedulerOption(argumentsList, "--flow-target", input.target);
  appendSchedulerOption(argumentsList, "--generation-mode", input.generationMode);
  appendSchedulerOption(argumentsList, "--max-rounds", input.maxRounds);

  return argumentsList;
};

const createRalphGenerationInterviewArguments = (
  input: RalphGenerationInterviewInput,
): string[] => {
  const prompt = input.prompt.trim();

  if (!prompt) {
    throw new Error("Expected a prompt before starting a Ralph generation interview.");
  }

  const argumentsList = ["interview"];

  appendSchedulerOption(argumentsList, "--scope", input.scope);
  appendSchedulerOption(argumentsList, "--mode", input.mode);
  appendSchedulerOption(argumentsList, "--profile", normalizeSchedulerCliString(input.profile));
  appendSchedulerOption(argumentsList, "--runtime-provider", input.provider);
  appendSchedulerOption(argumentsList, "--model", normalizeSchedulerCliString(input.model));
  appendSchedulerOption(argumentsList, "--reasoning", input.reasoning);
  appendSchedulerOption(argumentsList, "--name", normalizeSchedulerCliString(input.name));
  appendSchedulerOption(argumentsList, "--prompt", prompt);
  appendSchedulerOption(argumentsList, "--existing-flow-json", input.existingFlow
    ? JSON.stringify(input.existingFlow)
    : undefined);
  appendSchedulerOption(argumentsList, "--flow-target", input.target);
  appendSchedulerOption(argumentsList, "--max-rounds", input.maxTurns);
  const answerComments =
    input.answerComments && Object.keys(input.answerComments).length > 0
      ? input.answerComments
      : undefined;

  if (input.session || input.answers || answerComments) {
    appendSchedulerOption(argumentsList, "--input-json", JSON.stringify({
      ...(input.session ? { session: input.session } : {}),
      ...(input.answers ? { answers: input.answers } : {}),
      ...(answerComments ? { answerComments } : {}),
    }));
  }

  return argumentsList;
};

const createRalphSaveArguments = (
  input: RalphSaveFlowInput,
): string[] => {
  const flowId = input.flow.id.trim();

  if (!flowId) {
    throw new Error("Expected a Ralph flow id.");
  }

  return [
    "save",
    flowId,
    ...(input.scope ? ["--scope", input.scope] : []),
    "--flow-json",
    JSON.stringify(input.flow),
  ];
};

const createRalphDeleteArguments = (
  name: string,
  scope?: RalphFlowScope,
): string[] => {
  const normalizedName = name.trim();

  if (!normalizedName) {
    throw new Error("Expected a Ralph flow id or alias.");
  }

  return ["delete", normalizedName, ...(scope ? ["--scope", scope] : [])];
};

const createRalphRestoreArguments = (
  input: RalphRestoreFlowRevisionInput,
): string[] => {
  const flowId = input.name.trim();
  const revisionId = input.revision.trim();

  if (!flowId) {
    throw new Error("Expected a Ralph flow id or alias.");
  }

  if (!revisionId) {
    throw new Error("Expected a Ralph revision id.");
  }

  return [
    "restore",
    flowId,
    ...(input.scope ? ["--scope", input.scope] : []),
    "--revision",
    revisionId,
  ];
};

export const listRalphFlows = async (
  workspaceRoot: string | null | undefined,
  scope?: RalphFlowScope,
): Promise<RalphListFlowsResult> => {
  return runRalphCommand(
    workspaceRoot,
    ["list", ...(scope ? ["--scope", scope] : [])],
    () => ({
      workspaceRoot: normalizeRalphCommandWorkspace(workspaceRoot),
      ...(scope ? { scope } : {}),
      flows: [],
    }),
  );
};

export const showRalphFlow = async (
  workspaceRoot: string | null | undefined,
  name: string,
  scope?: RalphFlowScope,
): Promise<RalphFlowResult> => {
  const normalizedName = name.trim();

  if (!normalizedName) {
    throw new Error("Expected a Ralph flow id or alias.");
  }

  return runRalphCommand(
    workspaceRoot,
    ["show", normalizedName, ...(scope ? ["--scope", scope] : [])],
    assertRalphDesktopAvailable,
  );
};

export const validateRalphFlow = async (
  workspaceRoot: string | null | undefined,
  name: string,
  scope?: RalphFlowScope,
): Promise<RalphValidateFlowResult> => {
  const normalizedName = name.trim();

  if (!normalizedName) {
    throw new Error("Expected a Ralph flow id or alias.");
  }

  return runRalphCommand(
    workspaceRoot,
    ["validate", normalizedName, ...(scope ? ["--scope", scope] : [])],
    assertRalphDesktopAvailable,
  );
};

export const listRalphFlowRevisions = async (
  workspaceRoot: string | null | undefined,
  name: string,
  scope?: RalphFlowScope,
): Promise<RalphListFlowRevisionsResult> => {
  const normalizedName = name.trim();

  if (!normalizedName) {
    throw new Error("Expected a Ralph flow id or alias.");
  }

  return runRalphCommand(
    workspaceRoot,
    ["revisions", normalizedName, ...(scope ? ["--scope", scope] : [])],
    () => ({
      flow: normalizedName,
      ...(scope ? { scope } : {}),
      revisions: [],
    }),
  );
};

export const listRalphRuns = async (
  workspaceRoot: string | null | undefined,
  flowId?: string,
  scope?: RalphFlowScope,
): Promise<RalphListRunsResult> => {
  const normalizedFlowId = flowId?.trim();

  return runRalphCommand(
    workspaceRoot,
    [
      "runs",
      ...(normalizedFlowId ? [normalizedFlowId] : []),
      ...(scope ? ["--scope", scope] : []),
    ],
    () => ({ runs: [] }),
  );
};

export const showRalphRunLog = async (
  workspaceRoot: string | null | undefined,
  runId: string,
  kind: "simple" | "trace" = "simple",
  scope?: RalphFlowScope,
): Promise<RalphRunLogResult> => {
  const normalizedRunId = runId.trim();

  if (!normalizedRunId) {
    throw new Error("Expected a Ralph run id.");
  }

  return runRalphCommand(
    workspaceRoot,
    [
      "log",
      normalizedRunId,
      ...(kind === "trace" ? ["--trace"] : []),
      ...(scope ? ["--scope", scope] : []),
    ],
    assertRalphDesktopAvailable,
  );
};

export const showRalphRunDetail = async (
  workspaceRoot: string | null | undefined,
  runId: string,
  scope?: RalphFlowScope,
): Promise<RalphRunDetailResult> => {
  const normalizedRunId = runId.trim();

  if (!normalizedRunId) {
    throw new Error("Expected a Ralph run id.");
  }

  return runRalphCommand(
    workspaceRoot,
    [
      "run-detail",
      normalizedRunId,
      ...(scope ? ["--scope", scope] : []),
    ],
    assertRalphDesktopAvailable,
  );
};

export const createRalphFlow = async (
  workspaceRoot: string | null | undefined,
  input: RalphCreateFlowInput,
): Promise<RalphCreateFlowResult> => {
  return runRalphCommand(
    workspaceRoot,
    createRalphCreateArguments(input),
    assertRalphDesktopAvailable,
    input.taskId ? { taskId: input.taskId } : undefined,
  );
};

export const runRalphGenerationInterview = async (
  workspaceRoot: string | null | undefined,
  input: RalphGenerationInterviewInput,
): Promise<RalphGenerationInterviewResult> => {
  return runRalphCommand(
    workspaceRoot,
    createRalphGenerationInterviewArguments(input),
    assertRalphDesktopAvailable,
    input.taskId ? { taskId: input.taskId } : undefined,
  );
};

export const saveRalphFlow = async (
  workspaceRoot: string | null | undefined,
  input: RalphSaveFlowInput,
): Promise<RalphSaveFlowResult> => {
  return runRalphCommand(
    workspaceRoot,
    createRalphSaveArguments(input),
    assertRalphDesktopAvailable,
  );
};

export const deleteRalphFlow = async (
  workspaceRoot: string | null | undefined,
  name: string,
  scope?: RalphFlowScope,
): Promise<RalphDeleteFlowResult> => {
  return runRalphCommand(
    workspaceRoot,
    createRalphDeleteArguments(name, scope),
    assertRalphDesktopAvailable,
  );
};

export const restoreRalphFlowRevision = async (
  workspaceRoot: string | null | undefined,
  input: RalphRestoreFlowRevisionInput,
): Promise<RalphRestoreFlowRevisionResult> => {
  return runRalphCommand(
    workspaceRoot,
    createRalphRestoreArguments(input),
    assertRalphDesktopAvailable,
  );
};

export const runRalphFlow = async (
  workspaceRoot: string | null | undefined,
  input: RalphRunFlowInput,
): Promise<RalphRunFlowResult> => {
  return runRalphCommand(
    workspaceRoot,
    createRalphRunArguments(input),
    assertRalphDesktopAvailable,
    input.taskId ? { taskId: input.taskId } : undefined,
  );
};

export const resumeRalphRun = async (
  workspaceRoot: string | null | undefined,
  input: RalphResumeRunInput,
): Promise<RalphRunFlowResult> => {
  return runRalphCommand(
    workspaceRoot,
    createRalphResumeArguments(input),
    assertRalphDesktopAvailable,
    input.taskId ? { taskId: input.taskId } : undefined,
  );
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

const serializeSchedulerTriggerFilterValue = (value: unknown): string => {
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }

  return String(value);
};

const appendSchedulerCreateTriggers = (
  argumentsList: string[],
  triggers: SchedulerCreateTriggerInput[] | undefined,
): void => {
  for (const trigger of triggers ?? []) {
    if (trigger.kind === "time" || trigger.schedule) {
      continue;
    }

    const eventType = normalizeSchedulerCliString(trigger.eventType);

    if (!eventType) {
      continue;
    }

    appendSchedulerOption(
      argumentsList,
      "--trigger",
      `${trigger.kind}:${eventType}`,
    );

    for (const [key, value] of Object.entries(trigger.filters ?? {})) {
      appendSchedulerOption(
        argumentsList,
        "--trigger-filter",
        `${key}=${serializeSchedulerTriggerFilterValue(value)}`,
      );
    }

    for (const [key, value] of Object.entries(trigger.recoveryFilters ?? {})) {
      appendSchedulerOption(
        argumentsList,
        "--trigger-recovery-filter",
        `${key}=${serializeSchedulerTriggerFilterValue(value)}`,
      );
    }

    appendSchedulerOption(argumentsList, "--trigger-firing-mode", trigger.firingMode);
    appendSchedulerOption(argumentsList, "--trigger-cooldown-ms", trigger.cooldownMs);
    appendSchedulerOption(
      argumentsList,
      "--trigger-repeat-ms",
      trigger.repeatIntervalMs,
    );
    appendSchedulerOption(argumentsList, "--trigger-debounce-ms", trigger.debounceMs);
    appendSchedulerOption(
      argumentsList,
      "--trigger-dedupe-key-template",
      normalizeSchedulerCliString(trigger.dedupeKeyTemplate),
    );
    appendSchedulerOption(
      argumentsList,
      "--trigger-max-events",
      trigger.maxEventsPerWindow?.maxEvents,
    );
    appendSchedulerOption(
      argumentsList,
      "--trigger-window-ms",
      trigger.maxEventsPerWindow?.windowMs,
    );
  }
};

const appendSchedulerRalphFlowTarget = (
  argumentsList: string[],
  ralphFlow: SchedulerRalphFlowInput,
): void => {
  appendSchedulerOption(argumentsList, "--scheduler-target", "ralph-flow");
  appendSchedulerOption(
    argumentsList,
    "--scheduled-ralph-flow",
    normalizeSchedulerCliString(ralphFlow.id),
  );
  appendSchedulerOption(argumentsList, "--scheduled-ralph-flow-scope", ralphFlow.scope);
  appendSchedulerOption(
    argumentsList,
    "--scheduled-ralph-run-log-scope",
    ralphFlow.runLogScope,
  );
  appendSchedulerOption(
    argumentsList,
    "--scheduled-ralph-max-transitions",
    ralphFlow.maxTransitions,
  );

  for (const [name, value] of Object.entries(ralphFlow.params ?? {})) {
    appendSchedulerOption(argumentsList, "--scheduled-ralph-param", `${name}=${value}`);
  }

  appendSchedulerRepeatedOption(
    argumentsList,
    "--scheduled-ralph-allowed-root",
    ralphFlow.permissions.allowedRoots,
  );
  appendSchedulerOption(
    argumentsList,
    "--scheduled-ralph-allow-commands",
    ralphFlow.permissions.allowCommands,
  );
  appendSchedulerOption(
    argumentsList,
    "--scheduled-ralph-allow-writes",
    ralphFlow.permissions.allowWrites,
  );
  appendSchedulerOption(
    argumentsList,
    "--scheduled-ralph-allow-network",
    ralphFlow.permissions.allowNetwork,
  );
  appendSchedulerOption(
    argumentsList,
    "--scheduled-ralph-allow-mcp-tools",
    ralphFlow.permissions.allowMcpTools,
  );
};

const createSchedulerCreateArguments = (
  input: SchedulerCreateJobInput,
): string[] => {
  const argumentsList = ["create"];
  const targetType = input.targetType ?? "prompt";
  const prompt = normalizeSchedulerCliString(input.prompt);
  const promptFile = normalizeSchedulerCliString(input.promptFile);

  if (targetType === "prompt" && !prompt && !promptFile) {
    throw new Error("Expected a prompt or prompt file before creating a scheduled job.");
  }

  if (targetType === "ralph-flow" && !input.ralphFlow) {
    throw new Error("Expected a Ralph flow target before creating a scheduled job.");
  }

  appendSchedulerOption(argumentsList, "--name", normalizeSchedulerCliString(input.name));
  if (input.schedule) {
    appendSchedulerCreateSchedule(argumentsList, input.schedule);
  }
  appendSchedulerCreateTriggers(argumentsList, input.triggers);
  if (targetType === "ralph-flow" && input.ralphFlow) {
    appendSchedulerRalphFlowTarget(argumentsList, input.ralphFlow);
  } else {
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
  }
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
  appendSchedulerOption(argumentsList, "--reasoning", input.reasoning);

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
    reasoning?: RuntimeSnapshot["reasoning"];
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
  const normalizedReasoning = context.reasoning;
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
        ...(normalizedReasoning ? { reasoning: normalizedReasoning } : {}),
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

export const openAttachedPath = async (
  path: string,
  workspaceRoot?: string | null,
): Promise<void> => {
  const normalizedPath = path.trim();
  const normalizedWorkspaceRoot = normalizeWorkspaceRoot(workspaceRoot);

  if (!normalizedPath) {
    throw new Error("Expected an attached file path.");
  }

  if (!canInvokeTauriCommands()) {
    return;
  }

  try {
    await tauriCore.invoke("open_attached_path", {
      path: normalizedPath,
      workspaceRoot: normalizedWorkspaceRoot,
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
