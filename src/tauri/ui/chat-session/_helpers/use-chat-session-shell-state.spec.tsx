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
import {
  createInitialShellState,
  createSession,
  normalizeShellState,
  type ChatSessionQueuedMessage,
} from "../../chat-session.model";
import { createMockExecutionFixture } from "../../preview/fixtures";
import { createInitialThinkingTrace } from "../../task-thinking.model";
import {
  mergeShellStateForPersistence,
  mergeShellStateFromExternalUpdate,
  useChatSessionShellState,
} from "./use-chat-session-shell-state";

const SHELL_STATE_STORAGE_KEY = "machdoch.desktop.shell-state";
const SHELL_STATE_SNAPSHOT_STORAGE_KEY =
  "machdoch.desktop.shell-state-snapshot";

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
  const snapshotValue = window.localStorage.getItem(
    SHELL_STATE_SNAPSHOT_STORAGE_KEY,
  );
  const storedValue = snapshotValue ??
    window.localStorage.getItem(SHELL_STATE_STORAGE_KEY);

  expect(storedValue).not.toBeNull();

  const parsedValue = JSON.parse(storedValue as string) as
    | ReturnType<typeof createInitialShellState>
    | { state: ReturnType<typeof createInitialShellState> };

  return "state" in parsedValue ? parsedValue.state : parsedValue;
};

