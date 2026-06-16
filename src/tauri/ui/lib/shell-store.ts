import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";
import { REASONING_MODES } from "../../../core/runtime-contract.generated.js";
import type { ReasoningMode } from "../../../core/runtime-contract.generated.js";
import {
  getDefaultModelForProvider,
  SUPPORTED_PROVIDER_ORDER,
  type RuntimeProvider,
} from "../model-catalog";

const STORAGE_KEY = "machdoch.desktop.shell-state";
const APP_SHELL_STORAGE_KEY = "machdoch.desktop.app-shell-state";
const RALPH_SETTINGS_STORAGE_KEY = "machdoch.desktop.ralph-settings";
const ONBOARDING_STORAGE_KEY = "machdoch.desktop.onboarding-state";
const APPEARANCE_STORAGE_KEY = "machdoch.desktop.appearance-state";
const MCP_MARKETPLACE_STORAGE_KEY = "machdoch.desktop.mcp-marketplace-state";
const STORE_FILE = "machdoch-shell-state.json";
const SHELL_STATE_CHANGED_EVENT = "machdoch://shell-state-changed";
const APPEARANCE_SETTINGS_CHANGED_EVENT =
  "machdoch://appearance-settings-changed";

let sharedStore: LazyStore | null = null;

export interface ShellStateChangedPayload {
  originWindowLabel: string | null;
  updatedAt: number;
}

export interface AppearanceSettingsChangedPayload {
  originWindowLabel: string | null;
  updatedAt: number;
}

export interface OnboardingState {
  version: 1;
  completedAt?: number;
  skippedAt?: number;
}

export type MainAppId = "chat" | "ralph" | "marketplace";

export interface AppShellState {
  version: 1;
  activeApp: MainAppId;
  lastViewedAt: Record<MainAppId, number>;
}

export interface McpMarketplaceRegistrySourceState {
  id: string;
  title: string;
  baseUrl: string;
  enabled: boolean;
}

export interface McpMarketplaceState {
  version: 1;
  registries: McpMarketplaceRegistrySourceState[];
}

export interface RalphSettings {
  version: 1;
  workspaceRoot: string | null;
  flowLibraryMode: RalphFlowLibraryMode;
  generationProvider: RuntimeProvider;
  generationModel: string;
  generationProfile?: string;
  generationReasoning?: ReasoningMode;
  generationPromptHistory?: string[];
  runProvider: RuntimeProvider;
  runModel: string;
  runProfile?: string;
  runReasoning?: ReasoningMode;
  defaultMaxTransitions?: number;
}

export type RalphFlowLibraryMode = "workspace" | "user" | "all";

export type AppearanceTheme = "dark" | "light";
export type AppearanceDensity = "comfortable" | "compact";
export type AppearanceAccent = "sky" | "emerald" | "violet" | "amber";
export type QuickChatBubbleStyle = "classic" | "glass" | "pulse" | "orbit";

export interface AppearanceSettings {
  version: 1;
  theme: AppearanceTheme;
  density: AppearanceDensity;
  accent: AppearanceAccent;
  quickChatBubbleStyle: QuickChatBubbleStyle;
}

export const DEFAULT_APPEARANCE_SETTINGS = {
  version: 1,
  theme: "dark",
  density: "comfortable",
  accent: "sky",
  quickChatBubbleStyle: "classic",
} as const satisfies AppearanceSettings;

const DEFAULT_RALPH_PROVIDER = SUPPORTED_PROVIDER_ORDER[0] ?? "openai";

export const DEFAULT_APP_SHELL_STATE = {
  version: 1,
  activeApp: "chat",
  lastViewedAt: {
    chat: 0,
    ralph: 0,
    marketplace: 0,
  },
} as const satisfies AppShellState;

export const DEFAULT_MCP_MARKETPLACE_STATE = {
  version: 1,
  registries: [],
} as const satisfies McpMarketplaceState;

export const DEFAULT_RALPH_SETTINGS = {
  version: 1,
  workspaceRoot: null,
  flowLibraryMode: "workspace",
  generationProvider: DEFAULT_RALPH_PROVIDER,
  generationModel: getDefaultModelForProvider(DEFAULT_RALPH_PROVIDER),
  runProvider: DEFAULT_RALPH_PROVIDER,
  runModel: getDefaultModelForProvider(DEFAULT_RALPH_PROVIDER),
} as const satisfies RalphSettings;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isRuntimeProvider = (value: unknown): value is RuntimeProvider => {
  return SUPPORTED_PROVIDER_ORDER.includes(value as RuntimeProvider);
};

