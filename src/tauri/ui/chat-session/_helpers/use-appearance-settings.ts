import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  getCurrentShellWindowLabel,
  loadAppearanceSettings,
  saveAppearanceSettings,
  subscribeToAppearanceSettingsChanged,
  type AppearanceSettings,
} from "../../lib/shell-store";

const applyAppearanceSettings = (settings: AppearanceSettings): void => {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.density = settings.density;
  root.dataset.accent = settings.accent;
  root.dataset.quickChatBubbleStyle = settings.quickChatBubbleStyle;
  root.classList.toggle("dark", settings.theme === "dark");
  root.style.colorScheme = settings.theme;
};

export interface AppearanceSettingsController {
  settings: AppearanceSettings;
  saving: boolean;
  onSave: (settings: AppearanceSettings) => Promise<void>;
}

export const useAppearanceSettings = (): AppearanceSettingsController => {
  const [settings, setSettings] = useState<AppearanceSettings>(
    DEFAULT_APPEARANCE_SETTINGS,
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;

    applyAppearanceSettings(DEFAULT_APPEARANCE_SETTINGS);

    void loadAppearanceSettings().then((loadedSettings) => {
      if (cancelled) {
        return;
      }

      setSettings(loadedSettings);
      applyAppearanceSettings(loadedSettings);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToAppearanceSettingsChanged((payload) => {
      if (payload.originWindowLabel === getCurrentShellWindowLabel()) {
        return;
      }

      void loadAppearanceSettings().then((loadedSettings) => {
        if (disposed) {
          return;
        }

        setSettings(loadedSettings);
        applyAppearanceSettings(loadedSettings);
      });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }

      unsubscribe = unlisten;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const onSave = useCallback(async (nextSettings: AppearanceSettings) => {
    setSettings(nextSettings);
    applyAppearanceSettings(nextSettings);
    setSaving(true);

    try {
      await saveAppearanceSettings(nextSettings);
    } finally {
      setSaving(false);
    }
  }, []);

  return {
    settings,
    saving,
    onSave,
  };
};
