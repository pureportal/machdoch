// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  createSession,
  QUICK_VOICE_SESSION_KIND,
  type ShellPersistedState,
} from "../../chat-session.model";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";
import { useSessionSettingsActions } from "./use-session-settings";

const createSettingsStateController = (
  initialState: ShellPersistedState,
): {
  readonly shellState: ShellPersistedState;
  controller: ChatSessionShellStateController;
} => {
  let shellState = initialState;
  const activeSession = initialState.sessions.find(
    (session) => session.id === initialState.activeSessionId,
  );

  if (!activeSession) {
    throw new Error("Test state must have an active session.");
  }

  const controller = {
    shellState: initialState,
    activeSessionId: initialState.activeSessionId,
    activeSession,
    hasHydrated: true,
    applyShellState: vi.fn((updater) => {
      shellState =
        typeof updater === "function" ? updater(shellState) : updater;
    }),
  } as Partial<ChatSessionShellStateController> as ChatSessionShellStateController;

  return {
    get shellState() {
      return shellState;
    },
    controller,
  };
};

describe("useSessionSettingsActions", () => {
  it("remembers normal-session toggle selections for future new chats", () => {
    const session = createSession({
      id: "new-chat-settings-session",
      sessionMemoryEnabled: true,
      useGlobalMemory: true,
      uiControlEnabled: false,
    });
    const state = createSettingsStateController({
      ...createInitialShellState(),
      activeSessionId: session.id,
      sessions: [session],
    });
    const { result } = renderHook(() =>
      useSessionSettingsActions(state.controller),
    );

    act(() => {
      result.current.setSessionMemoryEnabled(false);
      result.current.setUseGlobalMemory(false);
      result.current.setUiControlEnabled(true);
    });

    const updatedSession = state.shellState.sessions[0];

    expect(updatedSession).toMatchObject({
      id: session.id,
      sessionMemoryEnabled: false,
      useGlobalMemory: false,
      uiControlEnabled: true,
    });
    expect(state.shellState.lastSelectedSessionMemoryEnabled).toBe(false);
    expect(state.shellState.lastSelectedUseGlobalMemory).toBe(false);
    expect(state.shellState.lastSelectedUiControlEnabled).toBe(true);
  });

  it("keeps Quick Chat toggle changes out of normal new-chat defaults", () => {
    const quickSession = createSession({
      id: "quick-chat-settings-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
      useGlobalMemory: true,
      uiControlEnabled: false,
    });
    const state = createSettingsStateController({
      ...createInitialShellState(),
      activeSessionId: quickSession.id,
      sessions: [quickSession],
      lastSelectedSessionMemoryEnabled: true,
      lastSelectedUseGlobalMemory: true,
      lastSelectedUiControlEnabled: false,
    });
    const { result } = renderHook(() =>
      useSessionSettingsActions(state.controller),
    );

    act(() => {
      result.current.setSessionMemoryEnabled(true);
      result.current.setUseGlobalMemory(false);
      result.current.setUiControlEnabled(true);
    });

    const updatedSession = state.shellState.sessions[0];

    expect(updatedSession).toMatchObject({
      id: quickSession.id,
      sessionMemoryEnabled: false,
      useGlobalMemory: false,
      uiControlEnabled: true,
    });
    expect(state.shellState.lastSelectedSessionMemoryEnabled).toBe(true);
    expect(state.shellState.lastSelectedUseGlobalMemory).toBe(true);
    expect(state.shellState.lastSelectedUiControlEnabled).toBe(false);
  });
});
