import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LazyStore } from "@tauri-apps/plugin-store";

const STORE_FILE = "machdoch-shell-state.json";
const SHELL_STATE_CHANGED_EVENT = "machdoch://shell-state-changed";
const APPEARANCE_SETTINGS_CHANGED_EVENT =
  "machdoch://appearance-settings-changed";
const BROWSER_SHELL_STATE_CHANNEL = "machdoch:shell-state-changed";
const BROWSER_APPEARANCE_CHANNEL = "machdoch:appearance-settings-changed";
const BROWSER_SHELL_SNAPSHOT_STORAGE_KEY =
  "machdoch.desktop.shell-state-snapshot";
const APPEARANCE_STORAGE_KEY = "machdoch.desktop.appearance-state";
const browserWindowOrigin =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? `browser:${crypto.randomUUID()}`
    : `browser:${Date.now()}:${Math.random()}`;

let sharedStore: LazyStore | null = null;

type StoredValueNormalizer<T> = (value: unknown) => T;
type LocalStorageParser = (raw: string) => unknown;

interface LoadStoredValueOptions<T> {
  storageKey: string;
  fallback: T;
  tauriErrorMessage: string;
  localStorageErrorMessage: string;
  normalize?: StoredValueNormalizer<T>;
  parseLocalStorage?: LocalStorageParser;
}

interface SaveStoredValueOptions {
  storageKey: string;
  value: unknown;
  tauriErrorMessage: string;
  localStorageErrorMessage: string;
  serializeLocalStorage?: (value: unknown) => string;
}

export interface ShellStateChangedPayload {
  originWindowLabel: string | null;
  updatedAt: number;
}

export interface AppearanceSettingsChangedPayload {
  originWindowLabel: string | null;
  updatedAt: number;
}

export const getLocalStorage = (): Storage | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const canUseTauriStore = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }

  return isTauri() && "__TAURI_INTERNALS__" in window;
};

export const getCurrentShellWindowLabel = (): string | null => {
  if (!canUseTauriStore()) {
    return typeof window === "undefined" ? null : browserWindowOrigin;
  }

  try {
    return getCurrentWindow().label;
  } catch {
    return null;
  }
};

export const getStore = (): LazyStore => {
  sharedStore ??= new LazyStore(STORE_FILE);
  return sharedStore;
};

export const loadStoredValue = async <T>({
  storageKey,
  fallback,
  tauriErrorMessage,
  localStorageErrorMessage,
  normalize = (value) => value as T,
  parseLocalStorage = JSON.parse,
}: LoadStoredValueOptions<T>): Promise<T> => {
  if (canUseTauriStore()) {
    try {
      const value = await getStore().get<unknown>(storageKey);

      if (value !== null && value !== undefined) {
        return normalize(value);
      }
      return fallback;
    } catch (error) {
      console.error(tauriErrorMessage, error);
      throw error instanceof Error ? error : new Error(tauriErrorMessage);
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return fallback;
  }

  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? normalize(parseLocalStorage(raw)) : fallback;
  } catch (error) {
    console.error(localStorageErrorMessage, error);
    return fallback;
  }
};

export const saveStoredValue = async ({
  storageKey,
  value,
  tauriErrorMessage,
  localStorageErrorMessage,
  serializeLocalStorage = JSON.stringify,
}: SaveStoredValueOptions): Promise<boolean> => {
  if (canUseTauriStore()) {
    try {
      const store = getStore();
      await store.set(storageKey, value);
      await store.save();
      return true;
    } catch (error) {
      console.error(tauriErrorMessage, error);
      return false;
    }
  }

  const localStorage = getLocalStorage();

  if (!localStorage) {
    return false;
  }

  try {
    localStorage.setItem(storageKey, serializeLocalStorage(value));
    return true;
  } catch (error) {
    console.error(localStorageErrorMessage, error);
    return false;
  }
};

export const broadcastShellStateChanged = async (): Promise<void> => {
  if (!canUseTauriStore()) {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(BROWSER_SHELL_STATE_CHANNEL);
      channel.postMessage({
        originWindowLabel: browserWindowOrigin,
        updatedAt: Date.now(),
      } satisfies ShellStateChangedPayload);
      channel.close();
    }
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
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(BROWSER_APPEARANCE_CHANNEL);
      channel.postMessage({
        originWindowLabel: browserWindowOrigin,
        updatedAt: Date.now(),
      } satisfies AppearanceSettingsChangedPayload);
      channel.close();
    }
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
    if (typeof window === "undefined") {
      return () => {};
    }

    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(BROWSER_SHELL_STATE_CHANNEL);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const payload = event.data as Partial<ShellStateChangedPayload>;
        if (typeof payload.updatedAt === "number") {
          onChange({
            originWindowLabel:
              typeof payload.originWindowLabel === "string"
                ? payload.originWindowLabel
                : null,
            updatedAt: payload.updatedAt,
          });
        }
      };
      return () => channel.close();
    }

    const onStorage = (event: StorageEvent): void => {
      if (event.key === BROWSER_SHELL_SNAPSHOT_STORAGE_KEY) {
        onChange({ originWindowLabel: null, updatedAt: Date.now() });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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
    if (typeof window === "undefined") {
      return () => {};
    }

    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(BROWSER_APPEARANCE_CHANNEL);
      channel.onmessage = (event: MessageEvent<unknown>) => {
        const payload = event.data as Partial<AppearanceSettingsChangedPayload>;
        if (typeof payload.updatedAt === "number") {
          onChange({
            originWindowLabel:
              typeof payload.originWindowLabel === "string"
                ? payload.originWindowLabel
                : null,
            updatedAt: payload.updatedAt,
          });
        }
      };
      return () => channel.close();
    }

    const onStorage = (event: StorageEvent): void => {
      if (event.key === APPEARANCE_STORAGE_KEY) {
        onChange({ originWindowLabel: null, updatedAt: Date.now() });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
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
