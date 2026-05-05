import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialShellState, createSession } from "../../chat-session.model";
import { useChatSessionShellState } from "./use-chat-session-shell-state";

const SHELL_STATE_STORAGE_KEY = "machdoch.desktop.shell-state";

const storeShellState = (value: unknown): void => {
  window.localStorage.setItem(SHELL_STATE_STORAGE_KEY, JSON.stringify(value));
};

const flushShellHydration = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const flushShellPersistence = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const loadStoredShellState = (): ReturnType<typeof createInitialShellState> => {
  const storedValue = window.localStorage.getItem(SHELL_STATE_STORAGE_KEY);

  expect(storedValue).not.toBeNull();

  return JSON.parse(storedValue as string) as ReturnType<
    typeof createInitialShellState
  >;
};

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  cleanup();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("useChatSessionShellState", () => {
  it("does not rewrite persisted state when a helper window only hydrates", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-stable",
      manualTitle: "Stable session",
      updatedAt: 1,
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    renderHook(() => useChatSessionShellState());
    await flushShellHydration();
    await flushShellPersistence();

    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it("keeps live draft edits local instead of persisting every keystroke", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-draft",
      manualTitle: "Draft session",
      updatedAt: 1,
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const { result } = renderHook(() => useChatSessionShellState());

    await flushShellHydration();

    act(() => {
      result.current.setDraftValue("This should stay local.");
    });

    expect(result.current.activeSession.draft).toBe("This should stay local.");
    await flushShellPersistence();

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(loadStoredShellState().sessions[0]?.draft).toBe("");
  });

  it("merges helper-window updates with newer archived session state", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-archive-race",
      manualTitle: "Archive race",
      updatedAt: 1,
    });
    const storedState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    };

    storeShellState(storedState);

    const { result } = renderHook(() => useChatSessionShellState());
    await flushShellHydration();

    storeShellState({
      ...storedState,
      sessions: [
        {
          ...session,
          archivedAt: 10,
        },
      ],
    });

    act(() => {
      result.current.applyShellState((prev) => ({
        ...prev,
        voice: {
          ...prev.voice,
          autoSpeakResponses: true,
        },
      }));
    });

    await waitFor(() => {
      const persisted = loadStoredShellState();

      expect(persisted.voice.autoSpeakResponses).toBe(true);
      expect(persisted.sessions[0]?.archivedAt).toBe(10);
    });
  });

  it("keeps newer session model selections when helper windows persist other session updates", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-model-race",
      manualTitle: "Model race",
      provider: "openai",
      model: "gpt-5.4",
      updatedAt: 1,
    });
    const storedState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    };

    storeShellState(storedState);

    const { result } = renderHook(() => useChatSessionShellState());
    await flushShellHydration();

    storeShellState({
      ...storedState,
      sessions: [
        {
          ...session,
          model: "gpt-5.5",
          updatedAt: 10,
        },
      ],
    });

    act(() => {
      result.current.updateSessionById(session.id, (currentSession) => ({
        ...currentSession,
        messages: [
          ...currentSession.messages,
          {
            id: "helper-message",
            role: "user",
            content: "Persisted from helper",
            createdAt: 20,
          },
        ],
        updatedAt: 20,
      }));
    });

    await waitFor(() => {
      const persisted = loadStoredShellState();

      expect(persisted.sessions[0]?.model).toBe("gpt-5.5");
      expect(persisted.sessions[0]?.messages).toHaveLength(1);
    });
  });

  it("keeps the window-local active session stable when persisted activeSessionId changes", async () => {
    const baseState = createInitialShellState();
    const firstSession = createSession({
      id: "session-first",
      manualTitle: "First session",
      updatedAt: 1,
    });
    const secondSession = createSession({
      id: "session-second",
      manualTitle: "Second session",
      updatedAt: 2,
    });

    storeShellState({
      ...baseState,
      activeSessionId: firstSession.id,
      sessions: [firstSession, secondSession],
    });

    const { result } = renderHook(() => useChatSessionShellState());
    await flushShellHydration();

    expect(result.current.activeSessionId).toBe(firstSession.id);

    act(() => {
      result.current.setActiveSessionId(secondSession.id);
    });

    expect(result.current.activeSessionId).toBe(secondSession.id);

    act(() => {
      result.current.applyShellState((prev) => ({
        ...prev,
        activeSessionId: firstSession.id,
      }));
    });

    expect(result.current.activeSessionId).toBe(secondSession.id);
    expect(result.current.activeSession.id).toBe(secondSession.id);
  });

  it("falls back when the window-local active session disappears from shared state", async () => {
    const baseState = createInitialShellState();
    const firstSession = createSession({
      id: "session-first",
      manualTitle: "First session",
      updatedAt: 1,
    });
    const secondSession = createSession({
      id: "session-second",
      manualTitle: "Second session",
      updatedAt: 2,
    });

    storeShellState({
      ...baseState,
      activeSessionId: firstSession.id,
      sessions: [firstSession, secondSession],
    });

    const { result } = renderHook(() => useChatSessionShellState());
    await flushShellHydration();

    act(() => {
      result.current.setActiveSessionId(secondSession.id);
    });

    expect(result.current.activeSessionId).toBe(secondSession.id);

    act(() => {
      result.current.applyShellState((prev) => ({
        ...prev,
        activeSessionId: firstSession.id,
        sessions: [firstSession],
      }));
    });

    expect(result.current.activeSessionId).toBe(firstSession.id);
    expect(result.current.activeSession.id).toBe(firstSession.id);
  });

  it("can follow the shared active session when isolation is disabled", async () => {
    const baseState = createInitialShellState();
    const firstSession = createSession({
      id: "session-first",
      manualTitle: "First session",
      updatedAt: 1,
    });
    const secondSession = createSession({
      id: "session-second",
      manualTitle: "Second session",
      updatedAt: 2,
    });

    storeShellState({
      ...baseState,
      activeSessionId: firstSession.id,
      sessions: [firstSession, secondSession],
    });

    const { result } = renderHook(() =>
      useChatSessionShellState({ isolateActiveSession: false }),
    );
    await flushShellHydration();

    expect(result.current.activeSessionId).toBe(firstSession.id);

    act(() => {
      result.current.applyShellState((prev) => ({
        ...prev,
        activeSessionId: secondSession.id,
      }));
    });

    expect(result.current.activeSessionId).toBe(secondSession.id);
    expect(result.current.activeSession.id).toBe(secondSession.id);
  });
});
