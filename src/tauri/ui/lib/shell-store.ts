import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";

const STORAGE_KEY = "machdoch.desktop.shell-state";
const ONBOARDING_STORAGE_KEY = "machdoch.desktop.onboarding-state";
const APPEARANCE_STORAGE_KEY = "machdoch.desktop.appearance-state";
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

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
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
