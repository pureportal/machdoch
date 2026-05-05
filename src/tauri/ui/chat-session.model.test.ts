import { describe, expect, it } from "vitest";
import {
  createInitialShellState,
  createSession,
  createVisibleConversationMessages,
  getLatestRunningTaskId,
  getSessionOverviewStatus,
  normalizeShellState,
  recoverInterruptedTasksForLaunch,
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

describe("getLatestRunningTaskId", () => {
  it("returns the latest task id only while that task is still running", () => {
    const runningSession = createSession({
      messages: [
        {
          id: "user-task-1",
          taskId: "task-1",
          role: "user",
          content: "finish this task",
          createdAt: 1,
        },
      ],
    });

    expect(getLatestRunningTaskId(runningSession)).toBe("task-1");

    const completedSession = createSession({
      messages: [
        ...runningSession.messages,
        {
          id: "agent-task-1",
          taskId: "task-1",
          role: "agent",
          content: "done",
          createdAt: 2,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("finish this task"),
          },
        },
      ],
    });

    expect(getLatestRunningTaskId(completedSession)).toBeNull();
  });
});

describe("recoverInterruptedTasksForLaunch", () => {
  it("marks persisted in-progress task groups as crashed once per app launch", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-with-interruptions",
      messages: [
        {
          id: "task-1-user",
          taskId: "task-1",
          role: "user",
          content: "finish the first stale task",
          createdAt: 1,
        },
        {
          id: "task-1-thinking",
          taskId: "task-1",
          role: "agent",
          content: "",
          createdAt: 2,
          source: {
            kind: "thinking",
            thinking: createInitialThinkingTrace("ask", 2),
          },
        },
        {
          id: "task-2-user",
          taskId: "task-2",
          role: "user",
          content: "finish the second stale task",
          createdAt: 3,
        },
        {
          id: "task-2-preview",
          taskId: "task-2",
          role: "agent",
          content: "preview only",
          createdAt: 4,
          source: {
            kind: "preview",
            preview: createPreviewFixture("finish the second stale task"),
          },
        },
        {
          id: "task-3-user",
          taskId: "task-3",
          role: "user",
          content: "wait for approval",
          createdAt: 5,
        },
        {
          id: "task-3-agent",
          taskId: "task-3",
          role: "agent",
          content: "approval needed",
          createdAt: 6,
          source: {
            kind: "execution",
            execution: {
              ...createMockExecutionFixture("wait for approval"),
              status: "approval-required",
            },
          },
        },
      ],
    });

    const recovered = recoverInterruptedTasksForLaunch(
      {
        ...baseState,
        activeSessionId: session.id,
        sessions: [session],
      },
      "launch-1",
      100,
    );
    const recoveredSession = recovered.sessions[0];

    expect(recovered.lastRecoveredLaunchId).toBe("launch-1");
    expect(recoveredSession).toBeDefined();
    expect(getSessionOverviewStatus(recoveredSession!)).toBe("waiting");

    const crashMessages = recoveredSession!.messages.filter((message) =>
      message.content.startsWith("**Task crashed.**"),
    );

    expect(crashMessages.map((message) => message.taskId)).toEqual([
      "task-1",
      "task-2",
    ]);
    expect(crashMessages.map((message) => message.createdAt)).toEqual([
      100,
      100,
    ]);
    expect(crashMessages.every((message) => !("source" in message))).toBe(true);
    expect(recoverInterruptedTasksForLaunch(recovered, "launch-1", 200)).toBe(
      recovered,
    );
  });

  it("records the recovered launch even when no tasks were interrupted", () => {
    const baseState = createInitialShellState();
    const recovered = recoverInterruptedTasksForLaunch(
      baseState,
      "launch-empty",
      100,
    );

    expect(recovered.lastRecoveredLaunchId).toBe("launch-empty");
    expect(recovered.sessions).toBe(baseState.sessions);
  });

  it("removes orphaned running thinking panels when the task already has a crash marker", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-with-orphan-thinking",
      messages: [
        {
          id: "task-1-user",
          taskId: "task-1",
          role: "user",
          content: "answer the stale task",
          createdAt: 1,
        },
        {
          id: "task-1-crash",
          taskId: "task-1",
          role: "agent",
          content:
            "**Task crashed.** machdoch restarted before this AI task finished, so it was marked as crashed.",
          createdAt: 2,
        },
        {
          id: "orphan-thinking",
          role: "agent",
          content: "",
          createdAt: 3,
          source: {
            kind: "thinking",
            thinking: createInitialThinkingTrace("ask", 3),
          },
        },
      ],
    });

    const recovered = recoverInterruptedTasksForLaunch(
      {
        ...baseState,
        activeSessionId: session.id,
        sessions: [session],
      },
      "launch-orphan",
      100,
    );
    const recoveredSession = recovered.sessions[0];

    expect(recoveredSession).toBeDefined();
    expect(getSessionOverviewStatus(recoveredSession!)).toBe("crashed");
    expect(
      recoveredSession!.messages.some(
        (message) => message.id === "orphan-thinking",
      ),
    ).toBe(false);
    expect(
      recoveredSession!.messages.filter((message) =>
        message.content.startsWith("**Task crashed.**"),
      ),
    ).toHaveLength(1);
    expect(
      createVisibleConversationMessages(recoveredSession!.messages).map(
        (message) => message.id,
      ),
    ).toEqual(["task-1-user", "task-1-crash"]);
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
