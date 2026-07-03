import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_APP_SHELL_STATE,
  DEFAULT_MCP_MARKETPLACE_STATE,
  DEFAULT_RALPH_SETTINGS,
  DEFAULT_RUNNING_TASK_MESSAGE_ACTION,
  normalizeAppearanceSettings,
  normalizeAppShellState,
  normalizeMcpMarketplaceState,
  normalizeRalphSettings,
  normalizeRunningTaskMessageAction,
} from "./_helpers/shell-store-normalizers.helper";
import {
  broadcastAppearanceSettingsChanged,
  loadStoredValue,
  saveStoredValue,
} from "./_helpers/shell-store-storage.helper";
import type {
  AppearanceSettings,
  AppShellState,
  McpMarketplaceState,
  OnboardingState,
  RalphSettings,
  RunningTaskMessageAction,
} from "./_helpers/shell-store-normalizers.helper";

export {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_APP_SHELL_STATE,
  DEFAULT_MCP_MARKETPLACE_STATE,
  DEFAULT_RALPH_SETTINGS,
  DEFAULT_RUNNING_TASK_MESSAGE_ACTION,
} from "./_helpers/shell-store-normalizers.helper";
export type {
  AppearanceAccent,
  AppearanceDensity,
  AppearanceSettings,
  AppearanceTheme,
  AppShellState,
  MainAppId,
  McpMarketplaceRegistrySourceState,
  McpMarketplaceState,
  OnboardingState,
  QuickChatBubbleStyle,
  RalphFlowLibraryMode,
  RalphSettings,
  RunningTaskMessageAction,
} from "./_helpers/shell-store-normalizers.helper";
export {
  broadcastAppearanceSettingsChanged,
  broadcastShellStateChanged,
  getCurrentShellWindowLabel,
  subscribeToAppearanceSettingsChanged,
  subscribeToShellStateChanged,
} from "./_helpers/shell-store-storage.helper";
export type {
  AppearanceSettingsChangedPayload,
  ShellStateChangedPayload,
} from "./_helpers/shell-store-storage.helper";

const STORAGE_KEY = "machdoch.desktop.shell-state";
const APP_SHELL_STORAGE_KEY = "machdoch.desktop.app-shell-state";
const RUNNING_TASK_MESSAGE_ACTION_STORAGE_KEY =
  "machdoch.desktop.running-task-message-action";
const RALPH_SETTINGS_STORAGE_KEY = "machdoch.desktop.ralph-settings";
const ONBOARDING_STORAGE_KEY = "machdoch.desktop.onboarding-state";
const APPEARANCE_STORAGE_KEY = "machdoch.desktop.appearance-state";
const MCP_MARKETPLACE_STORAGE_KEY = "machdoch.desktop.mcp-marketplace-state";

export const loadShellState = async <T>(fallback: T): Promise<T> => {
  return loadStoredValue<T>({
    storageKey: STORAGE_KEY,
    fallback,
    tauriErrorMessage: "Failed to load shell state from Tauri store",
    localStorageErrorMessage: "Failed to load shell state from localStorage",
  });
};

export const saveShellState = async <T>(state: T): Promise<void> => {
  await saveStoredValue({
    storageKey: STORAGE_KEY,
    value: state,
    tauriErrorMessage: "Failed to persist shell state to Tauri store",
    localStorageErrorMessage: "Failed to persist shell state to localStorage",
  });
};

export const loadAppShellState = async (): Promise<AppShellState> => {
  return loadStoredValue<AppShellState>({
    storageKey: APP_SHELL_STORAGE_KEY,
    fallback: DEFAULT_APP_SHELL_STATE,
    normalize: normalizeAppShellState,
    tauriErrorMessage: "Failed to load app shell state from Tauri store",
    localStorageErrorMessage:
      "Failed to load app shell state from localStorage",
  });
};

export const saveAppShellState = async (
  state: AppShellState,
): Promise<void> => {
  const normalizedState = normalizeAppShellState(state);

  await saveStoredValue({
    storageKey: APP_SHELL_STORAGE_KEY,
    value: normalizedState,
    tauriErrorMessage: "Failed to persist app shell state to Tauri store",
    localStorageErrorMessage:
      "Failed to persist app shell state to localStorage",
  });
};

export const loadRunningTaskMessageAction =
  async (): Promise<RunningTaskMessageAction> => {
    return loadStoredValue<RunningTaskMessageAction>({
      storageKey: RUNNING_TASK_MESSAGE_ACTION_STORAGE_KEY,
      fallback: DEFAULT_RUNNING_TASK_MESSAGE_ACTION,
      normalize: normalizeRunningTaskMessageAction,
      parseLocalStorage: (raw) => raw,
      tauriErrorMessage:
        "Failed to load running task message action from Tauri store",
      localStorageErrorMessage:
        "Failed to load running task message action from localStorage",
    });
  };

