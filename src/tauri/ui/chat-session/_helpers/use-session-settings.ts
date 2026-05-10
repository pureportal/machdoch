import { useCallback } from "react";
import type { SettingsSection } from "./session-shell";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";

export const useSessionSettingsActions = (
  state: ChatSessionShellStateController,
) => {
  const openSettings = useCallback(
    (section: SettingsSection = "providers"): void => {
      state.setSettingsSection(section);
      state.setCatalogOpen(true);
    },
    [state],
  );

  const setSessionMemoryEnabled = useCallback(
    (enabled: boolean): void => {
      state.updateActiveSession((session) => ({
        ...session,
        sessionMemoryEnabled: enabled,
        updatedAt: Date.now(),
      }));
    },
    [state],
  );

  const setUseGlobalMemory = useCallback(
    (enabled: boolean): void => {
      state.updateActiveSession((session) => ({
        ...session,
        useGlobalMemory: enabled,
        updatedAt: Date.now(),
      }));
    },
    [state],
  );

  const setUiControlEnabled = useCallback(
    (enabled: boolean): void => {
      state.updateActiveSession((session) => ({
        ...session,
        uiControlEnabled: enabled,
        updatedAt: Date.now(),
      }));
    },
    [state],
  );

  return {
    openSettings,
    setSessionMemoryEnabled,
    setUseGlobalMemory,
    setUiControlEnabled,
  };
};
