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
    enabledTools: ["filesystem", "shell"],
    provider: "openai",
    model: "gpt-5.4-mini",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability: [],
    webSearch: {
      activeProvider: "none",
      providerAvailability: [],
    },
    ...overrides,
  };
};

describe("session shell helpers", () => {
  it("uses the session override before the workspace default mode", () => {
    expect(
      getEffectiveSessionMode("auto", createRuntimeSnapshot({ mode: "safe" })),
    ).toBe("auto");
    expect(
      getEffectiveSessionMode(
        undefined,
        createRuntimeSnapshot({ mode: "safe" }),
      ),
    ).toBe("safe");
    expect(getEffectiveSessionMode(undefined, null)).toBe("ask");
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

    const context = createConversationContextFromSession(session, false);

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
  });
});