const isReasoningMode = (value: unknown): value is ReasoningMode => {
  return REASONING_MODES.includes(value as ReasoningMode);
};

const normalizeOptionalString = (value: unknown): string | undefined => {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const normalizeWorkspaceRoot = (value: unknown): string | null => {
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const normalizeStringHistory = (value: unknown, limit: number): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((entry) => {
      if (typeof entry !== "string") {
        return [];
      }

      const normalizedEntry = entry.trim();

      return normalizedEntry ? [normalizedEntry] : [];
    })
    .slice(-limit);
};

const normalizeMainAppId = (value: unknown): MainAppId => {
  if (value === "ralph" || value === "marketplace") {
    return value;
  }

  return "chat";
};

const normalizeAppShellState = (value: unknown): AppShellState => {
  if (!isRecord(value)) {
    return DEFAULT_APP_SHELL_STATE;
  }

  const lastViewedAt = isRecord(value.lastViewedAt)
    ? value.lastViewedAt
    : {};

  return {
    version: 1,
    activeApp: normalizeMainAppId(value.activeApp),
    lastViewedAt: {
      chat:
        typeof lastViewedAt.chat === "number"
          ? lastViewedAt.chat
          : DEFAULT_APP_SHELL_STATE.lastViewedAt.chat,
      ralph:
        typeof lastViewedAt.ralph === "number"
          ? lastViewedAt.ralph
          : DEFAULT_APP_SHELL_STATE.lastViewedAt.ralph,
      marketplace:
        typeof lastViewedAt.marketplace === "number"
          ? lastViewedAt.marketplace
          : DEFAULT_APP_SHELL_STATE.lastViewedAt.marketplace,
    },
  };
};

const normalizeMarketplaceRegistrySource = (
  value: unknown,
): McpMarketplaceRegistrySourceState | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = normalizeOptionalString(value.id);
  const title = normalizeOptionalString(value.title);
  const baseUrl = normalizeOptionalString(value.baseUrl);

  if (!id || !title || !baseUrl) {
    return undefined;
  }

  return {
    id,
    title,
    baseUrl,
    enabled: value.enabled !== false,
  };
};

