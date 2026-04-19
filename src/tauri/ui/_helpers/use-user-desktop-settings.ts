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
  assistantBubbleEnabled: true,
  assistantBubbleHideWhenFullscreen: true,
  assistantBubbleTemporarilyHideSeconds: 6,
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

    void loadUserDesktopSettings().then((loadedSettings) => {
      if (!disposed) {
        setSettings(loadedSettings);
      }
    });

    void subscribeToDesktopSettingsChanged((nextSettings) => {
      setSettings(nextSettings);
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
