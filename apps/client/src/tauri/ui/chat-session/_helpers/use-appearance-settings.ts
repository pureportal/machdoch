import { useCallback, useEffect, useRef, useState } from "react";
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
  const didMutateRef = useRef(false);
  const settingsRef = useRef(settings);
  const mutationRevisionRef = useRef(0);
  const pendingSaveCountRef = useRef(0);
  const externalReloadPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const loadSequenceRef = useRef(0);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  settingsRef.current = settings;

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;

    const loadSequence = loadSequenceRef.current + 1;
    loadSequenceRef.current = loadSequence;

    void loadAppearanceSettings()
      .then((loadedSettings) => {
        if (
          cancelled ||
          didMutateRef.current ||
          loadSequence !== loadSequenceRef.current
        ) {
          return;
        }

        settingsRef.current = loadedSettings;
        setSettings(loadedSettings);
        applyAppearanceSettings(loadedSettings);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error("Failed to load appearance settings", error);
        }
      });

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    void subscribeToAppearanceSettingsChanged((payload) => {
      if (payload.originWindowLabel === getCurrentShellWindowLabel()) {
        return;
      }

      if (pendingSaveCountRef.current > 0) {
        externalReloadPendingRef.current = true;
        return;
      }

      const loadSequence = loadSequenceRef.current + 1;
      loadSequenceRef.current = loadSequence;

      void loadAppearanceSettings()
        .then((loadedSettings) => {
          if (
            disposed ||
            pendingSaveCountRef.current > 0 ||
            loadSequence !== loadSequenceRef.current
          ) {
            return;
          }

          settingsRef.current = loadedSettings;
          setSettings(loadedSettings);
          applyAppearanceSettings(loadedSettings);
        })
        .catch((error: unknown) => {
          if (!disposed) {
            console.error("Failed to reload appearance settings", error);
          }
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
    const baseSettings = settingsRef.current;
    const mutationRevision = mutationRevisionRef.current + 1;
    mutationRevisionRef.current = mutationRevision;
    didMutateRef.current = true;
    loadSequenceRef.current += 1;
    settingsRef.current = nextSettings;
    setSettings(nextSettings);
    applyAppearanceSettings(nextSettings);
    pendingSaveCountRef.current += 1;
    setSaving(true);

    let persistedSettings = nextSettings;
    const save = saveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        persistedSettings = await saveAppearanceSettings(
          nextSettings,
          baseSettings,
        );
      });
    saveChainRef.current = save;

    try {
      await save;
      if (
        mountedRef.current &&
        mutationRevisionRef.current === mutationRevision
      ) {
        settingsRef.current = persistedSettings;
        setSettings(persistedSettings);
        applyAppearanceSettings(persistedSettings);
      }
    } catch (error) {
      if (
        mountedRef.current &&
        mutationRevisionRef.current === mutationRevision
      ) {
        settingsRef.current = baseSettings;
        setSettings(baseSettings);
        applyAppearanceSettings(baseSettings);
      }
      throw error;
    } finally {
      pendingSaveCountRef.current = Math.max(
        0,
        pendingSaveCountRef.current - 1,
      );
      if (mountedRef.current) {
        setSaving(pendingSaveCountRef.current > 0);
      }

      if (
        mountedRef.current &&
        pendingSaveCountRef.current === 0 &&
        externalReloadPendingRef.current
      ) {
        externalReloadPendingRef.current = false;
        try {
          const loadedSettings = await loadAppearanceSettings();
          settingsRef.current = loadedSettings;
          setSettings(loadedSettings);
          applyAppearanceSettings(loadedSettings);
        } catch (error) {
          console.error("Failed to apply queued appearance update", error);
        }
      }
    }
  }, []);

  return {
    settings,
    saving,
    onSave,
  };
};
