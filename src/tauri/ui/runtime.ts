import * as tauriCore from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  ConversationMemoryEntry,
  TaskConversationContext,
  TaskExecutionResult,
  TaskRunPreview,
  UiControlAvailability,
} from "../../core/types.js";
import {
  SUPPORTED_PROVIDER_ORDER,
  type RuntimeProvider,
} from "./model-catalog";
import {
  createMockExecutionFixture,
  createPreviewFixture,
} from "./preview/fixtures";

export type UserApiKeyProvider = RuntimeProvider;

export type WebSearchProvider = "none" | "perplexity" | "tavily" | "serper";

export type VoiceAiProvider = "none" | "openai" | "google";

export type SpeechToTextProvider = "none" | "openai" | "google";

export type UserWebSearchApiKeyProvider = Exclude<WebSearchProvider, "none">;

export type UserVoiceAiProvider = Exclude<VoiceAiProvider, "none">;

export type UserSpeechToTextProvider = Exclude<SpeechToTextProvider, "none">;

export const MAIN_WINDOW_LABEL = "main";
export const ASSISTANT_BUBBLE_WINDOW_LABEL = "assistant-bubble";
export const ASSISTANT_POPUP_WINDOW_LABEL = "assistant-popup";
export const QUICK_VOICE_WINDOW_LABEL = "quick-voice";
export const DESKTOP_SETTINGS_CHANGED_EVENT =
  "machdoch://desktop-settings-changed";
export const QUICK_VOICE_START_EVENT = "machdoch://quick-voice-start";

export const USER_API_KEY_PROVIDER_ORDER: UserApiKeyProvider[] = [
  ...SUPPORTED_PROVIDER_ORDER,
];

export const USER_VOICE_AI_PROVIDER_ORDER: UserVoiceAiProvider[] = [
  "openai",
  "google",
];

export const USER_SPEECH_TO_TEXT_PROVIDER_ORDER: UserSpeechToTextProvider[] = [
  "openai",
  "google",
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
  "perplexity",
  "tavily",
  "serper",
];

export type UserProviderApiKeys = Partial<Record<UserApiKeyProvider, string>>;

export type UserWebSearchApiKeys = Partial<
  Record<UserWebSearchApiKeyProvider, string>
>;

export interface RuntimeProviderAvailability {
  provider: RuntimeProvider;
  configured: boolean;
}

export interface WebSearchProviderAvailability {
  provider: UserWebSearchApiKeyProvider;
  configured: boolean;
}

export interface VoiceProviderAvailability {
  provider: UserVoiceAiProvider;
  configured: boolean;
}

export interface SpeechToTextProviderAvailability {
  provider: UserSpeechToTextProvider;
  configured: boolean;
}

export interface RuntimeWebSearchConfig {
  activeProvider: WebSearchProvider;
  providerAvailability: WebSearchProviderAvailability[];
}

export interface UserWebSearchSettings {
  activeProvider: WebSearchProvider;
  apiKeys: UserWebSearchApiKeys;
  providerAvailability: WebSearchProviderAvailability[];
}

export interface UserVoiceSettings {
  activeProvider: VoiceAiProvider;
  providerAvailability: VoiceProviderAvailability[];
}

export interface UserSpeechToTextSettings {
  activeProvider: SpeechToTextProvider;
  inputDeviceId: string | null;
  providerAvailability: SpeechToTextProviderAvailability[];
}

export interface UserMemorySettings {
  globalEnabled: boolean;
  entries: ConversationMemoryEntry[];
}

export interface UserDesktopSettings {
  autostartEnabled: boolean;
  autostartMinimized: boolean;
  autostartToTray: boolean;
  assistantBubbleEnabled: boolean;
  assistantBubbleHideWhenFullscreen: boolean;
  assistantBubbleTemporarilyHideSeconds: number;
  aiContextMaxMessages: number;
  quickVoiceEnabled: boolean;
  quickVoiceShortcut: string;
  quickVoiceSilenceSeconds: number;
  quickVoiceMaxMessages: number;
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

export interface RuntimeProfileSummary {
  name: string;
  description?: string;
}

export interface RuntimeCompatibilityConfig {
  discoverGithubCustomizations: boolean;
}

export interface RuntimeSnapshot {
  workspaceRoot: string;
  workspaceConfigPath?: string;
  activeProfile?: string;
  availableProfiles: RuntimeProfileSummary[];
  mode: "safe" | "ask" | "auto";
  enabledTools: string[];
  provider: RuntimeProvider | "unconfigured";
  model: string;
  offline: boolean;
  compatibility: RuntimeCompatibilityConfig;
  providerAvailability: RuntimeProviderAvailability[];
  webSearch: RuntimeWebSearchConfig;
  uiControl?: UiControlAvailability;
}

export interface DesktopTaskRunResponse {
  execution: TaskExecutionResult;
  preview?: TaskRunPreview;
}

export interface DesktopTaskProgressEvent {
  taskId: string;
  line: string;
  timestamp: number;
}

const DEFAULT_MOCK_WORKSPACE_ROOT = "/mock/home/path";
const DESKTOP_TASK_PROGRESS_EVENT = "desktop-task-progress";

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

const createDefaultUserDesktopSettings = (): UserDesktopSettings => {
  return {
    autostartEnabled: false,
    autostartMinimized: false,
    autostartToTray: false,
    assistantBubbleEnabled: true,
    assistantBubbleHideWhenFullscreen: true,
    assistantBubbleTemporarilyHideSeconds: 6,
    aiContextMaxMessages: 60,
    quickVoiceEnabled: true,
    quickVoiceShortcut: "CommandOrControl+Alt+V",
    quickVoiceSilenceSeconds: 1.8,
    quickVoiceMaxMessages: 50,
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
  if (!canInvokeTauriCommands()) {
    const nextSettings = {
      ...createDefaultUserDesktopSettings(),
      ...settings,
    };

    await emitDesktopSettingsChanged(nextSettings);
    return nextSettings;
  }

  try {
    const nextSettings = await tauriCore.invoke<UserDesktopSettings>(
      "save_user_desktop_settings",
      { settings },
    );

    await emitDesktopSettingsChanged(nextSettings);
    return nextSettings;
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
    return await listen<DesktopTaskProgressEvent>(
      DESKTOP_TASK_PROGRESS_EVENT,
      (event) => {
        onProgress(event.payload);
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
