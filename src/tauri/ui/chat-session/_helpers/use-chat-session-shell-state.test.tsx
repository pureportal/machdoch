import { act, cleanup, renderHook } from "@testing-library/react";
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