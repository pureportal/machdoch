import { isTauri } from "@tauri-apps/api/core";
import { LazyStore } from "@tauri-apps/plugin-store";

const STORAGE_KEY = "machdoch.desktop.shell-state";
const STORE_FILE = "machdoch-shell-state.json";

let sharedStore: LazyStore | null = null;

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