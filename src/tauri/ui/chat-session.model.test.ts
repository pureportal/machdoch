import { describe, expect, it } from "vitest";
import {
  createSession,
  createVisibleConversationMessages,
  getSessionOverviewStatus,
  normalizeShellState,
} from "./chat-session.model";
import {
  createMockExecutionFixture,
  createPreviewFixture,
} from "./preview/fixtures";
import { createInitialThinkingTrace } from "./task-thinking.model";

describe("normalizeShellState", () => {
  it("repairs invalid persisted sessions while preserving valid overrides", () => {
    const normalized = normalizeShellState({
      activeSessionId: "session-1",
      sessions: [
        null,
        {
          id: "session-1",
          provider: "invalid",
          model: "",
          draft: 12,
          workspace: 42,
          promptHistory: ["first", 7, "second"],
          sessionMemoryEnabled: false,
          useGlobalMemory: false,
          uiControlEnabled: true,
          createdAt: 123,
          updatedAt: 456,
        },
      ],
      lastSelectedProvider: "invalid",
      lastSelectedModelByProvider: {
        openai: "gpt-custom",
        google: "",
      },
      voice: {
        autoSpeakResponses: true,
        preferredVoiceURI: "voice-default",
        rate: 99,
      },
    });

    expect(normalized.activeSessionId).toBe("session-1");
    expect(normalized.lastSelectedProvider).toBe("openai");
    expect(normalized.lastSelectedModelByProvider.openai).toBe("gpt-custom");
    expect(normalized.voice).toEqual({
      autoSpeakResponses: true,
      preferredVoiceURI: "voice-default",
      rate: 1.4,
    });
    expect(normalized.sessions).toHaveLength(1);
    expect(normalized.sessions[0]).toMatchObject({
      id: "session-1",
      provider: "openai",
      draft: "",
      workspace: null,
      promptHistory: ["first", "second"],
      sessionMemoryEnabled: false,
      useGlobalMemory: false,
      uiControlEnabled: true,
      createdAt: 123,
      updatedAt: 456,
    });
    expect(normalized.sessions[0]?.model.length).toBeGreaterThan(0);
  });
});

describe("getSessionOverviewStatus", () => {
  it("treats the latest task as running when only preview updates exist", () => {
    const session = createSession({
      messages: [
        {
          id: "user-task-1",
          taskId: "task-1",
          role: "user",
          content: "finish the old task",
          createdAt: 1,
        },
        {
          id: "agent-task-1",
          taskId: "task-1",
          role: "agent",
          content: "done",
          createdAt: 2,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("scan this workspace"),
          },
        },
        {
          id: "user-task-2",
          taskId: "task-2",
          role: "user",
          content: "start the latest task",
          createdAt: 3,
        },
        {
          id: "preview-task-2",
          taskId: "task-2",
          role: "agent",
          content: "preview only",
          createdAt: 4,
          source: {
            kind: "preview",
            preview: createPreviewFixture("start the latest task"),
          },
        },
      ],
    });

    expect(getSessionOverviewStatus(session)).toBe("running");
  });

  it("marks approval-required execution updates as waiting", () => {
    const session = createSession({
      messages: [
        {
          id: "user-task-1",
          taskId: "task-1",
          role: "user",
          content: "need approval",
          createdAt: 1,
        },
        {
          id: "agent-task-1",
          taskId: "task-1",
          role: "agent",
          content: "approval needed",
          createdAt: 2,
          source: {
            kind: "execution",
            execution: {
              ...createMockExecutionFixture("scan this workspace"),
              status: "approval-required",
            },
          },
        },
      ],
    });

    expect(getSessionOverviewStatus(session)).toBe("waiting");
  });
});

describe("createVisibleConversationMessages", () => {
  it("keeps non-preview messages in order and only the latest agent update per task", () => {
    const visibleMessages = createVisibleConversationMessages([
      {
        id: "user-task-1",
        taskId: "task-1",
        role: "user",
        content: "first request",
      },
      {
        id: "preview-task-1",
        taskId: "task-1",
        role: "agent",
        content: "preview",
        source: {
          kind: "preview",
          preview: createPreviewFixture("first request"),
        },
      },
      {
        id: "thinking-task-1",
        taskId: "task-1",
        role: "agent",
        content: "thinking",
        source: {
          kind: "thinking",
          thinking: createInitialThinkingTrace("ask", 1),
        },
      },
      {
        id: "execution-task-1",
        taskId: "task-1",
        role: "agent",
        content: "done",
        source: {
          kind: "execution",
          execution: createMockExecutionFixture("scan this workspace"),
        },
      },
      {
        id: "user-task-2",
        taskId: "task-2",
        role: "user",
        content: "second request",
      },
    ]);

    expect(visibleMessages.map((message) => message.id)).toEqual([
      "user-task-1",
      "execution-task-1",
      "user-task-2",
    ]);
  });
});
