// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  createSession,
  getSessionTitle,
  type ShellPersistedState,
} from "../../chat-session.model";
import type { ProviderChooserState } from "./session-shell-view-model";
import { useSessionLifecycle } from "./use-session-lifecycle";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";

const providerChooserState = {
  activeProviderStats: [],
  runtimeProviderLookup: new Map(),
  configuredProviders: ["openai"],
  chooserProviders: ["openai"],
  hasAnyProvider: true,
} as ProviderChooserState;

const createStaleStateController = (
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
    applyShellState: vi.fn((updater) => {
      shellState =
        typeof updater === "function" ? updater(shellState) : updater;
    }),
    updateSessionById: vi.fn((sessionId, updater) => {
      shellState = {
        ...shellState,
        sessions: shellState.sessions.map((session) =>
          session.id === sessionId ? updater(session) : session,
        ),
      };
    }),
    setActiveSessionId: vi.fn(),
  } as Partial<ChatSessionShellStateController> as ChatSessionShellStateController;

  return {
    get shellState() {
      return shellState;
    },
    controller,
  };
};

describe("useSessionLifecycle", () => {
  it("coalesces repeated New actions into one blank reusable session", () => {
    const baseState = createInitialShellState();
    const existingSession = createSession({
      id: "existing-session",
      updatedAt: 100,
      messages: [
        {
          id: "existing-user-message",
          role: "user",
          content: "Existing work",
          createdAt: 100,
        },
      ],
    });
    const state = createStaleStateController({
      ...baseState,
      activeSessionId: existingSession.id,
      sessions: [existingSession],
    });
    const { result } = renderHook(() =>
      useSessionLifecycle({
        state: state.controller,
        providerChooserState,
      }),
    );

    act(() => {
      result.current.createNewSession();
      result.current.createNewSession();
    });

    expect(
      state.shellState.sessions.filter(
        (session) => getSessionTitle(session) === "New session",
      ),
    ).toHaveLength(1);
    expect(state.shellState.sessions).toHaveLength(2);
  });

  it("leaves empty sessions unchanged for archive, pin, and duplicate actions", () => {
    const baseState = createInitialShellState();
    const emptySession = createSession({
      id: "empty-action-session",
      updatedAt: 100,
    });
    const state = createStaleStateController({
      ...baseState,
      activeSessionId: emptySession.id,
      sessions: [emptySession],
    });
    const { result } = renderHook(() =>
      useSessionLifecycle({
        state: state.controller,
        providerChooserState,
      }),
    );

    act(() => {
      result.current.archiveSession(emptySession.id);
      result.current.togglePinnedSession(emptySession.id);
      result.current.cloneSession(emptySession.id, "duplicate");
    });

    expect(state.shellState.sessions).toHaveLength(1);
    expect(state.shellState.sessions[0]).toMatchObject({
      id: emptySession.id,
      updatedAt: emptySession.updatedAt,
    });
    expect(state.shellState.sessions[0]?.archivedAt).toBeUndefined();
    expect(state.shellState.sessions[0]?.pinnedAt).toBeUndefined();
    expect(state.controller.setActiveSessionId).not.toHaveBeenCalled();
  });
});
