import type { ConversationMemoryEntry } from "../../../../core/types.js";
import {
  createInitialShellState,
  createSession,
} from "../../chat-session.model.ts";
import { RUNNABLE_PROVIDER_ORDER } from "../../model-catalog";
import type {
  RuntimeProviderAvailability,
  RuntimeSnapshot,
  UserMemorySettings,
} from "../../runtime";
import {
  createMemorySummaryState,
  createProviderChooserState,
  filterSessions,
} from "./session-shell-view-model";
import {
  ALL_SESSION_PROJECTS_FILTER,
  createSessionExportPayload,
  createSessionHistoryIndex,
  duplicateSessionRecord,
  filterSessionHistoryIndex,
  importSessionsIntoShellState,
} from "./session-history-index";

const createRuntimeSnapshot = (
  overrides: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot => {
  const baseSnapshot: RuntimeSnapshot = {
    workspaceRoot: "c:/Development/machdoch",
    mode: "ask",
    defaultMode: "ask",
    provider: "openai",
    model: "gpt-5.5",
    reasoning: "default",
    defaultReasoning: "default",
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
  };

  return {
    ...baseSnapshot,
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

  it("filters sessions by multiple statuses including unread", () => {
    const runningSession = createSession({
      id: "running-session",
      updatedAt: 30,
      messages: [
        {
          id: "running-user",
          taskId: "running-task",
          role: "user",
          content: "Keep working",
          createdAt: 30,
        },
      ],
    });
    const unreadDoneSession = createSession({
      id: "unread-done-session",
      updatedAt: 20,
      lastReadAt: 5,
      messages: [
        {
          id: "unread-user",
          taskId: "unread-task",
          role: "user",
          content: "Finish this",
          createdAt: 10,
        },
        {
          id: "unread-agent",
          taskId: "unread-task",
          role: "agent",
          content: "Done",
          createdAt: 20,
          source: createExecutedMessageSource(),
        },
      ],
    });
    const readDoneSession = createSession({
      id: "read-done-session",
      updatedAt: 15,
      lastReadAt: 25,
      messages: [
        {
          id: "read-user",
          taskId: "read-task",
          role: "user",
          content: "Finish this too",
          createdAt: 12,
        },
        {
          id: "read-agent",
          taskId: "read-task",
          role: "agent",
          content: "Done",
          createdAt: 15,
          source: createExecutedMessageSource(),
        },
      ],
    });
    const emptySession = createSession({
      id: "empty-session",
      updatedAt: 10,
    });

    const matchingSessionIds = new Set(
      filterSessions(
        [readDoneSession, emptySession, runningSession, unreadDoneSession],
        "open",
        ["unread", "running"],
      ).map((session) => session.id),
    );

    expect(matchingSessionIds).toEqual(
      new Set(["running-session", "unread-done-session"]),
    );
  });

  it("indexes session history by text, tags, projects, and pin priority", () => {
    const timestamp = 1_713_260_000_000;
    const apiSession = createSession({
      id: "api-session",
      manualTitle: "API migration",
      workspace: "c:/Development/machdoch",
      pinnedAt: timestamp,
      updatedAt: timestamp - 100,
      tags: ["backend", "release"],
      messages: [
        {
          id: "api-user",
          role: "user",
          content: "Move the provider catalog into generated metadata",
        },
      ],
    });
    const uiSession = createSession({
      id: "ui-session",
      manualTitle: "Sidebar polish",
      workspace: "c:/Development/desktop",
      updatedAt: timestamp,
      tags: ["ui"],
      messages: [
        {
          id: "ui-user",
          role: "user",
          content: "Tighten the session sidebar controls",
        },
      ],
    });
    const index = createSessionHistoryIndex([uiSession, apiSession]);

    expect(index.tags.map((tag) => tag.label)).toEqual([
      "backend",
      "release",
      "ui",
    ]);
    expect(index.projects.map((project) => project.label)).toEqual([
      "desktop",
      "machdoch",
    ]);
    expect(
      filterSessionHistoryIndex(index, {
        scope: "open",
        status: "any",
        searchQuery: "provider metadata",
        projectFilter: ALL_SESSION_PROJECTS_FILTER,
        tagFilters: ["backend"],
      }).sessions.map((session) => session.id),
    ).toEqual(["api-session"]);
  });

  it("duplicates sessions and imports exported sessions with fresh ids", () => {
    const baseState = {
      ...createInitialShellState(),
      sessions: [
        createSession({
          id: "session-to-copy",
          manualTitle: "Copy source",
          tags: ["docs"],
          messages: [
            {
              id: "message-1",
              taskId: "task-1",
              role: "user" as const,
              content: "Write docs",
            },
          ],
        }),
      ],
      activeSessionId: "session-to-copy",
    };
    const duplicate = duplicateSessionRecord(baseState.sessions[0], "branch", 20);
    const payload = createSessionExportPayload(baseState, ["session-to-copy"], 30);
    const imported = importSessionsIntoShellState(baseState, payload, 40);

    expect(duplicate.id).not.toBe("session-to-copy");
    expect(duplicate.draft).toBe("");
    expect(duplicate.messages[0]?.id).not.toBe("message-1");
    expect(duplicate.messages[0]?.taskId).not.toBe("task-1");
    expect(imported.sessions).toHaveLength(2);
    expect(imported.sessions[0]?.id).not.toBe("session-to-copy");
    expect(imported.activeSessionId).toBe(imported.sessions[0]?.id);
  });

  it("falls back to the runnable provider order when desktop providers are still unconfigured", () => {
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
    expect(providerState.chooserProviders).toEqual(RUNNABLE_PROVIDER_ORDER);
    expect(providerState.hasAnyProvider).toBe(false);
  });

  it("includes configured external CLIs in Chat model choices", () => {
    const providerState = createProviderChooserState({
      isDesktop: true,
      runtimeSnapshot: createRuntimeSnapshot({
        providerAvailability: [
          { provider: "openai", configured: false },
          { provider: "anthropic", configured: false },
          { provider: "google", configured: false },
          { provider: "codex-cli", configured: true },
          { provider: "claude-cli", configured: true },
          { provider: "copilot-cli", configured: true },
        ],
      }),
      globalProviders: [
        { provider: "openai", configured: false },
        { provider: "anthropic", configured: false },
        { provider: "google", configured: false },
        { provider: "codex-cli", configured: true },
        { provider: "claude-cli", configured: true },
        { provider: "copilot-cli", configured: true },
      ],
    });

    expect(providerState.configuredProviders).toEqual([
      "codex-cli",
      "claude-cli",
      "copilot-cli",
    ]);
    expect(providerState.chooserProviders).toEqual([
      "codex-cli",
      "claude-cli",
      "copilot-cli",
    ]);
    expect(providerState.hasAnyProvider).toBe(true);
  });

  it("treats configured runnable external CLIs as available Chat providers", () => {
    const providerAvailability = [
      { provider: "openai", configured: false },
      { provider: "anthropic", configured: false },
      { provider: "google", configured: false },
      { provider: "codex-cli", configured: false },
      { provider: "claude-cli", configured: true },
      { provider: "copilot-cli", configured: true },
    ] satisfies RuntimeProviderAvailability[];
    const providerState = createProviderChooserState({
      isDesktop: true,
      runtimeSnapshot: createRuntimeSnapshot({ providerAvailability }),
      globalProviders: providerAvailability,
    });

    expect(providerState.configuredProviders).toEqual([
      "claude-cli",
      "copilot-cli",
    ]);
    expect(providerState.chooserProviders).toEqual([
      "claude-cli",
      "copilot-cli",
    ]);
    expect(providerState.hasAnyProvider).toBe(true);
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
