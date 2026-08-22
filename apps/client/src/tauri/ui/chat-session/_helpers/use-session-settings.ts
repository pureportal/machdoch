import { useCallback } from "react";
import {
  isQuickVoiceSession,
  type ShellPersistedState,
} from "../../chat-session.model";
import type { SettingsSection } from "./session-shell";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";

type SessionBooleanSettingKey =
  | "sessionMemoryEnabled"
  | "useGlobalMemory"
  | "uiControlEnabled";

type RememberedSessionBooleanSettingKey = keyof Pick<
  ShellPersistedState,
  | "lastSelectedSessionMemoryEnabled"
  | "lastSelectedUseGlobalMemory"
  | "lastSelectedUiControlEnabled"
>;

const updateActiveSessionBooleanSetting = (
  state: ChatSessionShellStateController,
  key: SessionBooleanSettingKey,
  rememberedKey: RememberedSessionBooleanSettingKey,
  enabled: boolean,
): void => {
  const targetSessionId = state.activeSession.id;
  const allowHydrationFallback = !state.hasHydrated;

  state.applyShellState((prev) => {
    const targetSessionExists = prev.sessions.some(
      (session) => session.id === targetSessionId,
    );
    const fallbackSessionId = allowHydrationFallback ? prev.activeSessionId : null;
    const resolvedSessionId = targetSessionExists
      ? targetSessionId
      : fallbackSessionId &&
          prev.sessions.some((session) => session.id === fallbackSessionId)
        ? fallbackSessionId
        : null;

    if (!resolvedSessionId) {
      return prev;
    }

    const nextUpdatedAt = Date.now();
    let didUpdateSession = false;
    let shouldRememberDefault = false;
    const sessions = prev.sessions.map((session) => {
      if (session.id !== resolvedSessionId) {
        return session;
      }

      if (key === "sessionMemoryEnabled" && isQuickVoiceSession(session)) {
        return session;
      }

      didUpdateSession = true;
      shouldRememberDefault = !isQuickVoiceSession(session);

      return {
        ...session,
        [key]: enabled,
        updatedAt: nextUpdatedAt,
      };
    });

    if (!didUpdateSession) {
      return prev;
    }

    const nextState: ShellPersistedState = {
      ...prev,
      sessions,
    };

    if (shouldRememberDefault) {
      nextState[rememberedKey] = enabled;
    }

    return nextState;
  });
};

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
      updateActiveSessionBooleanSetting(
        state,
        "sessionMemoryEnabled",
        "lastSelectedSessionMemoryEnabled",
        enabled,
      );
    },
    [state],
  );

  const setUseGlobalMemory = useCallback(
    (enabled: boolean): void => {
      updateActiveSessionBooleanSetting(
        state,
        "useGlobalMemory",
        "lastSelectedUseGlobalMemory",
        enabled,
      );
    },
    [state],
  );

  const setUiControlEnabled = useCallback(
    (enabled: boolean): void => {
      updateActiveSessionBooleanSetting(
        state,
        "uiControlEnabled",
        "lastSelectedUiControlEnabled",
        enabled,
      );
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