const normalizeMcpMarketplaceState = (
  value: unknown,
): McpMarketplaceState => {
  if (!isRecord(value)) {
    return DEFAULT_MCP_MARKETPLACE_STATE;
  }

  const registries = Array.isArray(value.registries)
    ? value.registries.flatMap((entry) => {
        const normalized = normalizeMarketplaceRegistrySource(entry);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    version: 1,
    registries,
  };
};

const normalizeRalphProvider = (value: unknown): RuntimeProvider => {
  return isRuntimeProvider(value) ? value : DEFAULT_RALPH_PROVIDER;
};

const normalizeRalphModel = (
  value: unknown,
  provider: RuntimeProvider,
): string => {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : getDefaultModelForProvider(provider);
};

const normalizeRalphFlowLibraryMode = (
  value: unknown,
): RalphFlowLibraryMode => {
  return value === "user" || value === "all" || value === "workspace"
    ? value
    : DEFAULT_RALPH_SETTINGS.flowLibraryMode;
};

const normalizeRalphSettings = (value: unknown): RalphSettings => {
  if (!isRecord(value)) {
    return DEFAULT_RALPH_SETTINGS;
  }

  const generationProvider = normalizeRalphProvider(value.generationProvider);
  const runProvider = normalizeRalphProvider(value.runProvider);
  const defaultMaxTransitions =
    typeof value.defaultMaxTransitions === "number" &&
    Number.isFinite(value.defaultMaxTransitions) &&
    value.defaultMaxTransitions > 0
      ? Math.floor(value.defaultMaxTransitions)
      : undefined;

  return {
    version: 1,
    workspaceRoot: normalizeWorkspaceRoot(value.workspaceRoot),
    flowLibraryMode: normalizeRalphFlowLibraryMode(value.flowLibraryMode),
    generationProvider,
    generationModel: normalizeRalphModel(
      value.generationModel,
      generationProvider,
    ),
    ...(normalizeOptionalString(value.generationProfile)
      ? { generationProfile: normalizeOptionalString(value.generationProfile) }
      : {}),
    ...(isReasoningMode(value.generationReasoning)
      ? { generationReasoning: value.generationReasoning }
      : {}),
    generationPromptHistory: normalizeStringHistory(
      value.generationPromptHistory,
      40,
    ),
    runProvider,
    runModel: normalizeRalphModel(value.runModel, runProvider),
    ...(normalizeOptionalString(value.runProfile)
      ? { runProfile: normalizeOptionalString(value.runProfile) }
      : {}),
    ...(isReasoningMode(value.runReasoning)
      ? { runReasoning: value.runReasoning }
      : {}),
    ...(defaultMaxTransitions ? { defaultMaxTransitions } : {}),
  };
};

const normalizeAppearanceSettings = (value: unknown): AppearanceSettings => {
  if (!isRecord(value)) {
    return DEFAULT_APPEARANCE_SETTINGS;
  }

  const theme: AppearanceTheme =
    value.theme === "light" || value.theme === "dark"
      ? value.theme
      : DEFAULT_APPEARANCE_SETTINGS.theme;
  const density: AppearanceDensity =
    value.density === "compact" || value.density === "comfortable"
      ? value.density
      : DEFAULT_APPEARANCE_SETTINGS.density;
  const accent: AppearanceAccent =
    value.accent === "emerald" ||
    value.accent === "violet" ||
    value.accent === "amber" ||
    value.accent === "sky"
      ? value.accent
      : DEFAULT_APPEARANCE_SETTINGS.accent;
  const quickChatBubbleStyle: QuickChatBubbleStyle =
    value.quickChatBubbleStyle === "glass" ||
    value.quickChatBubbleStyle === "pulse" ||
    value.quickChatBubbleStyle === "orbit" ||
    value.quickChatBubbleStyle === "classic"
      ? value.quickChatBubbleStyle
      : DEFAULT_APPEARANCE_SETTINGS.quickChatBubbleStyle;

  return {
    version: 1,
    theme,
    density,
    accent,
    quickChatBubbleStyle,
  };
};

const getLocalStorage = (): Storage | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const canUseTauriStore = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  return isTauri() && "__TAURI_INTERNALS__" in window;
};

export const getCurrentShellWindowLabel = (): string | null => {
  if (!canUseTauriStore()) {
    return null;
  }

  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
};

const getStore = (): LazyStore => {
  sharedStore ??= new LazyStore(STORE_FILE);
  return sharedStore;
};