export const saveRunningTaskMessageAction = async (
  action: RunningTaskMessageAction,
): Promise<void> => {
  const normalizedAction = normalizeRunningTaskMessageAction(action);

  await saveStoredValue({
    storageKey: RUNNING_TASK_MESSAGE_ACTION_STORAGE_KEY,
    value: normalizedAction,
    serializeLocalStorage: String,
    tauriErrorMessage:
      "Failed to persist running task message action to Tauri store",
    localStorageErrorMessage:
      "Failed to persist running task message action to localStorage",
  });
};

export const loadRalphSettings = async (): Promise<RalphSettings> => {
  return loadStoredValue<RalphSettings>({
    storageKey: RALPH_SETTINGS_STORAGE_KEY,
    fallback: DEFAULT_RALPH_SETTINGS,
    normalize: normalizeRalphSettings,
    tauriErrorMessage: "Failed to load Ralph settings from Tauri store",
    localStorageErrorMessage: "Failed to load Ralph settings from localStorage",
  });
};

export const saveRalphSettings = async (
  settings: RalphSettings,
): Promise<void> => {
  const normalizedSettings = normalizeRalphSettings(settings);

  await saveStoredValue({
    storageKey: RALPH_SETTINGS_STORAGE_KEY,
    value: normalizedSettings,
    tauriErrorMessage: "Failed to persist Ralph settings to Tauri store",
    localStorageErrorMessage:
      "Failed to persist Ralph settings to localStorage",
  });
};

export const loadOnboardingState =
  async (): Promise<OnboardingState | null> => {
    return loadStoredValue<OnboardingState | null>({
      storageKey: ONBOARDING_STORAGE_KEY,
      fallback: null,
      tauriErrorMessage: "Failed to load onboarding state from Tauri store",
      localStorageErrorMessage:
        "Failed to load onboarding state from localStorage",
    });
  };

export const saveOnboardingState = async (
  state: OnboardingState,
): Promise<void> => {
  await saveStoredValue({
    storageKey: ONBOARDING_STORAGE_KEY,
    value: state,
    tauriErrorMessage: "Failed to persist onboarding state to Tauri store",
    localStorageErrorMessage:
      "Failed to persist onboarding state to localStorage",
  });
};

export const loadAppearanceSettings =
  async (): Promise<AppearanceSettings> => {
    return loadStoredValue<AppearanceSettings>({
      storageKey: APPEARANCE_STORAGE_KEY,
      fallback: DEFAULT_APPEARANCE_SETTINGS,
      normalize: normalizeAppearanceSettings,
      tauriErrorMessage:
        "Failed to load appearance settings from Tauri store",
      localStorageErrorMessage:
        "Failed to load appearance settings from localStorage",
    });
  };

export const saveAppearanceSettings = async (
  settings: AppearanceSettings,
): Promise<void> => {
  const normalizedSettings = normalizeAppearanceSettings(settings);

  const saved = await saveStoredValue({
    storageKey: APPEARANCE_STORAGE_KEY,
    value: normalizedSettings,
    tauriErrorMessage: "Failed to persist appearance settings to Tauri store",
    localStorageErrorMessage:
      "Failed to persist appearance settings to localStorage",
  });

  if (saved) {
    await broadcastAppearanceSettingsChanged();
  }
};

export const loadMcpMarketplaceState =
  async (): Promise<McpMarketplaceState> => {
    return loadStoredValue<McpMarketplaceState>({
      storageKey: MCP_MARKETPLACE_STORAGE_KEY,
      fallback: DEFAULT_MCP_MARKETPLACE_STATE,
      normalize: normalizeMcpMarketplaceState,
      tauriErrorMessage:
        "Failed to load MCP marketplace state from Tauri store",
      localStorageErrorMessage:
        "Failed to load MCP marketplace state from localStorage",
    });
  };

export const saveMcpMarketplaceState = async (
  state: McpMarketplaceState,
): Promise<void> => {
  const normalizedState = normalizeMcpMarketplaceState(state);

  await saveStoredValue({
    storageKey: MCP_MARKETPLACE_STORAGE_KEY,
    value: normalizedState,
    tauriErrorMessage:
      "Failed to persist MCP marketplace state to Tauri store",
    localStorageErrorMessage:
      "Failed to persist MCP marketplace state to localStorage",
  });
};
