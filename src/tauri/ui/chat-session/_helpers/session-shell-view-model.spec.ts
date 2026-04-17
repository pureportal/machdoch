import type { ConversationMemoryEntry } from "../../../../core/types.js";
import { createSession } from "../../chat-session.model.ts";
import type { RuntimeSnapshot, UserMemorySettings } from "../../runtime";
import {
  createMemorySummaryState,
  createProviderChooserState,
  filterSessions,
} from "./session-shell-view-model";

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

const createMemoryEntry = (
  id: string,
  content: string,
): ConversationMemoryEntry => {
  return {
    id,
    scope: "session",
    content,
    createdAt: 1,
    updatedAt: 1,
  };
};

const createUserMemorySettings = (
  overrides: Partial<UserMemorySettings> = {},
): UserMemorySettings => {
  return {
    globalEnabled: false,
    entries: [],
    ...overrides,
  };
};

const createExecutedMessageSource = () => {
  return {
    kind: "execution" as const,
    execution: {
      task: "Refactor this",
      mode: "ask" as const,
      status: "executed" as const,
      summary: "Done",
      executedTools: [],
      outputSections: [],
    },
  };
};

describe("session shell view model helpers", () => {
  it("filters sessions by scope and overview status", () => {
    const doneSession = createSession({
      messages: [
        {
          id: "user-1",
          taskId: "task-1",
          role: "user",
          content: "Refactor this",
          createdAt: 1,
        },
        {
          id: "agent-1",
          taskId: "task-1",
          role: "agent",
          content: "Done",
          createdAt: 2,
          source: createExecutedMessageSource(),
        },
      ],
    });
    const archivedDoneSession = {
      ...doneSession,
      id: "archived-done",
      archivedAt: 3,
    };
    const emptySession = createSession({ id: "empty-session" });

    expect(
      filterSessions(
        [doneSession, archivedDoneSession, emptySession],
        "open",
        "done",
      ).map((session) => session.id),
    ).toEqual([doneSession.id]);

    expect(
      filterSessions(
        [doneSession, archivedDoneSession, emptySession],
        "archived",
        "done",
      ).map((session) => session.id),
    ).toEqual([archivedDoneSession.id]);
  });

  it("falls back to the supported provider order when desktop providers are still unconfigured", () => {
    const providerState = createProviderChooserState({
      isDesktop: true,
      runtimeSnapshot: createRuntimeSnapshot({
        providerAvailability: [
          { provider: "openai", configured: false },
          { provider: "anthropic", configured: false },
          { provider: "google", configured: false },
        ],
      }),
      globalProviders: [
        { provider: "openai", configured: false },
        { provider: "anthropic", configured: false },
        { provider: "google", configured: false },
      ],
    });

    expect(providerState.configuredProviders).toEqual([]);
    expect(providerState.chooserProviders).toEqual([
      "openai",
      "anthropic",
      "google",
    ]);
    expect(providerState.hasAnyProvider).toBe(false);
  });

  it("derives composer memory summaries from session and global memory state", () => {
    const session = createSession({
      workspace: "c:/Development/machdoch",
      sessionMemoryEnabled: true,
      useGlobalMemory: true,
      sessionMemory: [
        createMemoryEntry("session-1", "prefers terse summaries"),
      ],
    });

    const summary = createMemorySummaryState({
      session,
      userMemorySettings: createUserMemorySettings({
        globalEnabled: true,
        entries: [createMemoryEntry("global-1", "user likes dark mode")],
      }),
    });

    expect(summary.composerWorkspaceLabel).toBe("machdoch");
    expect(summary.sessionMemoryDescription).toBe(
      "1 saved fact available in this session.",
    );
    expect(summary.globalMemoryDescription).toBe(
      "1 saved fact available across sessions.",
    );
    expect(summary.isGlobalMemoryAvailable).toBe(true);
    expect(summary.isGlobalMemoryActive).toBe(true);
  });
});
