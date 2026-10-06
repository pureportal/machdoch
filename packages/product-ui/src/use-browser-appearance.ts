import { useCallback, useEffect, useState } from "react";
import {
  applyAppearanceSettings,
  DEFAULT_APPEARANCE_SETTINGS,
  normalizeAppearanceSettings,
  type AppearanceSettings,
} from "./appearance";

const storageKey = "machdoch.desktop.appearance-state";
const changeEvent = "machdoch:browser-appearance-changed";

export function useBrowserAppearance(): {
  settings: AppearanceSettings;
  error: string | null;
  save: (settings: AppearanceSettings) => void;
} {
  const [settings, setSettings] = useState(DEFAULT_APPEARANCE_SETTINGS);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = (): void => {
      try {
        const stored = window.localStorage.getItem(storageKey);
        const next = normalizeAppearanceSettings(
          stored ? JSON.parse(stored) : null,
        );
        applyAppearanceSettings(next);
        setSettings(next);
        setError(null);
      } catch (cause) {
        console.error("Appearance could not be loaded", cause);
        setError("Appearance could not be loaded. Reload to try again.");
      }
    };
    const receive = (event: StorageEvent): void => {
      if (event.key === storageKey || event.key === null) load();
    };
    load();
    window.addEventListener("storage", receive);
    window.addEventListener(changeEvent, load);
    return () => {
      window.removeEventListener("storage", receive);
      window.removeEventListener(changeEvent, load);
    };
  }, []);
  const save = useCallback((next: AppearanceSettings): void => {
    try {
      const normalized = normalizeAppearanceSettings(next);
      window.localStorage.setItem(storageKey, JSON.stringify(normalized));
      applyAppearanceSettings(normalized);
      setSettings(normalized);
      setError(null);
      window.dispatchEvent(new Event(changeEvent));
    } catch (cause) {
      console.error("Appearance could not be saved", cause);
      setError("Appearance could not be saved. Try again.");
    }
  }, []);
  return { settings, error, save };
}
