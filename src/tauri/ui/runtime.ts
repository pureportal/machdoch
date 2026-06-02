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
  DEFAULT_USER_DESKTOP_SETTINGS,
  DESKTOP_SETTING_BOUNDS,
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

const DEFAULT_MOCK_WORKSPACE_ROOT = "/mock/home/path";
const DESKTOP_TASK_PROGRESS_EVENT = "desktop-task-progress";
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
  "approval-required",
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
        typeof value.actionOutput.chunk === "string"))
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