const createQueuedMessageFixture = (
  overrides: Partial<ChatSessionQueuedMessage> &
    Pick<ChatSessionQueuedMessage, "id" | "sessionId" | "task">,
): ChatSessionQueuedMessage => {
  const createdAt = overrides.createdAt ?? 100;
  const updatedAt = overrides.updatedAt ?? createdAt;

  return {
    contextAttachments: [],
    contentUpdatedAt: updatedAt,
    attachmentsUpdatedAt: updatedAt,
    attachmentTombstones: {},
    blockerUpdatedAt: updatedAt,
    orderRank: 0,
    orderUpdatedAt: updatedAt,
    createdAt,
    updatedAt,
    ...overrides,
  };
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

  it("keeps live draft edits in canonical shell state and persists them after the debounce", async () => {
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

    const { result } = renderHook(() => useChatSessionShellState());

    await flushShellHydration();

    act(() => {
      result.current.setDraftValue("This should stay stable.");
    });

    expect(result.current.activeSession.draft).toBe("This should stay stable.");
    expect(result.current.shellState.sessions[0]?.draft).toBe(
      "This should stay stable.",
    );

    await waitFor(() => {
      expect(loadStoredShellState().sessions[0]?.draft).toBe(
        "This should stay stable.",
      );
    });
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

  it("rebases pre-hydration typing and attachments over a nonempty saved composer", async () => {
    const baseState = createInitialShellState();
    const savedAttachment = {
      id: "saved-before-launch",
      path: "C:\\Work\\saved.txt",
      kind: "file" as const,
      name: "saved.txt",
      parent: "C:\\Work",
    };
    const localAttachment = {
      id: "pasted-before-hydration",
      path: "C:\\Temp\\pasted.png",
      kind: "image" as const,
      name: "pasted.png",
      parent: "C:\\Temp",
    };
    const savedSession = createSession({
      id: "session-nonempty-hydration",
      draft: "Saved draft",
      draftContextAttachments: [savedAttachment],
      createdAt: 100,
      updatedAt: 100,
    });

    storeShellState({
      ...baseState,
      activeSessionId: savedSession.id,
      sessions: [savedSession],
    });

    const { result } = renderHook(() => useChatSessionShellState());

    act(() => {
      result.current.setDraftValue("Typed before hydration");
      result.current.updateActiveSession((session) => ({
        ...session,
        draftContextAttachments: [
          ...session.draftContextAttachments,
          localAttachment,
        ],
        updatedAt: Date.now(),
        composerUpdatedAt: Date.now(),
      }));
    });

    await flushShellHydration();

    expect(result.current.activeSession.id).toBe(savedSession.id);
    expect(result.current.activeSession.draft).toBe("Typed before hydration");
    expect(
      result.current.activeSession.draftContextAttachments.map(
        (attachment) => attachment.id,
      ),
    ).toEqual([savedAttachment.id, localAttachment.id]);
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

  it("does not reset an in-progress rename when session messages stream", async () => {
    const { result } = renderHook(() => useChatSessionShellState());

    await flushShellHydration();

    act(() => {
      result.current.setIsRenamingSession(true);
      result.current.setRenameValue("My unfinished title");
    });

    act(() => {
      result.current.updateActiveSession((session) => ({
        ...session,
        messages: [
          ...session.messages,
          {
            id: "streamed-message",
            role: "agent",
            content: "A streaming update",
            createdAt: Date.now(),
          },
        ],
        updatedAt: Date.now(),
      }));
    });

    expect(result.current.isRenamingSession).toBe(true);
    expect(result.current.renameValue).toBe("My unfinished title");
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

  it("merges concurrent composer attachment additions element by element", () => {
    const baseState = createInitialShellState();
    const firstAttachment = {
      id: "first-concurrent-attachment",
      path: "C:\\Work\\first.txt",
      kind: "file" as const,
      name: "first.txt",
    };
    const secondAttachment = {
      id: "second-concurrent-attachment",
      path: "C:\\Work\\second.txt",
      kind: "file" as const,
      name: "second.txt",
    };
    const baseSession = createSession({
      id: "composer-concurrent-additions",
      createdAt: 100,
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [baseSession],
    };
    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        sessions: [
          {
            ...baseSession,
            draftContextAttachments: [firstAttachment],
            draftAttachmentsUpdatedAt: 200,
            draftAttachmentAddedAt: { [firstAttachment.id]: 200 },
            composerUpdatedAt: 200,
            updatedAt: 200,
          },
        ],
      },
      storedBaseState,
      {
        ...storedBaseState,
        sessions: [
          {
            ...baseSession,
            draftContextAttachments: [secondAttachment],
            draftAttachmentsUpdatedAt: 300,
            draftAttachmentAddedAt: { [secondAttachment.id]: 300 },
            composerUpdatedAt: 300,
            updatedAt: 300,
          },
        ],
      },
    );

    expect(
      mergedState.sessions[0]?.draftContextAttachments.map(
        (attachment) => attachment.id,
      ),
    ).toEqual([firstAttachment.id, secondAttachment.id]);
  });

  it("keeps a concurrent add while a different draft attachment is removed", () => {
    const baseState = createInitialShellState();
    const removedAttachment = {
      id: "removed-concurrent-attachment",
      path: "C:\\Work\\removed.txt",
      kind: "file" as const,
      name: "removed.txt",
    };
    const addedAttachment = {
      id: "added-concurrent-attachment",
      path: "C:\\Work\\added.txt",
      kind: "file" as const,
      name: "added.txt",
    };
    const baseSession = createSession({
      id: "composer-remove-add",
      draft: "Base text",
      draftContextAttachments: [removedAttachment],
      createdAt: 100,
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [baseSession],
    };
    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        sessions: [
          {
            ...baseSession,
            draft: "Locally edited text",
            draftUpdatedAt: 250,
            draftContextAttachments: [],
            draftAttachmentsUpdatedAt: 250,
            draftAttachmentAddedAt: {},
            draftAttachmentTombstones: { [removedAttachment.id]: 250 },
            composerUpdatedAt: 250,
            updatedAt: 250,
          },
        ],
      },
      storedBaseState,
      {
        ...storedBaseState,
        sessions: [
          {
            ...baseSession,
            draftContextAttachments: [removedAttachment, addedAttachment],
            draftAttachmentsUpdatedAt: 300,
            draftAttachmentAddedAt: {
              [removedAttachment.id]: 100,
              [addedAttachment.id]: 300,
            },
            composerUpdatedAt: 300,
            updatedAt: 300,
          },
        ],
      },
    );
    const mergedSession = mergedState.sessions[0];

    expect(mergedSession?.draft).toBe("Locally edited text");
    expect(mergedSession?.draftContextAttachments).toEqual([addedAttachment]);
    expect(mergedSession?.draftAttachmentTombstones?.[removedAttachment.id]).toBe(
      250,
    );
  });

  it("keeps concurrent removals when aggregate attachment clocks advance", () => {
    const baseState = createInitialShellState();
    const firstAttachment = {
      id: "concurrent-remove-first",
      path: "C:\\Work\\first-remove.txt",
      kind: "file" as const,
      name: "first-remove.txt",
    };
    const secondAttachment = {
      id: "concurrent-remove-second",
      path: "C:\\Work\\second-remove.txt",
      kind: "file" as const,
      name: "second-remove.txt",
    };
    const baseSession = createSession({
      id: "composer-concurrent-removals",
      draftContextAttachments: [firstAttachment, secondAttachment],
      draftAttachmentAddedAt: {
        [firstAttachment.id]: 100,
        [secondAttachment.id]: 100,
      },
      createdAt: 100,
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [baseSession],
    };
    const localState = normalizeShellState({
      ...storedBaseState,
      sessions: [
        {
          ...baseSession,
          draftContextAttachments: [secondAttachment],
          draftAttachmentsUpdatedAt: 300,
          draftAttachmentAddedAt: {
            [firstAttachment.id]: 100,
            [secondAttachment.id]: 100,
          },
          draftAttachmentTombstones: { [firstAttachment.id]: 300 },
          composerUpdatedAt: 300,
          updatedAt: 300,
        },
      ],
    });
    const latestState = normalizeShellState({
      ...storedBaseState,
      sessions: [
        {
          ...baseSession,
          draftContextAttachments: [firstAttachment],
          draftAttachmentsUpdatedAt: 200,
          draftAttachmentAddedAt: {
            [firstAttachment.id]: 100,
            [secondAttachment.id]: 100,
          },
          draftAttachmentTombstones: { [secondAttachment.id]: 200 },
          composerUpdatedAt: 200,
          updatedAt: 200,
        },
      ],
    });

    expect(
      localState.sessions[0]?.draftAttachmentAddedAt?.[secondAttachment.id],
    ).toBe(100);

    const mergedState = mergeShellStateForPersistence(
      localState,
      storedBaseState,
      latestState,
    );

    expect(mergedState.sessions[0]?.draftContextAttachments).toEqual([]);
  });

  it("deduplicates concurrent same-path attachment IDs and tombstones the loser", () => {
    const baseState = createInitialShellState();
    const localAttachment = {
      id: "same-path-local-id",
      path: "C:\\Work\\Shared.txt",
      kind: "file" as const,
      name: "Shared.txt",
    };
    const externalAttachment = {
      id: "same-path-external-id",
      path: "c:\\work\\shared.txt",
      kind: "file" as const,
      name: "shared.txt",
    };
    const baseSession = createSession({
      id: "composer-same-path-add",
      createdAt: 100,
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [baseSession],
    };
    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        sessions: [
          {
            ...baseSession,
            draftContextAttachments: [localAttachment],
            draftAttachmentsUpdatedAt: 200,
            draftAttachmentAddedAt: { [localAttachment.id]: 200 },
            composerUpdatedAt: 200,
            updatedAt: 200,
          },
        ],
      },
      storedBaseState,
      {
        ...storedBaseState,
        sessions: [
          {
            ...baseSession,
            draftContextAttachments: [externalAttachment],
            draftAttachmentsUpdatedAt: 300,
            draftAttachmentAddedAt: { [externalAttachment.id]: 300 },
            composerUpdatedAt: 300,
            updatedAt: 300,
          },
        ],
      },
    );
    const mergedSession = mergedState.sessions[0];

    expect(mergedSession?.draftContextAttachments).toEqual([
      externalAttachment,
    ]);
    expect(
      mergedSession?.draftAttachmentTombstones?.[localAttachment.id],
    ).toBe(300);
  });

  it("keeps current composer attachments when an external metadata update has a stale composer snapshot", () => {
    const baseState = createInitialShellState();
    const attachment = {
      id: "screen-attachment",
      path: "C:\\Temp\\screen.png",
      kind: "image" as const,
      name: "screen.png",
      parent: "C:\\Temp",
    };
    const currentSession = createSession({
      id: "composer-attachment-session",
      manualTitle: "Composer attachment session",
      draftContextAttachments: [attachment],
      updatedAt: 200,
      lastReadAt: 200,
    });
    const currentState = {
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [currentSession],
    };
    const externalState = {
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [
        {
          ...currentSession,
          draftContextAttachments: [],
          lastReadAt: 300,
          updatedAt: 300,
        },
      ],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === currentSession.id,
    );

    expect(mergedSession?.draftContextAttachments).toEqual([attachment]);
    expect(mergedSession?.lastReadAt).toBe(300);
  });

  it("keeps current composer draft text when an external metadata update has a stale composer snapshot", () => {
    const baseState = createInitialShellState();
    const currentSession = createSession({
      id: "composer-draft-session",
      manualTitle: "Composer draft session",
      draft: "Do not lose this draft",
      updatedAt: 200,
      lastReadAt: 200,
    });
    const currentState = {
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [currentSession],
    };
    const externalState = {
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [
        {
          ...currentSession,
          draft: "",
          lastReadAt: 300,
          updatedAt: 300,
        },
      ],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === currentSession.id,
    );

    expect(mergedSession?.draft).toBe("Do not lose this draft");
    expect(mergedSession?.lastReadAt).toBe(300);
  });

  it("does not promote unrelated session updates into explicit composer field clocks", () => {
    const baseState = createInitialShellState();
    const baseSession = createSession({
      id: "independent-composer-clock-session",
      createdAt: 100,
      updatedAt: 100,
      composerUpdatedAt: 100,
    });
    const attachment = {
      id: "independent-composer-clock-attachment",
      path: "C:\\Temp\\independent.png",
      kind: "image" as const,
      name: "independent.png",
      parent: "C:\\Temp",
    };
    const localSession = {
      ...baseSession,
      draft: "Keep the explicit composer clocks",
      draftUpdatedAt: 200,
      draftContextAttachments: [attachment],
      draftAttachmentsUpdatedAt: 200,
      draftAttachmentAddedAt: { [attachment.id]: 200 },
      composerUpdatedAt: 200,
      updatedAt: 300,
      messages: [
        {
          id: "unrelated-progress-message",
          role: "agent" as const,
          content: "Progress changed after the composer edit.",
          createdAt: 300,
        },
      ],
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
      storedBaseState,
    );
    const mergedSession = mergedState.sessions[0];

    expect(mergedSession?.draft).toBe("Keep the explicit composer clocks");
    expect(mergedSession?.draftUpdatedAt).toBe(200);
    expect(mergedSession?.draftContextAttachments).toEqual([attachment]);
    expect(mergedSession?.draftAttachmentsUpdatedAt).toBe(200);
    expect(mergedSession?.draftAttachmentAddedAt).toEqual({
      [attachment.id]: 200,
    });
    expect(mergedSession?.composerUpdatedAt).toBe(200);
    expect(mergedSession?.updatedAt).toBe(300);
  });

  it("keeps a cleared local composer when an external metadata update carries older attachments", () => {
    const baseState = createInitialShellState();
    const attachment = {
      id: "cleared-screen-attachment",
      path: "C:\\Temp\\cleared-screen.png",
      kind: "image" as const,
      name: "cleared-screen.png",
      parent: "C:\\Temp",
    };
    const baseSession = createSession({
      id: "composer-clear-session",
      manualTitle: "Composer clear session",
      draft: "Use this stale attachment",
      draftContextAttachments: [attachment],
      updatedAt: 100,
      composerUpdatedAt: 100,
      lastReadAt: 100,
    });
    const currentSession = {
      ...baseSession,
      draft: "",
      draftContextAttachments: [],
      updatedAt: 250,
      composerUpdatedAt: 250,
    };
    const currentState = {
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [currentSession],
    };
    const externalState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [
        {
          ...baseSession,
          lastReadAt: 400,
          updatedAt: 400,
        },
      ],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === currentSession.id,
    );

    expect(mergedSession?.draft).toBe("");
    expect(mergedSession?.draftContextAttachments).toEqual([]);
    expect(mergedSession?.lastReadAt).toBe(400);
    expect(mergedSession?.composerUpdatedAt).toBe(250);
  });

  it("accepts a newer external composer edit when its field clocks are newer", () => {
    const baseState = createInitialShellState();
    const attachment = {
      id: "new-external-attachment",
      path: "C:\\Temp\\new-external.png",
      kind: "image" as const,
      name: "new-external.png",
      parent: "C:\\Temp",
    };
    const currentSession = createSession({
      id: "composer-newer-external-session",
      manualTitle: "Composer newer external",
      updatedAt: 200,
      composerUpdatedAt: 100,
    });
    const externalSession = {
      ...currentSession,
      draft: "Use the newer external composer",
      draftContextAttachments: [attachment],
      updatedAt: 300,
      composerUpdatedAt: 300,
      draftUpdatedAt: 300,
      draftAttachmentsUpdatedAt: 300,
      draftAttachmentAddedAt: { [attachment.id]: 300 },
    };
    const currentState = {
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [currentSession],
    };
    const externalState = {
      ...baseState,
      activeSessionId: externalSession.id,
      sessions: [externalSession],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === currentSession.id,
    );

    expect(mergedSession?.draft).toBe("Use the newer external composer");
    expect(mergedSession?.draftContextAttachments).toEqual([attachment]);
    expect(mergedSession?.composerUpdatedAt).toBe(300);
    expect(mergedSession?.draftUpdatedAt).toBe(300);
    expect(mergedSession?.draftAttachmentsUpdatedAt).toBe(300);
  });

  it("accepts external message advances when the local composer timestamp is newer", () => {
    const baseState = createInitialShellState();
    const attachment = {
      id: "newer-local-attachment",
      path: "C:\\Temp\\local-screen.png",
      kind: "image" as const,
      name: "local-screen.png",
      parent: "C:\\Temp",
    };
    const currentSession = createSession({
      id: "external-message-advance-session",
      manualTitle: "External message advance",
      draftContextAttachments: [attachment],
      updatedAt: 400,
    });
    const externalSession = {
      ...currentSession,
      draftContextAttachments: [],
      updatedAt: 300,
      messages: [
        {
          id: "external-submitted-user",
          taskId: "external-submitted-task",
          role: "user" as const,
          content: "Submitted from another async path",
          createdAt: 300,
        },
      ],
      promptHistory: ["Submitted from another async path"],
    };
    const currentState = {
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [currentSession],
    };
    const externalState = {
      ...baseState,
      activeSessionId: currentSession.id,
      sessions: [externalSession],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (session) => session.id === currentSession.id,
    );

    expect(mergedSession?.messages.map((message) => message.id)).toEqual([
      "external-submitted-user",
    ]);
    expect(mergedSession?.promptHistory).toEqual([
      "Submitted from another async path",
    ]);
    expect(mergedSession?.draftContextAttachments).toEqual([attachment]);
  });

  it("keeps the current active session when an external update touches another running session", () => {
    const baseState = createInitialShellState();
    const runningTaskId = "background-running-task";
    const backgroundSession = createSession({
      id: "background-running-session",
      manualTitle: "Background running session",
      updatedAt: 200,
      messages: [
        {
          id: "background-running-user",
          taskId: runningTaskId,
          role: "user",
          content: "Run in the background",
          createdAt: 100,
        },
        {
          id: "background-running-thinking",
          taskId: runningTaskId,
          role: "agent",
          content: "",
          createdAt: 200,
          source: {
            kind: "thinking",
            thinking: createInitialThinkingTrace("machdoch", 200),
          },
        },
      ],
    });
    const activeSession = createSession({
      id: "foreground-active-session",
      manualTitle: "Foreground active session",
      updatedAt: 150,
    });
    const currentState = {
      ...baseState,
      activeSessionId: activeSession.id,
      sessions: [backgroundSession, activeSession],
    };
    const externalState = {
      ...baseState,
      activeSessionId: backgroundSession.id,
      sessions: [
        {
          ...backgroundSession,
          pinnedAt: 300,
          updatedAt: 300,
        },
        activeSession,
      ],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedBackgroundSession = mergedState.sessions.find(
      (session) => session.id === backgroundSession.id,
    );

    expect(mergedState.activeSessionId).toBe(activeSession.id);
    expect(mergedBackgroundSession?.pinnedAt).toBe(300);
    expect(mergedBackgroundSession?.messages.map((message) => message.id)).toEqual(
      ["background-running-user", "background-running-thinking"],
    );
  });

  it("keeps the local active session when saving a background task completion over a newer active snapshot", () => {
    const baseState = createInitialShellState();
    const runningTaskId = "background-completion-task";
    const backgroundSession = createSession({
      id: "background-completion-session",
      manualTitle: "Background completion session",
      updatedAt: 200,
      messages: [
        {
          id: "background-completion-user",
          taskId: runningTaskId,
          role: "user",
          content: "Complete in the background",
          createdAt: 100,
        },
        {
          id: "background-completion-thinking",
          taskId: runningTaskId,
          role: "agent",
          content: "",
          createdAt: 200,
          source: {
            kind: "thinking",
            thinking: createInitialThinkingTrace("machdoch", 200),
          },
        },
      ],
    });
    const foregroundSession = createSession({
      id: "foreground-completion-session",
      manualTitle: "Foreground completion session",
      updatedAt: 150,
    });
    const execution = createMockExecutionFixture(
      "Complete in the background",
      "C:\\Project",
    );
    const completedBackgroundSession = {
      ...backgroundSession,
      updatedAt: 300,
      messages: [
        ...backgroundSession.messages,
        {
          id: "background-completion-agent",
          taskId: runningTaskId,
          role: "agent" as const,
          content: "Background task completed.",
          createdAt: 300,
          source: {
            kind: "execution" as const,
            execution,
          },
        },
      ],
    };
    const storedBaseState = {
      ...baseState,
      activeSessionId: foregroundSession.id,
      sessions: [backgroundSession, foregroundSession],
    };

    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        sessions: [completedBackgroundSession, foregroundSession],
      },
      storedBaseState,
      {
        ...storedBaseState,
        activeSessionId: backgroundSession.id,
      },
    );
    const mergedBackgroundSession = mergedState.sessions.find(
      (session) => session.id === backgroundSession.id,
    );

    expect(mergedState.activeSessionId).toBe(foregroundSession.id);
    expect(
      mergedBackgroundSession?.messages.some(
        (message) =>
          message.id === "background-completion-agent" &&
          message.source?.kind === "execution",
      ),
    ).toBe(true);
  });

  it("keeps completed messages when an external snapshot is missing them", () => {
    const baseState = createInitialShellState();
    const task = "Finish the stable task";
    const execution = createMockExecutionFixture(task, "C:\\Project");
    const session = createSession({
      id: "completed-message-regression-session",
      updatedAt: 200,
      lastReadAt: 200,
      messages: [
        {
          id: "completed-user",
          taskId: "completed-task",
          role: "user",
          content: task,
          createdAt: 100,
        },
        {
          id: "completed-agent",
          taskId: "completed-task",
          role: "agent",
          content: "Task completed.",
          createdAt: 200,
          source: {
            kind: "execution",
            execution,
          },
        },
      ],
      promptHistory: [task],
    });
    const currentState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    };
    const externalState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [
        {
          ...session,
          updatedAt: 300,
          lastReadAt: 300,
          messages: [],
          promptHistory: [],
        },
      ],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (entry) => entry.id === session.id,
    );

    expect(mergedSession?.lastReadAt).toBe(300);
    expect(mergedSession?.messages.map((message) => message.id)).toEqual([
      "completed-user",
      "completed-agent",
    ]);
  });

  it("persists an intentional history clear without resurrecting old messages", () => {
    const baseState = createInitialShellState();
    const task = "Remove this history";
    const baseSession = createSession({
      id: "intentional-history-clear",
      updatedAt: 100,
      messages: [
        {
          id: "history-user",
          taskId: "history-task",
          role: "user",
          content: task,
          createdAt: 100,
        },
      ],
      promptHistory: [task],
    });
    const localSession = {
      ...baseSession,
      messages: [],
      promptHistory: [],
      historyClearedAt: 200,
      updatedAt: 200,
    };
    const latestSession = {
      ...baseSession,
      pinnedAt: 300,
      updatedAt: 300,
    };
    const storedBaseState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [baseSession],
    };

    const mergedState = mergeShellStateForPersistence(
      { ...storedBaseState, sessions: [localSession] },
      storedBaseState,
      { ...storedBaseState, sessions: [latestSession] },
    );
    const mergedSession = mergedState.sessions[0];

    expect(mergedSession?.messages).toEqual([]);
    expect(mergedSession?.promptHistory).toEqual([]);
    expect(mergedSession?.historyClearedAt).toBe(200);
    expect(mergedSession?.pinnedAt).toBe(300);
  });

  it("keeps messages submitted after a concurrent history clear", () => {
    const baseState = createInitialShellState();
    const baseSession = createSession({
      id: "clear-with-concurrent-send",
      updatedAt: 100,
      messages: [
        {
          id: "old-user",
          taskId: "old-task",
          role: "user",
          content: "Old prompt",
          createdAt: 100,
        },
      ],
      promptHistory: ["Old prompt"],
      promptContextHistory: [[]],
    });
    const clearedSession = {
      ...baseSession,
      messages: [],
      promptHistory: [],
      promptContextHistory: [],
      historyClearedAt: 200,
      updatedAt: 200,
    };
    const concurrentlySubmittedSession = {
      ...baseSession,
      messages: [
        ...baseSession.messages,
        {
          id: "new-user",
          taskId: "new-task",
          role: "user" as const,
          content: "New prompt",
          createdAt: 200,
        },
        {
          id: "new-agent",
          taskId: "new-task",
          role: "agent" as const,
          content: "New response",
          createdAt: 200,
        },
      ],
      promptHistory: ["Old prompt", "New prompt"],
      promptContextHistory: [[], []],
      updatedAt: 200,
    };
    const storedBaseState = {
      ...baseState,
      activeSessionId: baseSession.id,
      sessions: [baseSession],
    };

    const mergedState = mergeShellStateForPersistence(
      { ...storedBaseState, sessions: [clearedSession] },
      storedBaseState,
      { ...storedBaseState, sessions: [concurrentlySubmittedSession] },
    );
    const mergedSession = mergedState.sessions[0];

    expect(mergedSession?.messages.map((message) => message.id)).toEqual([
      "new-user",
      "new-agent",
    ]);
    expect(mergedSession?.promptHistory).toEqual(["New prompt"]);
    expect(mergedSession?.promptContextHistory).toEqual([[]]);
  });

  it("keeps richer same-id thinking traces from stale external snapshots", () => {
    const baseState = createInitialShellState();
    const task = "Preserve thinking detail";
    const initialThinking = createInitialThinkingTrace("machdoch", 150);
    const staleThinkingMessage = {
      id: "thinking-agent",
      taskId: "thinking-task",
      role: "agent" as const,
      content: "",
      createdAt: 150,
      source: {
        kind: "thinking" as const,
        thinking: initialThinking,
      },
    };
    const richerThinkingMessage = {
      ...staleThinkingMessage,
      source: {
        kind: "thinking" as const,
        thinking: {
          ...initialThinking,
          status: "complete" as const,
          completedAt: 250,
          assistantText: "Completed after inspecting the workspace.",
          entries: [
            ...initialThinking.entries,
            {
              id: "thinking-detail",
              label: "Verified",
              detail: "Checked the workspace state.",
              tone: "success" as const,
              timestamp: 240,
            },
          ],
        },
      },
    };
    const session = createSession({
      id: "thinking-regression-session",
      updatedAt: 250,
      lastReadAt: 250,
      messages: [
        {
          id: "thinking-user",
          taskId: "thinking-task",
          role: "user",
          content: task,
          createdAt: 100,
        },
        richerThinkingMessage,
      ],
      promptHistory: [task],
    });
    const currentState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    };
    const externalState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [
        {
          ...session,
          updatedAt: 300,
          lastReadAt: 300,
          messages: [session.messages[0]!, staleThinkingMessage],
        },
      ],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );
    const mergedSession = mergedState.sessions.find(
      (entry) => entry.id === session.id,
    );
    const mergedThinking = mergedSession?.messages.find(
      (message) => message.id === staleThinkingMessage.id,
    );

    expect(mergedSession?.lastReadAt).toBe(300);
    expect(
      mergedThinking?.source?.kind === "thinking"
        ? mergedThinking.source.thinking.status
        : null,
    ).toBe("complete");
    expect(
      mergedThinking?.source?.kind === "thinking"
        ? mergedThinking.source.thinking.entries.map((entry) => entry.detail)
        : [],
    ).toContain("Checked the workspace state.");
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
    const queuedMessage = createQueuedMessageFixture({
      id: "queued-follow-up",
      sessionId: session.id,
      task: "Run the queued follow-up",
      contextAttachments: [],
      createdAt: 200,
      updatedAt: 200,
    });
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

  it("honors an authoritative queued-message deletion from another window", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-queued-stale-drop",
      manualTitle: "Queued stale drop",
      updatedAt: 100,
    });
    const queuedMessage = createQueuedMessageFixture({
      id: "queued-stale-drop",
      sessionId: session.id,
      task: "Keep this queued message",
      contextAttachments: [],
      createdAt: 200,
      updatedAt: 200,
    });
    const currentState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      queuedSessionMessages: [queuedMessage],
    };
    const externalState = {
      ...currentState,
      queuedSessionMessages: [],
    };

    const mergedState = mergeShellStateFromExternalUpdate(
      currentState,
      currentState,
      externalState,
      false,
    );

    expect(mergedState.queuedSessionMessages).toEqual([]);
  });

  it("does not let unrelated activity overwrite a locally changed session field", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-field-merge",
      manualTitle: "Before",
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
    };
    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        sessions: [
          {
            ...session,
            manualTitle: "Local title",
            updatedAt: 200,
          },
        ],
      },
      storedBaseState,
      {
        ...storedBaseState,
        sessions: [
          {
            ...session,
            lastReadAt: 500,
            updatedAt: 500,
          },
        ],
      },
    );

    expect(mergedState.sessions[0]?.manualTitle).toBe("Local title");
    expect(mergedState.sessions[0]?.lastReadAt).toBe(500);
  });

  it("does not resurrect sessions deleted by another window", () => {
    const baseState = createInitialShellState();
    const retainedSession = createSession({
      id: "retained-session",
      updatedAt: 100,
      messages: [
        {
          id: "removable-message",
          role: "agent",
          content: "Remove me",
          createdAt: 100,
        },
      ],
    });
    const deletedSession = createSession({
      id: "deleted-session",
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: retainedSession.id,
      sessions: [retainedSession, deletedSession],
    };
    const latestState = {
      ...storedBaseState,
      sessions: [
        {
          ...retainedSession,
          messages: [],
          updatedAt: 200,
        },
      ],
    };

    const mergedState = mergeShellStateForPersistence(
      storedBaseState,
      storedBaseState,
      latestState,
    );

    expect(mergedState.sessions.map((session) => session.id)).toEqual([
      retainedSession.id,
    ]);
    expect(mergedState.sessions[0]?.messages).toEqual(
      retainedSession.messages,
    );
  });

  it("lets a session tombstone beat a saved draft unless the draft changed after the base", () => {
    const baseState = createInitialShellState();
    const retainedSession = createSession({
      id: "retained-after-external-delete",
      createdAt: 100,
      updatedAt: 100,
    });
    const deletedSession = createSession({
      id: "deleted-saved-draft",
      draft: "Saved before deletion",
      createdAt: 100,
      updatedAt: 100,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: deletedSession.id,
      sessions: [deletedSession, retainedSession],
    };
    const externalState = {
      ...storedBaseState,
      activeSessionId: retainedSession.id,
      sessions: [retainedSession],
      sessionTombstones: { [deletedSession.id]: 300 },
    };

    const withoutLocalMutation = mergeShellStateFromExternalUpdate(
      storedBaseState,
      storedBaseState,
      externalState,
      false,
    );

    expect(
      withoutLocalMutation.sessions.some(
        (session) => session.id === deletedSession.id,
      ),
    ).toBe(false);

    const editedSession = {
      ...deletedSession,
      draft: "Edited after deletion raced",
      draftUpdatedAt: 400,
      composerUpdatedAt: 400,
      updatedAt: 400,
    };
    const withLocalMutation = mergeShellStateFromExternalUpdate(
      {
        ...storedBaseState,
        sessions: [editedSession, retainedSession],
      },
      storedBaseState,
      externalState,
      true,
    );

    expect(
      withLocalMutation.sessions.find(
        (session) => session.id === deletedSession.id,
      )?.draft,
    ).toBe("Edited after deletion raced");
  });

  it("merges remembered new-chat defaults during concurrent persistence", () => {
    const baseState = createInitialShellState();
    const localState = {
      ...baseState,
      lastSelectedReasoning: "high" as const,
      lastSelectedSessionMemoryEnabled: false,
      lastSelectedUseGlobalMemory: false,
      lastSelectedUiControlEnabled: true,
    };
    const latestState = {
      ...baseState,
      lastSelectedProvider: "anthropic" as const,
      lastSelectedModelByProvider: {
        ...baseState.lastSelectedModelByProvider,
        anthropic: "claude-sonnet-4-5",
      },
    };

    const mergedState = mergeShellStateForPersistence(
      localState,
      baseState,
      latestState,
    );

    expect(mergedState.lastSelectedProvider).toBe("anthropic");
    expect(mergedState.lastSelectedModelByProvider.anthropic).toBe(
      "claude-sonnet-4-5",
    );
    expect(mergedState.lastSelectedReasoning).toBe("high");
    expect(mergedState.lastSelectedSessionMemoryEnabled).toBe(false);
    expect(mergedState.lastSelectedUseGlobalMemory).toBe(false);
    expect(mergedState.lastSelectedUiControlEnabled).toBe(true);
  });

  it("does not resurrect queued messages that were removed locally", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-queued-local-delete",
      manualTitle: "Queued local delete",
      updatedAt: 100,
    });
    const queuedMessage = createQueuedMessageFixture({
      id: "queued-local-delete",
      sessionId: session.id,
      task: "Remove this queued message",
      contextAttachments: [],
      createdAt: 200,
      updatedAt: 200,
    });
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
            updatedAt: 250,
          },
        ],
      },
    );

    expect(mergedState.queuedSessionMessages).toEqual([]);
  });

  it("does not resurrect queued messages that were removed during dispatch", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-queued-dispatch",
      manualTitle: "Queued dispatch",
      updatedAt: 100,
    });
    const queuedMessage = createQueuedMessageFixture({
      id: "queued-dispatched",
      sessionId: session.id,
      task: "Dispatch me once",
      contextAttachments: [],
      createdAt: 200,
      updatedAt: 200,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      queuedSessionMessages: [queuedMessage],
    };
    const dispatchedSession = {
      ...session,
      updatedAt: 250,
      messages: [
        {
          id: "queued-dispatched-user",
          taskId: "queued-dispatched-task",
          role: "user" as const,
          content: queuedMessage.task,
          createdAt: 250,
        },
      ],
    };
    const mergedState = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        sessions: [dispatchedSession],
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

  it("merges queued text edits independently from a concurrent reorder", () => {
    const baseState = createInitialShellState();
    const session = createSession({ id: "queue-order-session" });
    const first = createQueuedMessageFixture({
      id: "queue-first",
      sessionId: session.id,
      task: "First",
      orderRank: 0,
    });
    const second = createQueuedMessageFixture({
      id: "queue-second",
      sessionId: session.id,
      task: "Second",
      orderRank: 1,
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      queuedSessionMessages: [first, second],
    };
    const merged = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        queuedSessionMessages: [
          { ...second, orderRank: 0, orderUpdatedAt: 200 },
          { ...first, orderRank: 1, orderUpdatedAt: 200 },
        ],
      },
      storedBaseState,
      {
        ...storedBaseState,
        queuedSessionMessages: [
          {
            ...first,
            task: "First, edited",
            contentUpdatedAt: 300,
            updatedAt: 300,
          },
          second,
        ],
      },
    );

    expect(
      merged.queuedSessionMessages.map((message) => [message.id, message.task]),
    ).toEqual([
      ["queue-second", "Second"],
      ["queue-first", "First, edited"],
    ]);
  });

  it("keeps a queued deletion over a stale blocker completion", () => {
    const baseState = createInitialShellState();
    const session = createSession({ id: "queue-delete-blocker-session" });
    const queued = createQueuedMessageFixture({
      id: "queue-delete-blocker",
      sessionId: session.id,
      task: "Do not resurrect",
      blockedByTaskId: "active-task",
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      queuedSessionMessages: [queued],
    };
    const unblockedQueuedMessage = {
      ...queued,
      blockerUpdatedAt: 250,
      updatedAt: 250,
    };
    delete unblockedQueuedMessage.blockedByTaskId;
    const merged = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        queuedSessionMessages: [],
        queuedMessageTombstones: { [queued.id]: 300 },
      },
      storedBaseState,
      {
        ...storedBaseState,
        queuedSessionMessages: [unblockedQueuedMessage],
      },
    );

    expect(merged.queuedSessionMessages).toEqual([]);
    expect(merged.queuedMessageTombstones[queued.id]).toBe(300);
  });

  it("does not re-add a removed queued attachment after a stale text edit", () => {
    const baseState = createInitialShellState();
    const session = createSession({ id: "queue-attachment-session" });
    const attachment = {
      id: "queued-attachment",
      path: "C:\\Project\\context.md",
      kind: "file" as const,
      name: "context.md",
      parent: "C:\\Project",
    };
    const queued = createQueuedMessageFixture({
      id: "queue-with-attachment",
      sessionId: session.id,
      task: "Original",
      contextAttachments: [attachment],
    });
    const storedBaseState = {
      ...baseState,
      activeSessionId: session.id,
      sessions: [session],
      queuedSessionMessages: [queued],
    };
    const merged = mergeShellStateForPersistence(
      {
        ...storedBaseState,
        queuedSessionMessages: [
          {
            ...queued,
            contextAttachments: [],
            attachmentTombstones: { [attachment.id]: 200 },
            attachmentsUpdatedAt: 200,
            updatedAt: 200,
          },
        ],
      },
      storedBaseState,
      {
        ...storedBaseState,
        queuedSessionMessages: [
          {
            ...queued,
            task: "Edited elsewhere",
            contentUpdatedAt: 300,
            updatedAt: 300,
          },
        ],
      },
    );

    expect(merged.queuedSessionMessages[0]).toMatchObject({
      task: "Edited elsewhere",
      contextAttachments: [],
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
