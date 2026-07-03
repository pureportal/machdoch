import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialShellState, createSession } from "../../chat-session.model";
import { createMockExecutionFixture } from "../../preview/fixtures";
import { createInitialThinkingTrace } from "../../task-thinking.model";
import {
  mergeShellStateForPersistence,
  mergeShellStateFromExternalUpdate,
  useChatSessionShellState,
} from "./use-chat-session-shell-state";

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

interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
}

let resizeObserverMocks: ResizeObserverMock[] = [];

class ResizeObserverMock implements ResizeObserver {
  active = true;
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn(() => {
    this.active = false;
  });

  constructor(readonly callback: ResizeObserverCallback) {
    resizeObserverMocks.push(this);
  }
}

const triggerActiveResizeObservers = (): void => {
  act(() => {
    for (const observer of resizeObserverMocks) {
      if (observer.active) {
        observer.callback([], observer);
      }
    }
  });
};

const renderScrollHarness = (metrics: ScrollMetrics): void => {
  const ScrollHarness = () => {
    const controller = useChatSessionShellState();

    return (
      <div
        data-testid="scroll-viewport"
        data-slot="scroll-area-viewport"
        ref={(node) => {
          if (!node) {
            return;
          }

          Object.defineProperties(node, {
            clientHeight: {
              configurable: true,
              get: () => metrics.clientHeight,
            },
            scrollHeight: {
              configurable: true,
              get: () => metrics.scrollHeight,
            },
          });
        }}
      >
        <div>
          <div ref={controller.bottomRef} />
        </div>
      </div>
    );
  };

  render(<ScrollHarness />);
};

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  cleanup();
  resizeObserverMocks = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
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

  it("keeps a pre-hydration draft on the hydrated active session", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-hydrated-draft",
      manualTitle: "Hydrated draft session",
      updatedAt: 1,
    });

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    const { result } = renderHook(() => useChatSessionShellState());

    act(() => {
      result.current.setDraftValue("Draft typed before hydration");
    });

    await flushShellHydration();

    expect(result.current.activeSession.id).toBe(session.id);
    expect(result.current.activeSession.draft).toBe(
      "Draft typed before hydration",
    );
  });

  it("applies functional draft updates against the latest local draft", async () => {
    const { result } = renderHook(() => useChatSessionShellState());

    await flushShellHydration();

    act(() => {
      result.current.setDraftValue((draft) => `${draft}first`);
      result.current.setDraftValue((draft) => `${draft} second`);
    });

    expect(result.current.activeSession.draft).toBe("first second");
  });

  it("applies pre-hydration async active-session updates to the hydrated active session", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-hydrated-active",
      manualTitle: "Hydrated active session",
      updatedAt: 1,
    });
    const attachment = {
      id: "pasted-image",
      path: "C:\\Temp\\pasted.png",
      kind: "image" as const,
      name: "pasted.png",
      parent: "C:\\Temp",
    };

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    const { result } = renderHook(() => useChatSessionShellState());
    const updateActiveSessionBeforeHydration =
      result.current.updateActiveSession;

    await flushShellHydration();

    act(() => {
      updateActiveSessionBeforeHydration((currentSession) => ({
        ...currentSession,
        draftContextAttachments: [attachment],
        updatedAt: 2,
      }));
    });

    expect(result.current.activeSession.id).toBe(session.id);
    expect(result.current.activeSession.draftContextAttachments).toEqual([
      attachment,
    ]);
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

  it("preserves a local submit when a newer external snapshot only changed metadata", () => {
    const baseState = createInitialShellState();
    const attachment = {
      id: "image-attachment",
      path: "C:\\Temp\\screen.png",
      kind: "image" as const,
      name: "screen.png",
      parent: "C:\\Temp",
    };
    const baseSession = createSession({
      id: "session-submit-race",
      manualTitle: "Submit race",
      draft: "Investigate state mismatch",
      draftContextAttachments: [attachment],
      messages: [],
      promptHistory: [],
      promptContextHistory: [],
      updatedAt: 100,
    });
    const localSession = {
      ...baseSession,
      draft: "",
      draftContextAttachments: [],
      messages: [
        {
          id: "submitted-user-message",
          taskId: "task-submit-race",
          role: "user" as const,
          content: "Investigate state mismatch",
          createdAt: 200,
          contextAttachments: [attachment],
        },
      ],
      promptHistory: ["Investigate state mismatch"],
      promptContextHistory: [[attachment]],
      updatedAt: 200,
    };
    const latestSession = {
      ...baseSession,
      lastReadAt: 300,
      updatedAt: 300,
    };
    const storedBaseState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [baseSession],
    };
    const localState = {
      ...storedBaseState,
      sessions: [localSession],
    };
    const latestState = {
      ...storedBaseState,
      sessions: [latestSession],
    };

    const mergedState = mergeShellStateForPersistence(
      localState,
      storedBaseState,
      latestState,
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === baseSession.id,
    );

    expect(mergedSession?.messages).toHaveLength(1);
    expect(mergedSession?.messages[0]?.content).toBe(
      "Investigate state mismatch",
    );
    expect(mergedSession?.draft).toBe("");
    expect(mergedSession?.draftContextAttachments).toEqual([]);
    expect(mergedSession?.promptHistory).toEqual([
      "Investigate state mismatch",
    ]);
    expect(mergedSession?.promptContextHistory).toEqual([[attachment]]);
    expect(mergedSession?.lastReadAt).toBe(300);
  });

  it("keeps a changed local active session active when merging pre-hydration work", () => {
    const baseState = createInitialShellState();
    const persistedSession = createSession({
      id: "persisted-session",
      manualTitle: "Persisted session",
      updatedAt: 50,
    });
    const localActiveSession = {
      ...baseState.sessions[0]!,
      updatedAt: 100,
      messages: [
        {
          id: "pre-hydration-user-message",
          taskId: "pre-hydration-task",
          role: "user" as const,
          content: "Submitted before hydration",
          createdAt: 100,
        },
      ],
    };

    const mergedState = mergeShellStateForPersistence(
      {
        ...baseState,
        activeSessionId: localActiveSession.id,
        sessions: [localActiveSession],
      },
      baseState,
      {
        ...baseState,
        activeSessionId: persistedSession.id,
        sessions: [persistedSession],
      },
    );

    expect(mergedState.activeSessionId).toBe(localActiveSession.id);
    expect(
      mergedState.sessions.some((session) => session.id === persistedSession.id),
    ).toBe(true);
    expect(
      mergedState.sessions.find((session) => session.id === localActiveSession.id)
        ?.messages[0]?.content,
    ).toBe("Submitted before hydration");
  });

  it("keeps first-submit messages when a newer empty new-session snapshot is merged", () => {
    const baseState = createInitialShellState();
    const task = "Investigate disappearing submit";
    const newSession = createSession({
      id: "new-session-submit-race",
      updatedAt: 100,
      lastReadAt: 100,
    });
    const userMessage = {
      id: "submitted-user-message",
      taskId: "submitted-task",
      role: "user" as const,
      content: task,
      createdAt: 200,
    };
    const thinkingMessage = {
      id: "submitted-thinking-message",
      taskId: "submitted-task",
      role: "agent" as const,
      content: "",
      createdAt: 200,
      source: {
        kind: "thinking" as const,
        thinking: createInitialThinkingTrace("machdoch", 200),
      },
    };
    const submittedSession = {
      ...newSession,
      updatedAt: 200,
      messages: [userMessage, thinkingMessage],
      promptHistory: [task],
    };
    const emptyNewerSession = {
      ...newSession,
      lastReadAt: 300,
    };

    const mergedState = mergeShellStateForPersistence(
      {
        ...baseState,
        activeSessionId: newSession.id,
        sessions: [emptyNewerSession, ...baseState.sessions],
      },
      baseState,
      {
        ...baseState,
        activeSessionId: newSession.id,
        sessions: [submittedSession, ...baseState.sessions],
      },
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === newSession.id,
    );

    expect(mergedState.activeSessionId).toBe(newSession.id);
    expect(mergedSession?.messages.map((message) => message.id)).toEqual([
      userMessage.id,
      thinkingMessage.id,
    ]);
    expect(mergedSession?.promptHistory).toEqual([task]);
  });

  it("keeps a settled local running submit when an external update is empty", () => {
    const baseState = createInitialShellState();
    const task = "Keep the running user anchor";
    const newSession = createSession({
      id: "settled-running-submit",
      updatedAt: 100,
      lastReadAt: 100,
    });
    const userMessage = {
      id: "running-user-message",
      taskId: "running-task",
      role: "user" as const,
      content: task,
      createdAt: 200,
    };
    const thinkingMessage = {
      id: "running-thinking-message",
      taskId: "running-task",
      role: "agent" as const,
      content: "",
      createdAt: 200,
      source: {
        kind: "thinking" as const,
        thinking: createInitialThinkingTrace("machdoch", 200),
      },
    };
    const runningSession = {
      ...newSession,
      updatedAt: 200,
      messages: [userMessage, thinkingMessage],
      promptHistory: [task],
    };
    const externalEmptySession = {
      ...newSession,
      lastReadAt: 300,
    };
    const currentState = {
      ...baseState,
      activeSessionId: newSession.id,
      sessions: [runningSession, ...baseState.sessions],
    };
    const externalState = {
      ...baseState,
      activeSessionId: newSession.id,
      sessions: [externalEmptySession, ...baseState.sessions],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === newSession.id,
    );

    expect(mergedState.activeSessionId).toBe(newSession.id);
    expect(mergedSession?.messages.map((message) => message.id)).toEqual([
      userMessage.id,
      thinkingMessage.id,
    ]);
    expect(mergedSession?.promptHistory).toEqual([task]);
  });

  it("keeps newer local running progress when an external update has only the user anchor", () => {
    const baseState = createInitialShellState();
    const task = "Keep active task progress";
    const taskId = "running-task-progress";
    const newSession = createSession({
      id: "running-progress-session",
      updatedAt: 100,
      lastReadAt: 100,
    });
    const userMessage = {
      id: "running-progress-user",
      taskId,
      role: "user" as const,
      content: task,
      createdAt: 200,
    };
    const initialThinking = createInitialThinkingTrace("machdoch", 210);
    const staleThinkingMessage = {
      id: "running-progress-thinking",
      taskId,
      role: "agent" as const,
      content: "",
      createdAt: 210,
      source: {
        kind: "thinking" as const,
        thinking: initialThinking,
      },
    };
    const currentThinkingMessage = {
      ...staleThinkingMessage,
      source: {
        kind: "thinking" as const,
        thinking: {
          ...initialThinking,
          entries: [
            ...initialThinking.entries,
            {
              id: "running-progress-executing",
              label: "Executing",
              detail: "Executing the request.",
              tone: "info" as const,
              timestamp: 250,
            },
          ],
        },
      },
    };
    const currentState = {
      ...baseState,
      activeSessionId: newSession.id,
      sessions: [
        {
          ...newSession,
          updatedAt: 250,
          messages: [userMessage, currentThinkingMessage],
          promptHistory: [task],
        },
        ...baseState.sessions,
      ],
    };
    const externalState = {
      ...baseState,
      activeSessionId: newSession.id,
      sessions: [
        {
          ...newSession,
          updatedAt: 300,
          lastReadAt: 300,
          messages: [userMessage, staleThinkingMessage],
          promptHistory: [task],
        },
        ...baseState.sessions,
      ],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === newSession.id,
    );
    const mergedThinking = mergedSession?.messages.find(
      (message) => message.id === staleThinkingMessage.id,
    );

    expect(mergedState.activeSessionId).toBe(newSession.id);
    expect(mergedSession?.lastReadAt).toBe(300);
    expect(mergedSession?.messages.map((message) => message.id)).toEqual([
      userMessage.id,
      staleThinkingMessage.id,
    ]);
    expect(
      mergedThinking?.source?.kind === "thinking"
        ? mergedThinking.source.thinking.entries.map((entry) => entry.detail)
        : [],
    ).toContain("Executing the request.");
  });

  it("merges same-id message updates from concurrent thinking and final-response saves", () => {
    const baseState = createInitialShellState();
    const task = "Summarize the workspace";
    const baseExecution = createMockExecutionFixture(task, "C:\\Project");
    const userMessage = {
      id: "user-task",
      taskId: "task-1",
      role: "user" as const,
      content: task,
      createdAt: 100,
    };
    const fallbackExecutionMessage = {
      id: "agent-execution-task",
      taskId: "task-1",
      role: "agent" as const,
      content: "**Done.** Fallback summary.",
      createdAt: 200,
      source: {
        kind: "execution" as const,
        execution: {
          ...(() => {
            const executionWithoutResponse = { ...baseExecution };
            delete executionWithoutResponse.response;

            return executionWithoutResponse;
          })(),
          summary: "Fallback summary.",
        },
      },
    };
    const baseThinkingMessage = {
      id: "agent-thinking-task",
      taskId: "task-1",
      role: "agent" as const,
      content: "",
      createdAt: 150,
      source: {
        kind: "thinking" as const,
        thinking: createInitialThinkingTrace("machdoch", 150),
      },
    };
    const baseSession = createSession({
      id: "session-message-merge",
      messages: [userMessage, baseThinkingMessage, fallbackExecutionMessage],
      updatedAt: 200,
    });
    const localSession = {
      ...baseSession,
      messages: [
        userMessage,
        {
          ...baseThinkingMessage,
          source: {
            kind: "thinking" as const,
            thinking: {
              ...baseThinkingMessage.source.thinking,
              completedAt: 250,
              status: "complete" as const,
            },
          },
        },
        fallbackExecutionMessage,
      ],
      updatedAt: 250,
    };
    const latestSession = {
      ...baseSession,
      messages: [
        userMessage,
        baseThinkingMessage,
        {
          ...fallbackExecutionMessage,
          content: "Authoritative final response.",
          source: {
            kind: "execution" as const,
            execution: {
              ...baseExecution,
              summary: "Authoritative summary.",
              response: {
                ...(baseExecution.response ?? {
                  highlights: [],
                  relatedFiles: [],
                  verification: [],
                  followUps: [],
                }),
                markdown: "Authoritative final response.",
              },
            },
          },
        },
      ],
      updatedAt: 300,
    };
    const storedBaseState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [baseSession],
    };
    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        sessions: [localSession],
      },
      storedBaseState,
      {
        ...storedBaseState,
        sessions: [latestSession],
      },
    );
    const mergedSession = mergedState.sessions[0];
    const mergedThinking = mergedSession?.messages.find(
      (message) => message.id === baseThinkingMessage.id,
    );
    const mergedExecution = mergedSession?.messages.find(
      (message) => message.id === fallbackExecutionMessage.id,
    );

    expect(mergedThinking?.source?.kind).toBe("thinking");
    expect(
      mergedThinking?.source?.kind === "thinking"
        ? mergedThinking.source.thinking.status
        : null,
    ).toBe("complete");
    expect(mergedExecution?.content).toBe("Authoritative final response.");
    expect(
      mergedExecution?.source?.kind === "execution"
        ? mergedExecution.source.execution.response?.markdown
        : null,
    ).toBe("Authoritative final response.");
  });

  it("merges external shell-state events with pending local changes", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-external-race",
      manualTitle: "External race",
      draft: "Run task",
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    };
    const localState = {
      ...storedBaseState,
      sessions: [
        {
          ...session,
          draft: "",
          messages: [
            {
              id: "submitted-user-message",
              taskId: "task-external-race",
              role: "user" as const,
              content: "Run task",
              createdAt: 200,
            },
          ],
          updatedAt: 200,
        },
      ],
    };
    const externalState = {
      ...storedBaseState,
      sessions: [
        {
          ...session,
          pinnedAt: 300,
          updatedAt: 300,
        },
      ],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      localState,
      storedBaseState,
      externalState,
      true,
    );
    const mergedSession = mergedState.sessions.find(
      (entry) => entry.id === session.id,
    );

    expect(mergedSession?.messages).toHaveLength(1);
    expect(mergedSession?.draft).toBe("");
    expect(mergedSession?.pinnedAt).toBe(300);
  });

  it("keeps queued messages when merging with external session metadata", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-queued-merge",
      manualTitle: "Queued merge",
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    };
    const queuedMessage = {
      id: "queued-follow-up",
      sessionId: session.id,
      task: "Run the queued follow-up",
      contextAttachments: [],
      createdAt: 200,
      updatedAt: 200,
    };
    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        queuedSessionMessages: [queuedMessage],
      },
      storedBaseState,
      {
        ...storedBaseState,
        sessions: [
          {
            ...session,
            pinnedAt: 300,
            updatedAt: 300,
          },
        ],
      },
    );

    expect(mergedState.queuedSessionMessages).toEqual([queuedMessage]);
    expect(mergedState.sessions[0]?.pinnedAt).toBe(300);
  });

  it("does not resurrect queued messages that were removed during dispatch", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-queued-dispatch",
      manualTitle: "Queued dispatch",
      updatedAt: 100,
    });
    const queuedMessage = {
      id: "queued-dispatched",
      sessionId: session.id,
      task: "Dispatch me once",
      contextAttachments: [],
      createdAt: 200,
      updatedAt: 200,
    };
    const storedBaseState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      queuedSessionMessages: [queuedMessage],
    };
    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        queuedSessionMessages: [],
      },
      storedBaseState,
      {
        ...storedBaseState,
        queuedSessionMessages: [
          {
            ...queuedMessage,
            task: "Edited elsewhere",
            updatedAt: 300,
          },
        ],
      },
    );

    expect(mergedState.queuedSessionMessages).toEqual([]);
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
    await flushShellPersistence();

    expect(result.current.activeSessionId).toBe(secondSession.id);

    act(() => {
      result.current.applyShellState((prev) => ({
        ...prev,
        activeSessionId: firstSession.id,
      }));
    });
    await flushShellPersistence();

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
    await flushShellPersistence();

    expect(result.current.activeSessionId).toBe(secondSession.id);
    expect(result.current.activeSession.id).toBe(secondSession.id);
  });

  it("keeps the scroll viewport pinned to the newest message when content grows after render", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-scroll-resize",
      manualTitle: "Scroll resize",
      updatedAt: 1,
      messages: [
        {
          id: "scroll-user",
          role: "user",
          content: "Start",
          createdAt: 1,
        },
        {
          id: "scroll-agent",
          role: "agent",
          content: "Working",
          createdAt: 2,
        },
      ],
    });
    const metrics: ScrollMetrics = {
      clientHeight: 500,
      scrollHeight: 1_000,
    };

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    renderScrollHarness(metrics);
    await flushShellHydration();

    const viewport = screen.getByTestId("scroll-viewport");

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(500);
    });

    metrics.scrollHeight = 1_250;
    triggerActiveResizeObservers();

    expect(viewport.scrollTop).toBe(750);
  });

  it("does not force the scroll viewport to newest after the user scrolls away", async () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-scroll-away",
      manualTitle: "Scroll away",
      updatedAt: 1,
      messages: [
        {
          id: "scroll-away-user",
          role: "user",
          content: "Start",
          createdAt: 1,
        },
        {
          id: "scroll-away-agent",
          role: "agent",
          content: "Working",
          createdAt: 2,
        },
      ],
    });
    const metrics: ScrollMetrics = {
      clientHeight: 500,
      scrollHeight: 1_000,
    };

    storeShellState({
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    });

    renderScrollHarness(metrics);
    await flushShellHydration();

    const viewport = screen.getByTestId("scroll-viewport");

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(500);
    });

    viewport.scrollTop = 240;
    fireEvent.scroll(viewport);

    metrics.scrollHeight = 1_250;
    triggerActiveResizeObservers();

    expect(viewport.scrollTop).toBe(240);
  });
});
