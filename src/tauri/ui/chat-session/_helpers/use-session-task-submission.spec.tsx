import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  createInitialShellState,
  createSession,
  createVisibleConversationMessages,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import { createMockExecutionFixture } from "../../preview/fixtures";
import * as runtime from "../../runtime";
import { appendThinkingProgress } from "../../task-thinking.model";
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

  controller.updateSessionById = vi.fn((sessionId, updater) => {
    controller.applyShellState((currentState) => ({
      ...currentState,
      sessions: currentState.sessions.map((session) =>
        session.id === sessionId ? updater(session) : session,
      ),
    }));
  });

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

  it("preserves composer and session changes made after the submitted snapshot", () => {
    const staleAttachment = {
      id: "stale-attachment",
      path: "C:\\Project\\stale.md",
      kind: "file" as const,
      name: "stale.md",
      parent: "C:\\Project",
    };
    const currentAttachment = {
      id: "current-attachment",
      path: "C:\\Project\\current.md",
      kind: "file" as const,
      name: "current.md",
      parent: "C:\\Project",
    };
    const staleSession = createSession({
      id: "composer-race-session",
      draft: "Original request",
      draftContextAttachments: [staleAttachment],
      composerUpdatedAt: 100,
      provider: "openai",
      model: "gpt-5.5",
      manualTitle: "Old title",
      updatedAt: 100,
    });
    const currentSession: ChatSessionRecord = {
      ...staleSession,
      draft: "A new request typed while preparing",
      draftContextAttachments: [currentAttachment],
      composerUpdatedAt: 200,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      manualTitle: "Current title",
      updatedAt: 200,
    };
    const baseState = createInitialShellState();
    const state = createStateController({
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [currentSession],
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
          userMemorySettings: { globalEnabled: true, entries: [] },
        },
        voice: { stopSpeaking: vi.fn() },
        uiControlAvailability: undefined,
        aiContextMessageLimit: 60,
        activeDesktopTasksRef: { current: new Map() },
        ignoredDesktopTaskIdsRef: { current: new Set() },
        progressHandlersRef: { current: new Map() },
        applySessionMessageLimit: (session: ChatSessionRecord) => session,
        updateThinkingTrace: vi.fn(),
      }),
    );

    expect(
      result.current.submitTaskToSession({
        sessionSnapshot: staleSession,
        task: "Original request",
        contextAttachments: [staleAttachment],
        clearDraft: true,
        composerClearGuard: {
          draft: staleSession.draft,
          contextAttachments: staleSession.draftContextAttachments,
          composerUpdatedAt: staleSession.composerUpdatedAt,
        },
        activateSession: true,
      }),
    ).toBe(true);

    const updatedSession = state.shellState.sessions[0];

    expect(updatedSession).toMatchObject({
      draft: currentSession.draft,
      draftContextAttachments: [currentAttachment],
      provider: currentSession.provider,
      model: currentSession.model,
      manualTitle: currentSession.manualTitle,
    });
    const submittedUserMessage = updatedSession?.messages.find(
      (message) => message.role === "user" && message.content === "Original request",
    );
    const thinkingMessage = updatedSession?.messages.find(
      (message) => message.source?.kind === "thinking",
    );

    expect(submittedUserMessage?.id).toBe(`${submittedUserMessage?.taskId}-user`);
    expect(thinkingMessage?.id).toBe(`${thinkingMessage?.taskId}-thinking`);
    expect(runDesktopTaskSpy).toHaveBeenCalledWith(
      currentSession.workspace,
      expect.any(String),
      expect.objectContaining({
        provider: currentSession.provider,
        model: currentSession.model,
      }),
    );

    runDesktopTaskSpy.mockRestore();
  });

  it("does not resurrect a session that was deleted before async submission resumes", () => {
    const deletedSession = createSession({
      id: "deleted-before-submit",
      draft: "Do not bring this back",
    });
    const survivingSession = createSession({ id: "surviving-session" });
    const baseState = createInitialShellState();
    const state = createStateController({
      ...baseState,
      activeSessionId: survivingSession.id,
      sessions: [survivingSession],
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
          userMemorySettings: { globalEnabled: true, entries: [] },
        },
        voice: { stopSpeaking: vi.fn() },
        uiControlAvailability: undefined,
        aiContextMessageLimit: 60,
        activeDesktopTasksRef: { current: new Map() },
        ignoredDesktopTaskIdsRef: { current: new Set() },
        progressHandlersRef: { current: new Map() },
        applySessionMessageLimit: (session: ChatSessionRecord) => session,
        updateThinkingTrace: vi.fn(),
      }),
    );

    expect(
      result.current.submitTaskToSession({
        sessionSnapshot: deletedSession,
        task: "Submit after enhancement",
        contextAttachments: [],
        clearDraft: true,
        activateSession: true,
      }),
    ).toBe(false);
    expect(runDesktopTaskSpy).not.toHaveBeenCalled();
    expect(
      state.shellState.sessions.some((session) => session.id === deletedSession.id),
    ).toBe(false);

    runDesktopTaskSpy.mockRestore();
  });

  it("queues a session-operation conflict once and removes only its own history", async () => {
    const session = createSession({ id: "operation-conflict-session" });
    const baseState = createInitialShellState();
    const state = createStateController({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });
    let rejectRun: ((reason: Error) => void) | undefined;
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockImplementation(
        () =>
          new Promise<runtime.DesktopTaskRunResponse>((_resolve, reject) => {
            rejectRun = reject;
          }),
      );
    const onSessionOperationConflict = vi.fn(() => true);
    const { result } = renderHook(() =>
      useSessionTaskSubmission({
        state,
        runtime: {
          applyLoadedUserMemorySettings: vi.fn(),
          refreshWorkspaceRuntimeSnapshot: vi.fn(),
          runtimeSnapshot: null,
          userMemorySettings: { globalEnabled: true, entries: [] },
        },
        voice: { stopSpeaking: vi.fn() },
        uiControlAvailability: undefined,
        aiContextMessageLimit: 60,
        activeDesktopTasksRef: { current: new Map() },
        ignoredDesktopTaskIdsRef: { current: new Set() },
        progressHandlersRef: { current: new Map() },
        applySessionMessageLimit: (entry: ChatSessionRecord) => entry,
        updateThinkingTrace: vi.fn(),
        onSessionOperationConflict,
      }),
    );

    try {
      expect(
        result.current.submitTaskToSession({
          sessionSnapshot: session,
          task: "Identical prompt",
          contextAttachments: [],
          clearDraft: false,
          activateSession: true,
        }),
      ).toBe(true);

      state.updateSessionById(session.id, (current) => ({
        ...current,
        messages: [
          ...current.messages,
          {
            id: "concurrent-user",
            taskId: "concurrent-task",
            role: "user",
            content: "Identical prompt",
            createdAt: Date.now() + 1,
          },
        ],
        promptHistory: [...current.promptHistory, "Identical prompt"],
        promptContextHistory: [...current.promptContextHistory, []],
      }));

      await act(async () => {
        rejectRun?.(
          new Error("MACHDOCH_OPERATION_ALREADY_ACTIVE:other-window-task"),
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(onSessionOperationConflict).toHaveBeenCalledTimes(1);
      expect(onSessionOperationConflict).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.id,
          activeTaskId: "other-window-task",
          task: "Identical prompt",
        }),
      );
      expect(state.shellState.sessions[0]?.promptHistory).toEqual([
        "Identical prompt",
      ]);
      expect(
        state.shellState.sessions[0]?.messages.map((message) => message.id),
      ).toEqual(["concurrent-user"]);
    } finally {
      runDesktopTaskSpy.mockRestore();
    }
  });

  it("preserves a pre-existing identical prompt history entry on conflict", async () => {
    const session = createSession({
      id: "deduplicated-history-conflict",
      promptHistory: ["Already remembered"],
      promptContextHistory: [[]],
    });
    const baseState = createInitialShellState();
    const state = createStateController({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });
    let rejectRun: ((reason: Error) => void) | undefined;
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockImplementation(
        () =>
          new Promise<runtime.DesktopTaskRunResponse>((_resolve, reject) => {
            rejectRun = reject;
          }),
      );
    const onSessionOperationConflict = vi.fn(() => true);
    const { result } = renderHook(() =>
      useSessionTaskSubmission({
        state,
        runtime: {
          applyLoadedUserMemorySettings: vi.fn(),
          refreshWorkspaceRuntimeSnapshot: vi.fn(),
          runtimeSnapshot: null,
          userMemorySettings: { globalEnabled: true, entries: [] },
        },
        voice: { stopSpeaking: vi.fn() },
        uiControlAvailability: undefined,
        aiContextMessageLimit: 60,
        activeDesktopTasksRef: { current: new Map() },
        ignoredDesktopTaskIdsRef: { current: new Set() },
        progressHandlersRef: { current: new Map() },
        applySessionMessageLimit: (entry: ChatSessionRecord) => entry,
        updateThinkingTrace: vi.fn(),
        onSessionOperationConflict,
      }),
    );

    try {
      expect(
        result.current.submitTaskToSession({
          sessionSnapshot: session,
          task: "Already remembered",
          contextAttachments: [],
          clearDraft: false,
          activateSession: true,
        }),
      ).toBe(true);

      await act(async () => {
        rejectRun?.(
          new Error("MACHDOCH_OPERATION_ALREADY_ACTIVE:other-window-task"),
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(state.shellState.sessions[0]?.promptHistory).toEqual([
        "Already remembered",
      ]);
      expect(state.shellState.sessions[0]?.promptContextHistory).toEqual([[]]);
      expect(onSessionOperationConflict).toHaveBeenCalledTimes(1);
    } finally {
      runDesktopTaskSpy.mockRestore();
    }
  });

  it("keeps the accumulated timeline when a task is explicitly cancelled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const previousExecution = createMockExecutionFixture("Previous request");
    const session = createSession({
      id: "deadline-history-session",
      messages: [
        {
          id: "previous-user",
          taskId: "previous-task",
          role: "user",
          content: "Previous request",
          createdAt: 100,
        },
        {
          id: "previous-execution",
          taskId: "previous-task",
          role: "agent",
          content: "Previous response",
          createdAt: 200,
          source: {
            kind: "execution",
            execution: previousExecution,
          },
        },
      ],
    });
    const baseState = createInitialShellState();
    const state = createStateController({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });
    let rejectRun: ((reason: Error) => void) | undefined;
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockImplementation(
        () =>
          new Promise<runtime.DesktopTaskRunResponse>((_resolve, reject) => {
            rejectRun = reject;
          }),
      );

    try {
      const { result } = renderHook(() =>
        useSessionTaskSubmission({
          state,
          runtime: {
            applyLoadedUserMemorySettings: vi.fn(),
            refreshWorkspaceRuntimeSnapshot: vi.fn(),
            runtimeSnapshot: null,
            userMemorySettings: { globalEnabled: true, entries: [] },
          },
          voice: { stopSpeaking: vi.fn() },
          uiControlAvailability: undefined,
          aiContextMessageLimit: 60,
          activeDesktopTasksRef: { current: new Map() },
          ignoredDesktopTaskIdsRef: { current: new Set() },
          progressHandlersRef: { current: new Map() },
          applySessionMessageLimit: (entry: ChatSessionRecord) => entry,
          updateThinkingTrace: vi.fn(),
        }),
      );

      expect(
        result.current.submitTaskToSession({
          sessionSnapshot: session,
          task: "Long-running request",
          contextAttachments: [],
          clearDraft: false,
          activateSession: true,
        }),
      ).toBe(true);

      const taskId = runDesktopTaskSpy.mock.calls[0]?.[2]?.taskId;

      expect(taskId).toBeTruthy();
      act(() => {
        state.updateSessionById(session.id, (current) => ({
          ...current,
          messages: current.messages.map((message) => {
            if (
              message.taskId !== taskId ||
              message.source?.kind !== "thinking"
            ) {
              return message;
            }

            return {
              ...message,
              source: {
                kind: "thinking" as const,
                thinking: appendThinkingProgress(
                  message.source.thinking,
                  {
                    task: "Long-running request",
                    mode: "machdoch",
                    state: "executing",
                    message: "Read the workspace state.",
                    executedTools: ["filesystem"],
                    outputSections: [],
                    cancellable: true,
                    timelineEvent: {
                      kind: "tool-call",
                      phase: "completed",
                      label: "Read workspace",
                      detail: "Inspected the relevant project files.",
                      tone: "success",
                      toolName: "filesystem",
                    },
                  },
                  2_000,
                ),
              },
            };
          }),
        }));
        vi.setSystemTime(3_000);
      });

      await act(async () => {
        rejectRun?.(new Error("The task was cancelled by the user."));
        await Promise.resolve();
        await Promise.resolve();
      });

      const visibleMessages = createVisibleConversationMessages(
        state.shellState.sessions[0]?.messages ?? [],
      );
      const terminalMessage = visibleMessages.find(
        (message) =>
          message.taskId === taskId && message.source?.kind === "execution",
      );

      expect(visibleMessages.map((message) => message.id)).toEqual([
        "previous-user",
        "previous-execution",
        `${taskId}-user`,
        `${taskId}-execution`,
      ]);
      expect(terminalMessage?.source?.kind).toBe("execution");
      if (terminalMessage?.source?.kind !== "execution") {
        throw new Error("Expected a terminal execution message.");
      }

      expect(terminalMessage.source.thinking).toMatchObject({
        status: "complete",
        startedAt: 1_000,
        completedAt: 3_000,
      });
      expect(
        terminalMessage.source.thinking?.timelineEvents?.map((event) => ({
          label: event.label,
          elapsedMs: event.elapsedMs,
        })),
      ).toEqual([
        { label: "Read workspace", elapsedMs: 1_000 },
        { label: "Cancelled", elapsedMs: 2_000 },
      ]);
    } finally {
      runDesktopTaskSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("replaces a terminal progress fallback with the complete result and memory updates", async () => {
    vi.useFakeTimers();
    const session = createSession({ id: "late-terminal-result-session" });
    const baseState = createInitialShellState();
    const state = createStateController({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });
    const progressHandlersRef: Parameters<
      typeof useSessionTaskSubmission
    >[0]["progressHandlersRef"] = { current: new Map() };
    let resolveRun: ((value: runtime.DesktopTaskRunResponse) => void) | undefined;
    const runDesktopTaskSpy = vi
      .spyOn(runtime, "runDesktopTask")
      .mockImplementation(
        () =>
          new Promise<runtime.DesktopTaskRunResponse>((resolve) => {
            resolveRun = resolve;
          }),
      );

    try {
      const { result } = renderHook(() =>
        useSessionTaskSubmission({
          state,
          runtime: {
            applyLoadedUserMemorySettings: vi.fn(),
            refreshWorkspaceRuntimeSnapshot: vi.fn(),
            runtimeSnapshot: null,
            userMemorySettings: { globalEnabled: true, entries: [] },
          },
          voice: { stopSpeaking: vi.fn() },
          uiControlAvailability: undefined,
          aiContextMessageLimit: 60,
          activeDesktopTasksRef: { current: new Map() },
          ignoredDesktopTaskIdsRef: { current: new Set() },
          progressHandlersRef,
          applySessionMessageLimit: (entry: ChatSessionRecord) => entry,
          updateThinkingTrace: vi.fn(),
        }),
      );

      expect(
        result.current.submitTaskToSession({
          sessionSnapshot: session,
          task: "Wait for the authoritative result",
          contextAttachments: [],
          clearDraft: false,
          activateSession: true,
        }),
      ).toBe(true);

      const taskId = runDesktopTaskSpy.mock.calls[0]?.[2]?.taskId;
      expect(taskId).toBeTruthy();

      act(() => {
        progressHandlersRef.current.get(taskId!)?.({
          task: "Wait for the authoritative result",
          mode: "machdoch",
          state: "completed",
          message: "Fallback terminal summary",
          executedTools: [],
          outputSections: [],
          cancellable: false,
        }, Date.now());
        vi.advanceTimersByTime(1_500);
      });

      const authoritativeExecution = createMockExecutionFixture(
        "Wait for the authoritative result",
      );
      authoritativeExecution.summary = "Authoritative terminal summary";
      authoritativeExecution.outputSections = [
        { title: "Authoritative details", lines: ["complete"] },
      ];
      authoritativeExecution.memoryUpdates = [
        {
          scope: "session",
          entry: {
            id: "memory-1",
            scope: "session",
            content: "Remember the authoritative result",
            createdAt: 10,
            updatedAt: 10,
          },
        },
      ];
      delete authoritativeExecution.response;

      await act(async () => {
        resolveRun?.({ execution: authoritativeExecution });
        await Promise.resolve();
      });

      const updatedSession = state.shellState.sessions[0];
      const executionMessage = updatedSession?.messages.find(
        (message) => message.id === `${taskId}-execution`,
      );

      expect(executionMessage?.source).toMatchObject({
        kind: "execution",
        execution: {
          summary: "Authoritative terminal summary",
          outputSections: [
            { title: "Authoritative details", lines: ["complete"] },
          ],
        },
      });
      expect(updatedSession?.sessionMemory).toEqual([
        expect.objectContaining({ content: "Remember the authoritative result" }),
      ]);
    } finally {
      runDesktopTaskSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
