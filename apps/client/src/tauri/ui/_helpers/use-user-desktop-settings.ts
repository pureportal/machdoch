import { useEffect, useState } from "react";
import {
  loadUserDesktopSettings,
  subscribeToDesktopSettingsChanged,
  type UserDesktopSettings,
} from "../runtime";

const FALLBACK_USER_DESKTOP_SETTINGS: UserDesktopSettings = {
  autostartEnabled: false,
  autostartMinimized: false,
  autostartToTray: false,
  alwaysRunAsAdministrator: false,
  assistantBubbleEnabled: true,
  assistantBubbleHideWhenFullscreen: true,
  assistantBubbleTemporarilyHideSeconds: 6,
  aiContextMaxMessages: 60,
  inactiveSessionArchiveDays: 7,
  archivedSessionRetentionDays: 7,
  quickVoiceEnabled: true,
  quickVoiceShortcut: "CommandOrControl+Alt+V",
  quickVoiceSilenceSeconds: 1.8,
  quickVoiceMaxMessages: 50,
};

export const useUserDesktopSettings = (): UserDesktopSettings => {
  const [settings, setSettings] = useState<UserDesktopSettings>(
    FALLBACK_USER_DESKTOP_SETTINGS,
  );

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let updateRevision = 0;
    const loadRevision = updateRevision;

    void loadUserDesktopSettings()
      .then((loadedSettings) => {
        if (!disposed && updateRevision === loadRevision) {
          setSettings({
            ...FALLBACK_USER_DESKTOP_SETTINGS,
            ...loadedSettings,
          });
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.error("Failed to load user desktop settings", error);
        }
      });

    void subscribeToDesktopSettingsChanged((nextSettings) => {
      if (disposed) {
        return;
      }

      updateRevision += 1;
      setSettings({
        ...FALLBACK_USER_DESKTOP_SETTINGS,
        ...nextSettings,
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

  return settings;
};
