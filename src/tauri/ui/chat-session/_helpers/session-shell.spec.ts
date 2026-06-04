import { createSession } from "../../chat-session.model.ts";
import type { RuntimeSnapshot } from "../../runtime";
import {
  createConversationContextFromSession,
  getEffectiveSessionMode,
  getWorkspaceLabel,
} from "./session-shell.ts";

const createRuntimeSnapshot = (
  overrides: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot => {
  return {
    workspaceRoot: "c:/Development/machdoch",
    availableProfiles: [],
    mode: "ask",
    provider: "openai",
    model: "gpt-5.5",
    offline: false,
    agentLimits: {
      executorTurns: 64,
      autopilotExecutorIterations: 16,
    },
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability: [],
    webSearch: {
      activeProvider: "none",
      providerAvailability: [],
    },
    reviewModel: {
      mode: "base",
    },
    ...overrides,
  };
};

describe("session shell helpers", () => {
  it("uses the session override before the workspace default mode", () => {
    expect(
      getEffectiveSessionMode(
        "machdoch",
        createRuntimeSnapshot({ mode: "ask" }),
      ),
    ).toBe("machdoch");
    expect(
      getEffectiveSessionMode(
        undefined,
        createRuntimeSnapshot({ mode: "ask" }),
      ),
    ).toBe("ask");
    expect(getEffectiveSessionMode(undefined, null)).toBe("machdoch");
  });

  it("falls back when persisted mode values are malformed", () => {
    expect(
      getEffectiveSessionMode(
        "auto" as never,
        createRuntimeSnapshot({ mode: "ask" }),
      ),
    ).toBe("ask");
    expect(
      getEffectiveSessionMode(
        undefined,
        createRuntimeSnapshot({ mode: "auto" as never }),
      ),
    ).toBe("machdoch");
  });

  it("formats workspace labels from path tails", () => {
    expect(getWorkspaceLabel("c:\\Development\\machdoch")).toBe("machdoch");
    expect(getWorkspaceLabel("/tmp/example-workspace")).toBe(
      "example-workspace",
    );
    expect(getWorkspaceLabel(null)).toBe("No workspace");
  });

  it("builds conversation context from visible messages only", () => {
    const session = createSession({
      sessionMemoryEnabled: true,
      useGlobalMemory: true,
      uiControlEnabled: true,
      sessionMemory: [],
      messages: [
        {
          id: "user-1",
          taskId: "task-1",
          role: "user",
          content: "First request",
          createdAt: 1,
        },
        {
          id: "agent-1-preview",
          taskId: "task-1",
          role: "agent",
          content: "Preview",
          createdAt: 2,
        },
        {
          id: "agent-1-final",
          taskId: "task-1",
          role: "agent",
          content: "Final answer",
          createdAt: 3,
        },
      ],
    });
    const uiControl = {
      available: true,
      platform: "windows" as const,
      supportsScreenshots: true,
      supportsWindowEnumeration: true,
      supportsInput: true,
      supportsWindowHandles: true,
    };

    const context = createConversationContextFromSession(
      session,
      false,
      uiControl,
    );

    expect(context.history).toEqual([
      {
        role: "user",
        content: "First request",
        createdAt: 1,
      },
      {
        role: "assistant",
        content: "Final answer",
        createdAt: 3,
      },
    ]);
    expect(context.sessionMemoryEnabled).toBe(true);
    expect(context.globalMemoryEnabled).toBe(false);
    expect(context.uiControlEnabled).toBe(true);
    expect(context.uiControl).toEqual(uiControl);
  });

  it("limits conversation context to the configured latest messages", () => {
    const session = createSession({
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "First request",
          createdAt: 1,
        },
        {
          id: "agent-1",
          role: "agent",
          content: "First reply",
          createdAt: 2,
        },
        {
          id: "user-2",
          role: "user",
          content: "Second request",
          createdAt: 3,
        },
        {
          id: "agent-2",
          role: "agent",
          content: "Second reply",
          createdAt: 4,
        },
      ],
    });

    const context = createConversationContextFromSession(
      session,
      true,
      undefined,
      2,
    );

    expect(context.history).toEqual([
      {
        role: "user",
        content: "Second request",
        createdAt: 3,
      },
      {
        role: "assistant",
        content: "Second reply",
        createdAt: 4,
      },
    ]);
  });
});
