import { invoke } from "@tauri-apps/api/core";
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
  canUseTauriStore,
  getLocalStorage,
  loadStoredValue,
  saveStoredValue,
} from "./_helpers/shell-store-storage.helper";
import {
  beginCrossWindowOperation,
  releaseCrossWindowOperation,
} from "./cross-window-operation";
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
const BROWSER_SHELL_SNAPSHOT_STORAGE_KEY =
  "machdoch.desktop.shell-state-snapshot";
const APP_SHELL_STORAGE_KEY = "machdoch.desktop.app-shell-state";
const RUNNING_TASK_MESSAGE_ACTION_STORAGE_KEY =
  "machdoch.desktop.running-task-message-action";
const RALPH_SETTINGS_STORAGE_KEY = "machdoch.desktop.ralph-settings";
const ONBOARDING_STORAGE_KEY = "machdoch.desktop.onboarding-state";
const APPEARANCE_STORAGE_KEY = "machdoch.desktop.appearance-state";
const MCP_MARKETPLACE_STORAGE_KEY = "machdoch.desktop.mcp-marketplace-state";

export interface ShellStateSnapshot<T> {
  state: T;
  revision: number;
}

export interface ShellStateCompareAndSwapResult<T>
  extends ShellStateSnapshot<T> {
  committed: boolean;
}

const MAX_SHELL_STATE_COMMIT_ATTEMPTS = 12;
let browserShellStateCommitChain: Promise<void> = Promise.resolve();

const waitForStoreLeaseRetry = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
};

const withStoredValueWriteLock = async <T>(
  storageKey: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const operationId = `machdoch:store-write:${storageKey}`;

  if (
    !canUseTauriStore() &&
    typeof navigator !== "undefined" &&
    navigator.locks
  ) {
    return navigator.locks.request(operationId, { mode: "exclusive" }, operation);
  }

  for (let attempt = 0; attempt < 250; attempt += 1) {
    const lease = await beginCrossWindowOperation(operationId, 10_000);

    if (!lease) {
      await waitForStoreLeaseRetry();
      continue;
    }

    try {
      return await operation();
    } finally {
      await releaseCrossWindowOperation(lease).catch(() => false);
    }
  }

  throw new Error(`Timed out waiting to update ${storageKey}.`);
};

const saveRequiredStoredValueUnlocked = async (
  options: Parameters<typeof saveStoredValue>[0],
): Promise<void> => {
  const saved = await saveStoredValue(options);

  if (!saved) {
    throw new Error(options.localStorageErrorMessage);
  }
};

const saveRequiredStoredValue = async (
  options: Parameters<typeof saveStoredValue>[0],
): Promise<void> => {
  await withStoredValueWriteLock(options.storageKey, () =>
    saveRequiredStoredValueUnlocked(options),
  );
};

const runBrowserShellStateCommit = async <T>(
  operation: () => Promise<T>,
): Promise<T> => {
  if (typeof navigator !== "undefined" && navigator.locks) {
    return navigator.locks.request(
      "machdoch:browser-shell-state",
      { mode: "exclusive" },
      operation,
    );
  }

  const previousCommit = browserShellStateCommitChain;
  let releaseCommit: (() => void) | undefined;

  browserShellStateCommitChain = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });

  await previousCommit;

  try {
    return await operation();
  } finally {
    releaseCommit?.();
  }
};

const loadBrowserShellStateSnapshot = async <T>(
  fallback: T,
): Promise<ShellStateSnapshot<T>> => {
  const localStorage = getLocalStorage();

  if (localStorage) {
    try {
      const raw = localStorage.getItem(BROWSER_SHELL_SNAPSHOT_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ShellStateSnapshot<T>>;
        if (
          typeof parsed.revision === "number" &&
          Number.isSafeInteger(parsed.revision) &&
          parsed.revision >= 0 &&
          "state" in parsed
        ) {
          return {
            state: parsed.state as T,
            revision: parsed.revision,
          };
        }
      }
    } catch (error) {
      console.error("Failed to load browser shell snapshot", error);
    }
  }

  return {
    state: await loadStoredValue<T>({
      storageKey: STORAGE_KEY,
      fallback,
      tauriErrorMessage: "Failed to load shell state from Tauri store",
      localStorageErrorMessage: "Failed to load shell state from localStorage",
    }),
    revision: 0,
  };
};

export const loadShellStateSnapshot = async <T>(
  fallback: T,
): Promise<ShellStateSnapshot<T>> => {
  if (canUseTauriStore()) {
    return invoke<ShellStateSnapshot<T>>("load_shell_state_snapshot", {
      fallback,
    });
  }

  return runBrowserShellStateCommit(() =>
    loadBrowserShellStateSnapshot(fallback),
  );
};