export const loadShellState = async <T>(fallback: T): Promise<T> => {
  if (canUseTauriStore()) {
    try {
      const value = await getStore().get<T>(STORAGE_KEY);

      if (value !== null && value !== undefined) {
        return value;
      }
    } catch (error) {
      console.error("Failed to load shell state from Tauri store", error);
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return fallback;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch (error) {
    console.error("Failed to load shell state from localStorage", error);
    return fallback;
  }
};

export const saveShellState = async <T>(state: T): Promise<void> => {
  if (canUseTauriStore()) {
    try {
      const store = getStore();
      await store.set(STORAGE_KEY, state);
      await store.save();
      return;
    } catch (error) {
      console.error("Failed to persist shell state to Tauri store", error);
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to persist shell state to localStorage", error);
  }
};

export const loadAppShellState = async (): Promise<AppShellState> => {
  if (canUseTauriStore()) {
    try {
      const value = await getStore().get<AppShellState>(APP_SHELL_STORAGE_KEY);

      if (value !== null && value !== undefined) {
        return normalizeAppShellState(value);
      }
    } catch (error) {
      console.error("Failed to load app shell state from Tauri store", error);
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return DEFAULT_APP_SHELL_STATE;
  }

  try {
    const raw = localStorage.getItem(APP_SHELL_STORAGE_KEY);
    return raw
      ? normalizeAppShellState(JSON.parse(raw))
      : DEFAULT_APP_SHELL_STATE;
  } catch (error) {
    console.error("Failed to load app shell state from localStorage", error);
    return DEFAULT_APP_SHELL_STATE;
  }
};

export const saveAppShellState = async (
  state: AppShellState,
): Promise<void> => {
  const normalizedState = normalizeAppShellState(state);

  if (canUseTauriStore()) {
    try {
      const store = getStore();
      await store.set(APP_SHELL_STORAGE_KEY, normalizedState);
      await store.save();
      return;
    } catch (error) {
      console.error("Failed to persist app shell state to Tauri store", error);
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return;
  }

  try {
    localStorage.setItem(APP_SHELL_STORAGE_KEY, JSON.stringify(normalizedState));
  } catch (error) {
    console.error("Failed to persist app shell state to localStorage", error);
  }
};

export const loadRalphSettings = async (): Promise<RalphSettings> => {
  if (canUseTauriStore()) {
    try {
      const value = await getStore().get<RalphSettings>(
        RALPH_SETTINGS_STORAGE_KEY,
      );

      if (value !== null && value !== undefined) {
        return normalizeRalphSettings(value);
      }
    } catch (error) {
      console.error("Failed to load Ralph settings from Tauri store", error);
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return DEFAULT_RALPH_SETTINGS;
  }

  try {
    const raw = localStorage.getItem(RALPH_SETTINGS_STORAGE_KEY);
    return raw ? normalizeRalphSettings(JSON.parse(raw)) : DEFAULT_RALPH_SETTINGS;
  } catch (error) {
    console.error("Failed to load Ralph settings from localStorage", error);
    return DEFAULT_RALPH_SETTINGS;
  }
};

export const saveRalphSettings = async (
  settings: RalphSettings,
): Promise<void> => {
  const normalizedSettings = normalizeRalphSettings(settings);

  if (canUseTauriStore()) {
    try {
      const store = getStore();
      await store.set(RALPH_SETTINGS_STORAGE_KEY, normalizedSettings);
      await store.save();
      return;
    } catch (error) {
      console.error("Failed to persist Ralph settings to Tauri store", error);
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return;
  }

  try {
    localStorage.setItem(
      RALPH_SETTINGS_STORAGE_KEY,
      JSON.stringify(normalizedSettings),
    );
  } catch (error) {
    console.error("Failed to persist Ralph settings to localStorage", error);
  }
};

export const loadOnboardingState =
  async (): Promise<OnboardingState | null> => {
    if (canUseTauriStore()) {
      try {
        const value = await getStore().get<OnboardingState>(
          ONBOARDING_STORAGE_KEY,
        );

        if (value !== null && value !== undefined) {
          return value;
        }
      } catch (error) {
        console.error("Failed to load onboarding state from Tauri store", error);
      }
    }

    const localStorage = getLocalStorage();

    if (!localStorage) {
      return null;
    }

    try {
      const raw = localStorage.getItem(ONBOARDING_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as OnboardingState) : null;
    } catch (error) {
      console.error("Failed to load onboarding state from localStorage", error);
      return null;
    }
  };

export const saveOnboardingState = async (
  state: OnboardingState,
): Promise<void> => {
  if (canUseTauriStore()) {
    try {
      const store = getStore();
      await store.set(ONBOARDING_STORAGE_KEY, state);
      await store.save();
      return;
    } catch (error) {
      console.error("Failed to persist onboarding state to Tauri store", error);
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return;
  }

  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.error("Failed to persist onboarding state to localStorage", error);
  }
};

export const loadAppearanceSettings =
  async (): Promise<AppearanceSettings> => {
    if (canUseTauriStore()) {
      try {
        const value = await getStore().get<AppearanceSettings>(
          APPEARANCE_STORAGE_KEY,
        );

        if (value !== null && value !== undefined) {
          return normalizeAppearanceSettings(value);
        }
      } catch (error) {
        console.error(
          "Failed to load appearance settings from Tauri store",
          error,
        );
      }
    }

    const localStorage = getLocalStorage();

    if (!localStorage) {
      return DEFAULT_APPEARANCE_SETTINGS;
    }

    try {
      const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
      return raw
        ? normalizeAppearanceSettings(JSON.parse(raw))
        : DEFAULT_APPEARANCE_SETTINGS;
    } catch (error) {
      console.error(
        "Failed to load appearance settings from localStorage",
        error,
      );
      return DEFAULT_APPEARANCE_SETTINGS;
    }
  };

export const saveAppearanceSettings = async (
  settings: AppearanceSettings,
): Promise<void> => {
  const normalizedSettings = normalizeAppearanceSettings(settings);

  if (canUseTauriStore()) {
    try {
      const store = getStore();
      await store.set(APPEARANCE_STORAGE_KEY, normalizedSettings);
      await store.save();
      await broadcastAppearanceSettingsChanged();
      return;
    } catch (error) {
      console.error(
        "Failed to persist appearance settings to Tauri store",
        error,
      );
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return;
  }

  try {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify(normalizedSettings),
    );
    await broadcastAppearanceSettingsChanged();
  } catch (error) {
    console.error(
      "Failed to persist appearance settings to localStorage",
      error,
    );
  }
};

export const loadMcpMarketplaceState =
  async (): Promise<McpMarketplaceState> => {
    if (canUseTauriStore()) {
      try {
        const value = await getStore().get<McpMarketplaceState>(
          MCP_MARKETPLACE_STORAGE_KEY,
        );

        if (value !== null && value !== undefined) {
          return normalizeMcpMarketplaceState(value);
        }
      } catch (error) {
        console.error(
          "Failed to load MCP marketplace state from Tauri store",
          error,
        );
      }
    }

    const localStorage = getLocalStorage();

    if (!localStorage) {
      return DEFAULT_MCP_MARKETPLACE_STATE;
    }

    try {
      const raw = localStorage.getItem(MCP_MARKETPLACE_STORAGE_KEY);
      return raw
        ? normalizeMcpMarketplaceState(JSON.parse(raw))
        : DEFAULT_MCP_MARKETPLACE_STATE;
    } catch (error) {
      console.error(
        "Failed to load MCP marketplace state from localStorage",
        error,
      );
      return DEFAULT_MCP_MARKETPLACE_STATE;
    }
  };

export const saveMcpMarketplaceState = async (
  state: McpMarketplaceState,
): Promise<void> => {
  const normalizedState = normalizeMcpMarketplaceState(state);

  if (canUseTauriStore()) {
    try {
      const store = getStore();
      await store.set(MCP_MARKETPLACE_STORAGE_KEY, normalizedState);
      await store.save();
      return;
    } catch (error) {
      console.error(
        "Failed to persist MCP marketplace state to Tauri store",
        error,
      );
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return;
  }

  try {
    localStorage.setItem(
      MCP_MARKETPLACE_STORAGE_KEY,
      JSON.stringify(normalizedState),
    );
  } catch (error) {
    console.error(
      "Failed to persist MCP marketplace state to localStorage",
      error,
    );
  }
};

export const broadcastShellStateChanged = async (): Promise<void> => {
  if (!canUseTauriStore()) {
    return;
  }

  try {
    await getCurrentWindow().emit(SHELL_STATE_CHANGED_EVENT, {
      originWindowLabel: getCurrentWindow().label,
      updatedAt: Date.now(),
    } satisfies ShellStateChangedPayload);
  } catch (error) {
    console.error("Failed to broadcast shell state update", error);
  }
};

export const broadcastAppearanceSettingsChanged = async (): Promise<void> => {
  if (!canUseTauriStore()) {
    return;
  }

  try {
    await getCurrentWindow().emit(APPEARANCE_SETTINGS_CHANGED_EVENT, {
      originWindowLabel: getCurrentWindow().label,
      updatedAt: Date.now(),
    } satisfies AppearanceSettingsChangedPayload);
  } catch (error) {
    console.error("Failed to broadcast appearance settings update", error);
  }
};

export const subscribeToShellStateChanged = async (
  onChange: (payload: ShellStateChangedPayload) => void,
): Promise<() => void> => {
  if (!canUseTauriStore()) {
    return () => {};
  }

  try {
    return await listen<ShellStateChangedPayload>(
      SHELL_STATE_CHANGED_EVENT,
      (event) => {
        onChange(event.payload);
      },
    );
  } catch (error) {
    console.error("Failed to subscribe to shell state updates", error);
    return () => {};
  }
};

export const subscribeToAppearanceSettingsChanged = async (
  onChange: (payload: AppearanceSettingsChangedPayload) => void,
): Promise<() => void> => {
  if (!canUseTauriStore()) {
    return () => {};
  }

  try {
    return await listen<AppearanceSettingsChangedPayload>(
      APPEARANCE_SETTINGS_CHANGED_EVENT,
      (event) => {
        onChange(event.payload);
      },
    );
  } catch (error) {
    console.error("Failed to subscribe to appearance settings updates", error);
    return () => {};
  }
};
