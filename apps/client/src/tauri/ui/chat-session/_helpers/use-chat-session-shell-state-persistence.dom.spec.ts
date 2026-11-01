// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  createSession,
  hasUnreadCompletedSessionResponse,
  normalizeShellState,
} from "../../chat-session.model";
import { useChatSessionShellState } from "./use-chat-session-shell-state";

const snapshotKey = "machdoch.desktop.shell-state-snapshot";
const revisionKey = "machdoch.desktop.shell-state-revision";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("saves a draft without rereading an unchanged browser snapshot", async () => {
  const initial = normalizeShellState({
    ...createInitialShellState(),
    sessions: [
      createSession({ id: "first-session" }),
      createSession({ id: "second-session" }),
    ],
    activeSessionId: "first-session",
  });
  localStorage.setItem(
    snapshotKey,
    JSON.stringify({ state: initial, revision: 1 }),
  );
  localStorage.setItem(revisionKey, "1");

  const { result } = renderHook(() => useChatSessionShellState());
  await waitFor(() => expect(result.current.hasHydrated).toBe(true));
  const getItem = vi.spyOn(Storage.prototype, "getItem");

  act(() => result.current.setDraftValue("Draft text"));
  await act(async () => result.current.flushPersistence());

  expect(
    getItem.mock.calls.filter(([key]) => key === snapshotKey),
  ).toHaveLength(1);
  expect(
    JSON.parse(localStorage.getItem(snapshotKey) ?? "null").state.sessions.find(
      (session: { id: string }) => session.id === "first-session",
    )?.draft,
  ).toBe("Draft text");

  act(() => result.current.setActiveSessionId("second-session"));
  expect(result.current.activeSession.id).toBe("second-session");
  act(() => result.current.setActiveSessionId("first-session"));
  expect(result.current.activeSession.draft).toBe("Draft text");
});

it("clears the unread reply of a session left through remote control", async () => {
  const finished = createSession({
    id: "finished-session",
    createdAt: 100,
    updatedAt: 200,
    lastReadAt: 150,
    messages: [
      {
        id: "request",
        taskId: "task",
        role: "user",
        content: "Request",
        createdAt: 100,
      },
      {
        id: "reply",
        taskId: "task",
        role: "agent",
        content: "Reply",
        createdAt: 200,
        outcome: { status: "succeeded" },
      },
    ],
  });
  const initial = normalizeShellState({
    ...createInitialShellState(),
    sessions: [createSession({ id: "open-session" }), finished],
    activeSessionId: "open-session",
  });
  localStorage.setItem(
    snapshotKey,
    JSON.stringify({ state: initial, revision: 1 }),
  );
  localStorage.setItem(revisionKey, "1");

  const { result } = renderHook(() => useChatSessionShellState());
  await waitFor(() => expect(result.current.hasHydrated).toBe(true));
  const readFinished = () =>
    result.current.shellState.sessions.find(
      (session) => session.id === "finished-session",
    )!;
  expect(hasUnreadCompletedSessionResponse(readFinished())).toBe(true);

  act(() => result.current.markSessionAsRead("finished-session"));

  expect(hasUnreadCompletedSessionResponse(readFinished())).toBe(false);
  expect(result.current.activeSession.id).toBe("open-session");
});

it.each([true, false])(
  "merges an external browser revision with local input when the revision key is %s",
  async (revisionKeyUpdated) => {
    const initial = normalizeShellState(createInitialShellState());
    localStorage.setItem(
      snapshotKey,
      JSON.stringify({ state: initial, revision: 1 }),
    );
    localStorage.setItem(revisionKey, "1");

    const { result } = renderHook(() => useChatSessionShellState());
    await waitFor(() => expect(result.current.hasHydrated).toBe(true));

    localStorage.setItem(
      snapshotKey,
      JSON.stringify({
        state: { ...initial, recentWorkspaces: ["remote-workspace"] },
        revision: 2,
      }),
    );
    if (revisionKeyUpdated) {
      localStorage.setItem(revisionKey, "2");
    }

    act(() => result.current.setDraftValue("Local input"));
    await act(async () => result.current.flushPersistence());

    const persisted = JSON.parse(localStorage.getItem(snapshotKey) ?? "null");
    expect(persisted.state.sessions[0].draft).toBe("Local input");
    expect(persisted.state.recentWorkspaces).toEqual(["remote-workspace"]);
  },
);