export const compareAndSwapShellState = async <T>(
  expectedRevision: number,
  state: T,
): Promise<ShellStateCompareAndSwapResult<T>> => {
  if (canUseTauriStore()) {
    return invoke<ShellStateCompareAndSwapResult<T>>(
      "compare_and_swap_shell_state",
      {
        request: {
          expectedRevision,
          state,
        },
      },
    );
  }

  return runBrowserShellStateCommit(async () => {
    const snapshot = await loadBrowserShellStateSnapshot(state);

    if (snapshot.revision !== expectedRevision) {
      return {
        committed: false,
        state: snapshot.state,
        revision: snapshot.revision,
      };
    }

    const localStorage = getLocalStorage();
    if (!localStorage) {
      throw new Error("Failed to persist shell state to durable storage.");
    }

    const revision = snapshot.revision + 1;
    localStorage.setItem(
      BROWSER_SHELL_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({ state, revision } satisfies ShellStateSnapshot<T>),
    );

    return {
      committed: true,
      state,
      revision,
    };
  });
};

export const updateShellStateAtomically = async <T>(
  fallback: T,
  updater: (current: T) => T,
): Promise<ShellStateSnapshot<T>> => {
  let snapshot = await loadShellStateSnapshot(fallback);

  for (
    let attempt = 0;
    attempt < MAX_SHELL_STATE_COMMIT_ATTEMPTS;
    attempt += 1
  ) {
    const nextState = updater(snapshot.state);
    const result = await compareAndSwapShellState(
      snapshot.revision,
      nextState,
    );

    if (result.committed) {
      return {
        state: result.state,
        revision: result.revision,
      };
    }

    snapshot = {
      state: result.state,
      revision: result.revision,
    };
  }

  throw new Error(
    "Unable to persist shell state because it kept changing in another window.",
  );
};

export const loadShellState = async <T>(fallback: T): Promise<T> => {
  return (await loadShellStateSnapshot(fallback)).state;
};

export const saveShellState = async <T>(state: T): Promise<void> => {
  await updateShellStateAtomically(state, () => state);
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

  await saveRequiredStoredValue({
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

  await saveRequiredStoredValue({
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

  await saveRequiredStoredValue({
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
  await saveRequiredStoredValue({
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
  baseSettings: AppearanceSettings = settings,
): Promise<AppearanceSettings> => {
  const normalizedSettings = normalizeAppearanceSettings(settings);
  const normalizedBase = normalizeAppearanceSettings(baseSettings);
  const committedSettings = await withStoredValueWriteLock(
    APPEARANCE_STORAGE_KEY,
    async () => {
      const latest = await loadAppearanceSettings();
      const rebased: AppearanceSettings = {
        version: 1,
        theme:
          normalizedSettings.theme !== normalizedBase.theme
            ? normalizedSettings.theme
            : latest.theme,
        density:
          normalizedSettings.density !== normalizedBase.density
            ? normalizedSettings.density
            : latest.density,
        accent:
          normalizedSettings.accent !== normalizedBase.accent
            ? normalizedSettings.accent
            : latest.accent,
        quickChatBubbleStyle:
          normalizedSettings.quickChatBubbleStyle !==
          normalizedBase.quickChatBubbleStyle
            ? normalizedSettings.quickChatBubbleStyle
            : latest.quickChatBubbleStyle,
      };

      await saveRequiredStoredValueUnlocked({
        storageKey: APPEARANCE_STORAGE_KEY,
        value: rebased,
        tauriErrorMessage:
          "Failed to persist appearance settings to Tauri store",
        localStorageErrorMessage:
          "Failed to persist appearance settings to localStorage",
      });
      return rebased;
    },
  );

  await broadcastAppearanceSettingsChanged();
  return committedSettings;
};

export const updateMcpMarketplaceStateAtomically = async (
  update: (state: McpMarketplaceState) => McpMarketplaceState,
): Promise<McpMarketplaceState> => {
  return withStoredValueWriteLock(MCP_MARKETPLACE_STORAGE_KEY, async () => {
    const latest = await loadMcpMarketplaceState();
    const next = normalizeMcpMarketplaceState(update(latest));
    await saveRequiredStoredValueUnlocked({
      storageKey: MCP_MARKETPLACE_STORAGE_KEY,
      value: next,
      tauriErrorMessage:
        "Failed to persist MCP marketplace state to Tauri store",
      localStorageErrorMessage:
        "Failed to persist MCP marketplace state to localStorage",
    });
    return next;
  });
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

  await saveRequiredStoredValue({
    storageKey: MCP_MARKETPLACE_STORAGE_KEY,
    value: normalizedState,
    tauriErrorMessage:
      "Failed to persist MCP marketplace state to Tauri store",
    localStorageErrorMessage:
      "Failed to persist MCP marketplace state to localStorage",
  });
};
