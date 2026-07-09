import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  createSession,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import { createMockExecutionFixture } from "../../preview/fixtures";
import * as runtime from "../../runtime";
import { useSessionTaskSubmission } from "./use-session-task-submission";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";

const createStateController = (
  initialState: ShellPersistedState,
): ChatSessionShellStateController => {
  const controller = {
    shellState: initialState,
    activeSessionId: initialState.activeSessionId,
    activeSession: initialState.sessions[0]!,
    sessionScopeFilter: "open",
    setSessionScopeFilter: vi.fn(),
    setActiveSessionId: vi.fn(),
    setDraftValue: vi.fn(),
    setPromptHistoryIndex: vi.fn(),
    setDraftBeforeHistory: vi.fn(),
    applyShellState: vi.fn((
      updater: Parameters<ChatSessionShellStateController["applyShellState"]>[0],
    ) => {
      const nextState =
        typeof updater === "function" ? updater(controller.shellState) : updater;

      controller.shellState = nextState;
      controller.activeSession =
        nextState.sessions.find(
          (session) => session.id === controller.activeSessionId,
        ) ??
        nextState.sessions[0] ??
        controller.activeSession;
    }),
  } as Partial<ChatSessionShellStateController> as ChatSessionShellStateController;

  return controller;
};

describe("useSessionTaskSubmission", () => {
  it("uses the latest shell session when the caller snapshot is stale", () => {
    const task = "Run the queued follow-up";
    const taskId = "stale-running-task";
    const runningSession = createSession({
      id: "stale-submit-session",
      updatedAt: 100,
      messages: [
        {
          id: "stale-running-user",
          taskId,
          role: "user",
          content: "Original running task",
          createdAt: 100,
        },
      ],
    });
    const settledSession = {
      ...runningSession,
      updatedAt: 200,
      messages: [
        ...runningSession.messages,
        {
          id: "stale-running-agent",
          taskId,
          role: "agent" as const,
          content: "Original task finished.",
          createdAt: 200,
          source: {
            kind: "execution" as const,
            execution: createMockExecutionFixture(
              "Original running task",
              "C:\\Project",
            ),
          },
        },
      ],
    };
    const baseState = createInitialShellState();
    const state = createStateController({
      ...baseState,
      activeSessionId: settledSession.id,
      sessions: [settledSession],
    });
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockImplementation(
        () => new Promise<runtime.DesktopTaskRunResponse>(() => {}),
      );

    const { result } = renderHook(() =>
      useSessionTaskSubmission({
        state,
        runtime: {
          applyLoadedUserMemorySettings: vi.fn(),
          refreshWorkspaceRuntimeSnapshot: vi.fn(),
          runtimeSnapshot: null,
          userMemorySettings: {
            globalEnabled: true,
            entries: [],
          },
        },
        voice: {
          stopSpeaking: vi.fn(),
        },
        uiControlAvailability: undefined,
        aiContextMessageLimit: 60,
        activeDesktopTasksRef: {
          current: new Map(),
        },
        ignoredDesktopTaskIdsRef: {
          current: new Set(),
        },
        progressHandlersRef: {
          current: new Map(),
        },
        applySessionMessageLimit: (session: ChatSessionRecord) => session,
        updateThinkingTrace: vi.fn(),
      }),
    );

    expect(
      result.current.submitTaskToSession({
        sessionSnapshot: runningSession,
        task,
        contextAttachments: [],
        clearDraft: false,
        activateSession: true,
      }),
    ).toBe(true);
    expect(runDesktopTaskSpy).toHaveBeenCalledTimes(1);
    expect(
      state.shellState.sessions[0]?.messages.some(
        (message) => message.role === "user" && message.content === task,
      ),
    ).toBe(true);

    runDesktopTaskSpy.mockRestore();
  });
});
