import { describe, expect, it } from "vitest";
import {
  applySessionRetentionPolicy,
  canArchiveSession,
  canDeleteSession,
  canDuplicateSession,
  canPinSession,
  createInitialShellState,
  createSession,
  createVisibleConversationMessages,
  getLatestCompletedSessionResponseAt,
  getLatestSessionUserRequestAt,
  getLatestRunningTaskId,
  getSessionOverviewStatus,
  hasUnreadCompletedSessionResponse,
  isSessionEmpty,
  isSessionWorkspaceLocked,
  markSessionRead,
  mergeRecentWorkspacesForPersistence,
  normalizeRecentWorkspaces,
  normalizeShellState,
  rememberRecentWorkspace,
  removeRecentWorkspace,
  recoverInactiveRunningTasks,
  recoverInterruptedTasksForLaunch,
  QUICK_VOICE_SESSION_KIND,
  sortSessionsByUpdatedAt,
} from "./chat-session.model";
import {
  createMockExecutionFixture,
  createPreviewFixture,
} from "./preview/fixtures";
import { createInitialThinkingTrace } from "./task-thinking.model";

const SESSION_DAY_MS = 24 * 60 * 60 * 1_000;

describe("normalizeShellState", () => {
  it("removes superseded thinking records that already have terminal output", () => {
    const normalized = normalizeShellState({
      activeSessionId: "terminal-session",
      sessions: [
        {
          id: "terminal-session",
          provider: "openai",
          workspace: null,
          createdAt: 1,
          updatedAt: 3,
          messages: [
            {
              id: "thinking",
              taskId: "task-1",
              role: "agent",
              content: "working",
              source: {
                kind: "thinking",
                thinking: createInitialThinkingTrace("ask", 1),
              },
            },
            {
              id: "execution",
              taskId: "task-1",
              role: "agent",
              content: "done",
              source: {
                kind: "execution",
                execution: createMockExecutionFixture("task"),
              },
            },
          ],
        },
      ],
    });

    expect(normalized.sessions[0]?.messages.map((message) => message.id)).toEqual([
      "execution",
    ]);
  });

  it("compacts completed thinking details while preserving running traces", () => {
    const createTrace = (status: "running" | "complete") => ({
      ...createInitialThinkingTrace("ask", 1),
      status,
      entries: Array.from({ length: 20 }, (_, index) => ({
        id: `entry-${index}`,
        label: "Progress",
        detail: `Entry ${index}`,
        tone: "info" as const,
        timestamp: index,
      })),
      actionOutputLines: Array.from({ length: 30 }, (_, index) => ({
        id: `line-${index}`,
        toolName: "shell",
        stream: "stdout" as const,
        text: `Line ${index}`,
        timestamp: index,
      })),
      timelineEvents: Array.from({ length: 50 }, (_, index) => ({
        id: `event-${index}`,
        kind: "state" as const,
        phase: "started" as const,
        label: "Progress",
        detail: `Event ${index}`,
        tone: "info" as const,
        timestamp: index,
        elapsedMs: index,
      })),
    });
    const normalized = normalizeShellState({
      activeSessionId: "trace-session",
      sessions: [
        {
          id: "trace-session",
          provider: "openai",
          workspace: null,
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: "complete-trace",
              role: "agent",
              content: "complete",
              source: { kind: "thinking", thinking: createTrace("complete") },
            },
            {
              id: "running-trace",
              role: "agent",
              content: "running",
              source: { kind: "thinking", thinking: createTrace("running") },
            },
          ],
        },
      ],
    });
    const completeTrace = normalized.sessions[0]?.messages[0]?.source;
    const runningTrace = normalized.sessions[0]?.messages[1]?.source;

    expect(completeTrace?.kind).toBe("thinking");
    expect(runningTrace?.kind).toBe("thinking");
    if (completeTrace?.kind !== "thinking" || runningTrace?.kind !== "thinking") {
      throw new Error("Expected normalized thinking traces.");
    }

    expect(completeTrace.thinking.entries).toHaveLength(8);
    expect(completeTrace.thinking.actionOutputLines).toHaveLength(20);
    expect(completeTrace.thinking.timelineEvents).toHaveLength(40);
    expect(runningTrace.thinking.entries).toHaveLength(20);
    expect(runningTrace.thinking.actionOutputLines).toHaveLength(30);
    expect(runningTrace.thinking.timelineEvents).toHaveLength(50);
  });

  it("repairs duplicate persisted message ids without dropping either message", () => {
    const normalized = normalizeShellState({
      activeSessionId: "duplicate-message-session",
      sessions: [
        {
          id: "duplicate-message-session",
          provider: "openai",
          model: "gpt-5.5",
          workspace: null,
          createdAt: 1,
          updatedAt: 2,
          messages: [
            { id: "shared-id", role: "user", content: "First", createdAt: 1 },
            { id: "shared-id", role: "agent", content: "Second", createdAt: 2 },
          ],
        },
      ],
    });

    expect(normalized.sessions[0]?.messages.map((message) => message.id)).toEqual([
      "shared-id",
      "shared-id-2",
    ]);
    expect(normalized.sessions[0]?.messages.map((message) => message.content)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("repairs invalid persisted sessions while preserving valid overrides", () => {
    const normalized = normalizeShellState({
      activeSessionId: "session-1",
      sessions: [
        null,
        {
          id: "session-1",
          provider: "invalid",
          model: "",
          mode: "auto",
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
      lastSelectedMode: "auto",
      lastSelectedProvider: "invalid",
      lastSelectedModelByProvider: {
        openai: "gpt-custom",
        google: "",
      },
      lastSelectedSessionMemoryEnabled: false,
      lastSelectedUseGlobalMemory: false,
      lastSelectedUiControlEnabled: true,
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
      mode: "machdoch",
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
    expect(normalized.lastSelectedMode).toBe("machdoch");
    expect(normalized.lastSelectedSessionMemoryEnabled).toBe(false);
    expect(normalized.lastSelectedUseGlobalMemory).toBe(false);
    expect(normalized.lastSelectedUiControlEnabled).toBe(true);
  });

  it("preserves persisted Codex CLI model selections", () => {
    const normalized = normalizeShellState({
      activeSessionId: "codex-session",
      sessions: [
        {
          id: "codex-session",
          provider: "codex-cli",
          model: "gpt-5.4-mini",
          workspace: "C:\\Project",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      lastSelectedProvider: "codex-cli",
      lastSelectedModelByProvider: {
        "codex-cli": "gpt-5.4-mini",
      },
    });

    expect(normalized.lastSelectedProvider).toBe("codex-cli");
    expect(normalized.lastSelectedModelByProvider["codex-cli"]).toBe(
      "gpt-5.4-mini",
    );
    expect(normalized.sessions[0]).toMatchObject({
      id: "codex-session",
      provider: "codex-cli",
      model: "gpt-5.4-mini",
    });
  });

  it("normalizes recent workspaces as a unique latest-first list", () => {
    expect(
      normalizeRecentWorkspaces([
        " C:\\Docs ",
        "c:/docs",
        "",
        "/tmp/one",
        "/tmp/two",
        "/tmp/three",
        "/tmp/four",
        "/tmp/five",
        "/tmp/six",
        "/tmp/seven",
        "/tmp/eight",
        "/tmp/nine",
        "/tmp/ten",
      ]),
    ).toEqual([
      "C:\\Docs",
      "/tmp/one",
      "/tmp/two",
      "/tmp/three",
      "/tmp/four",
      "/tmp/five",
      "/tmp/six",
      "/tmp/seven",
      "/tmp/eight",
      "/tmp/nine",
    ]);

    expect(
      rememberRecentWorkspace(["C:\\Docs", "/tmp/one"], "/tmp/two"),
    ).toEqual(["/tmp/two", "C:\\Docs", "/tmp/one"]);
    expect(
      rememberRecentWorkspace(["C:\\Docs", "/tmp/one"], "c:/docs"),
    ).toEqual(["c:/docs", "/tmp/one"]);
    expect(
      removeRecentWorkspace(["C:\\Docs", "/tmp/one"], "c:/docs"),
    ).toEqual(["/tmp/one"]);
  });

  it("locks normal session workspaces after the first user message", () => {
    expect(isSessionWorkspaceLocked(createSession())).toBe(false);
    expect(
      isSessionWorkspaceLocked(
        createSession({
          messages: [
            {
              id: "agent-only",
              role: "agent",
              content: "Hello",
            },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isSessionWorkspaceLocked(
        createSession({
          messages: [
            {
              id: "user-1",
              role: "user",
              content: "Do the thing",
            },
          ],
        }),
      ),
    ).toBe(true);
    expect(
      isSessionWorkspaceLocked(
        createSession({
          specialSession: QUICK_VOICE_SESSION_KIND,
          messages: [
            {
              id: "quick-user-1",
              role: "user",
              content: "Do the thing",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("preserves local recent workspace removals during persistence merges", () => {
    expect(
      mergeRecentWorkspacesForPersistence(
        ["C:\\Docs"],
        ["C:\\Docs", "C:\\Old"],
        ["C:\\New", "C:\\Docs", "C:\\Old"],
      ),
    ).toEqual(["C:\\Docs", "C:\\New"]);
  });

  it("derives recent workspaces from legacy sessions", () => {
    const normalized = normalizeShellState({
      activeSessionId: "newer-session",
      sessions: [
        {
          id: "older-session",
          provider: "openai",
          model: "gpt-custom",
          workspace: "C:\\Older",
          createdAt: 1,
          updatedAt: 10,
        },
        {
          id: "newer-session",
          provider: "openai",
          model: "gpt-custom",
          workspace: "C:\\Newer",
          createdAt: 2,
          updatedAt: 20,
        },
      ],
    });

    expect(normalized.recentWorkspaces).toEqual(["C:\\Newer", "C:\\Older"]);
  });

  it("repairs legacy persisted task message sources", () => {
    const normalized = normalizeShellState({
      activeSessionId: "legacy-session",
      sessions: [
        {
          id: "legacy-session",
          provider: "openai",
          model: "gpt-5.5",
          workspace: null,
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: "legacy-preview",
              role: "agent",
              content: "legacy preview",
              source: {
                kind: "preview",
                preview: {
                  task: "legacy task",
                  mode: "auto",
                  suggestedTools: ["filesystem", "unknown-tool"],
                  invokedPrompt: {
                    name: "fix",
                    tools: ["shell", "unknown-tool"],
                  },
                  applicableInstructions: [
                    {
                      name: "AGENTS.md",
                    },
                  ],
                },
              },
            },
            {
              id: "legacy-execution",
              role: "agent",
              content: "legacy result",
              source: {
                kind: "execution",
                execution: {
                  task: "legacy execution",
                  mode: "safe",
                  status: "executed",
                  outputSections: [
                    {
                      title: "Output",
                    },
                  ],
                  response: {
                    markdown: "done",
                    relatedFiles: [
                      {
                        path: "README.md",
                      },
                    ],
                  },
                  fileChanges: {
                    files: [
                      {
                        path: "src/source.ts",
                        kind: "modified",
                        repositoryPath: "api\\service",
                        additions: 3.4,
                        deletions: -2,
                        ranges: [
                          {
                            oldStart: 4,
                            oldLines: 1,
                            newStart: 4,
                            newLines: 3,
                          },
                          {
                            oldStart: "invalid",
                          },
                        ],
                      },
                      {
                        path: "src/invalid.ts",
                        kind: "unknown",
                      },
                    ],
                    totalFiles: 2,
                    additions: 3,
                    deletions: 0,
                    binaryFiles: 0,
                    lineCountsComplete: true,
                    coverage: "complete",
                    truncated: false,
                    repositoryCount: 2,
                    warnings: ["A bounded warning."],
                  },
                },
              },
            },
            {
              id: "legacy-thinking",
              role: "agent",
              content: "legacy thinking",
              source: {
                kind: "thinking",
                thinking: {
                  status: "loading",
                  mode: "auto",
                  entries: [
                    {
                      label: "Running",
                      tone: "unknown",
                    },
                  ],
                  actionOutputLines: [
                    {
                      stream: "stderr",
                      text: "failed",
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    });
    const messages = normalized.sessions[0]?.messages ?? [];
    const previewSource = messages[0]?.source;
    const executionSource = messages[1]?.source;
    const thinkingSource = messages[2]?.source;

    expect(previewSource).toMatchObject({
      kind: "preview",
      preview: {
        mode: "machdoch",
        summary: "Task preview restored from persisted session.",
        suggestedTools: ["filesystem"],
        warnings: [],
        notes: [],
        steps: [],
        customizationCounts: {
          instructions: 1,
          prompts: 0,
          skills: 0,
        },
      },
    });
    expect(executionSource).toMatchObject({
      kind: "execution",
      execution: {
        mode: "ask",
        status: "executed",
        summary: "Task result restored from persisted session.",
        executedTools: [],
        outputSections: [
          {
            title: "Output",
            lines: [],
          },
        ],
        response: {
          markdown: "done",
          relatedFiles: [
            {
              path: "README.md",
              description: "",
            },
          ],
        },
        fileChanges: {
          files: [
            {
              path: "src/source.ts",
              kind: "modified",
              repositoryPath: "api/service",
              additions: 3,
              deletions: 0,
              ranges: [
                {
                  oldStart: 4,
                  oldLines: 1,
                  newStart: 4,
                  newLines: 3,
                },
              ],
            },
          ],
          totalFiles: 2,
          additions: 3,
          deletions: 0,
          binaryFiles: 0,
          lineCountsComplete: true,
          coverage: "complete",
          truncated: true,
          attribution: "workspace-observed",
          repositoryCount: 2,
          warnings: ["A bounded warning."],
        },
      },
    });
    expect(thinkingSource).toMatchObject({
      kind: "thinking",
      thinking: {
        status: "complete",
        mode: "machdoch",
        entries: [
          {
            label: "Running",
            detail: "",
            tone: "info",
          },
        ],
        actionOutputLines: [
          {
            stream: "stderr",
            text: "failed",
          },
        ],
      },
    });
  });

  it("preserves valid sent-message context attachments", () => {
    const normalized = normalizeShellState({
      activeSessionId: "attachment-session",
      sessions: [
        {
          id: "attachment-session",
          provider: "openai",
          model: "gpt-5.5",
          workspace: null,
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: "user-with-attachment",
              role: "user",
              content: "Describe this image",
              contextAttachments: [
                {
                  id: "screen-attachment",
                  path: "C:\\Docs\\screen.png",
                  kind: "image",
                  name: "screen.png",
                  parent: "C:\\Docs",
                },
                {
                  path: "",
                  kind: "file",
                  name: "invalid.txt",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(normalized.sessions[0]?.messages[0]).toMatchObject({
      id: "user-with-attachment",
      contextAttachments: [
        {
          id: "screen-attachment",
          path: "C:\\Docs\\screen.png",
          kind: "image",
          name: "screen.png",
          parent: "C:\\Docs",
        },
      ],
    });
  });

  it("repairs persisted context packs", () => {
    const normalized = normalizeShellState({
      activeSessionId: "pack-session",
      sessions: [
        {
          id: "pack-session",
          provider: "openai",
          model: "gpt-5.5",
          workspace: "C:\\Project",
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      contextPacks: [
        null,
        {
          id: "pack-1",
          workspace: "C:\\Project",
          name: "  Review   PR  ",
          instructions: " Focus on regressions. ",
          prompt: " Review staged changes. ",
          provider: "invalid",
          model: "gpt-5.5",
          mode: "auto",
          createdAt: -1,
          updatedAt: 12,
          lastUsedAt: 18,
          useCount: 3,
          variables: [
            {
              name: "target file",
              defaultValue: " src/App.tsx ",
            },
            "{ticket_id}",
            {
              name: "target file",
            },
          ],
          trigger: {
            phrases: [" review   pr ", "review pr"],
            pathPatterns: ["src/**/*.tsx"],
            autoApply: true,
          },
          contextAttachments: [
            {
              path: "C:\\Project\\plan.md",
              kind: "file",
              name: "",
            },
            {
              path: "",
              kind: "file",
              name: "invalid.md",
            },
          ],
        },
      ],
    });

    expect(normalized.contextPacks).toMatchObject([
      {
        id: "pack-1",
        workspace: "C:\\Project",
        name: "Review PR",
        instructions: "Focus on regressions.",
        prompt: "Review staged changes.",
        mode: "machdoch",
        createdAt: 0,
        updatedAt: 12,
        lastUsedAt: 18,
        useCount: 3,
        variables: [
          {
            name: "target_file",
            defaultValue: "src/App.tsx",
          },
          {
            name: "ticket_id",
          },
        ],
        trigger: {
          phrases: ["review pr"],
          pathPatterns: ["src/**/*.tsx"],
          autoApply: true,
        },
        contextAttachments: [
          {
            path: "C:\\Project\\plan.md",
            kind: "file",
            name: "plan.md",
          },
        ],
      },
    ]);
    expect(normalized.contextPacks[0]?.provider).toBeUndefined();
    expect(normalized.contextPacks[0]?.model).toBeUndefined();
  });

  it("bounds persisted message count, message text, and prompt history", () => {
    const oversizedContent = "x".repeat(140_000);
    const normalized = normalizeShellState({
      activeSessionId: "bounded-session",
      sessions: [
        {
          id: "bounded-session",
          provider: "openai",
          model: "gpt-5.5",
          workspace: null,
          createdAt: 1,
          updatedAt: 2,
          messages: Array.from({ length: 401 }, (_, index) => ({
            id: `message-${index}`,
            role: index % 2 === 0 ? "user" : "agent",
            content: index === 400 ? oversizedContent : `Message ${index}`,
          })),
          promptHistory: Array.from(
            { length: 120 },
            (_, index) => `${index}:${"p".repeat(9_000)}`,
          ),
        },
      ],
    });
    const session = normalized.sessions[0];
    const finalMessage = session?.messages.at(-1);

    expect(session?.messages).toHaveLength(400);
    expect(session?.messages[0]?.id).toBe("message-1");
    expect(finalMessage?.content).toHaveLength(128_000);
    expect(finalMessage?.content).toContain("[content truncated by machdoch");
    expect(session?.promptHistory).toHaveLength(100);
    expect(session?.promptHistory[0]).toHaveLength(8_000);
  });
});

describe("applySessionRetentionPolicy", () => {
  it("archives inactive open sessions after the configured duration", () => {
    const baseState = createInitialShellState();
    const now = Date.now();
    const staleSession = createSession({
      id: "stale-open-session",
      updatedAt: now - 8 * SESSION_DAY_MS,
      manualTitle: "Stale open session",
      messages: [
        {
          id: "stale-open-user",
          taskId: "stale-open-task",
          role: "user",
          content: "Summarize the stale workspace",
          createdAt: now - 8 * SESSION_DAY_MS - 1_000,
        },
        {
          id: "stale-open-agent",
          taskId: "stale-open-task",
          role: "agent",
          content: "Stale workspace summarized.",
          createdAt: now - 8 * SESSION_DAY_MS,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("Summarize the stale workspace"),
          },
        },
      ],
    });
    const state = {
      ...baseState,
      activeSessionId: staleSession.id,
      sessions: [staleSession],
    };

    const nextState = applySessionRetentionPolicy(
      state,
      {
        inactiveSessionArchiveDays: 7,
        archivedSessionRetentionDays: 7,
      },
      now,
    );

    expect(nextState).not.toBe(state);
    expect(nextState.activeSessionId).toBe(staleSession.id);
    expect(nextState.sessions).toHaveLength(1);
    expect(nextState.sessions[0]).toMatchObject({
      id: staleSession.id,
      archivedAt: now,
      updatedAt: staleSession.updatedAt,
    });
  });

  it("does not archive empty sessions", () => {
    const baseState = createInitialShellState();
    const now = Date.now();
    const emptySession = createSession({
      id: "empty-open-session",
      updatedAt: now - 8 * SESSION_DAY_MS,
      manualTitle: "Empty open session",
    });
    const state = {
      ...baseState,
      activeSessionId: emptySession.id,
      sessions: [emptySession],
    };

    const nextState = applySessionRetentionPolicy(
      state,
      {
        inactiveSessionArchiveDays: 7,
        archivedSessionRetentionDays: 7,
      },
      now,
    );

    expect(nextState).toBe(state);
  });

  it("deletes expired archived sessions and falls back to a remaining session", () => {
    const baseState = createInitialShellState();
    const now = Date.now();
    const expiredArchivedSession = createSession({
      id: "expired-archived-session",
      archivedAt: now - 8 * SESSION_DAY_MS,
      updatedAt: now - 8 * SESSION_DAY_MS,
      manualTitle: "Expired archived session",
    });
    const freshSession = createSession({
      id: "fresh-session",
      updatedAt: now - 10_000,
      manualTitle: "Fresh session",
    });
    const state = {
      ...baseState,
      activeSessionId: expiredArchivedSession.id,
      sessions: [expiredArchivedSession, freshSession],
    };

    const nextState = applySessionRetentionPolicy(
      state,
      {
        inactiveSessionArchiveDays: 7,
        archivedSessionRetentionDays: 7,
      },
      now,
    );

    expect(nextState.sessions.map((session) => session.id)).toEqual([
      freshSession.id,
    ]);
    expect(nextState.activeSessionId).toBe(freshSession.id);
  });

  it("does not archive or delete Quick Chat", () => {
    const baseState = createInitialShellState();
    const now = Date.now();
    const quickSession = createSession({
      id: "quick-retention-session",
      specialSession: QUICK_VOICE_SESSION_KIND,
      archivedAt: now - 30 * SESSION_DAY_MS,
      updatedAt: now - 30 * SESSION_DAY_MS,
    });
    const state = {
      ...baseState,
      activeSessionId: quickSession.id,
      sessions: [quickSession],
    };

    expect(
      applySessionRetentionPolicy(
        state,
        {
          inactiveSessionArchiveDays: 7,
          archivedSessionRetentionDays: 7,
        },
        now,
      ),
    ).toBe(state);
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

  it("marks blocked execution updates as failed", () => {
    const session = createSession({
      messages: [
        {
          id: "user-task-1",
          taskId: "task-1",
          role: "user",
          content: "needs machdoch mode",
          createdAt: 1,
        },
        {
          id: "agent-task-1",
          taskId: "task-1",
          role: "agent",
          content: "blocked",
          createdAt: 2,
          source: {
            kind: "execution",
            execution: {
              ...createMockExecutionFixture("scan this workspace"),
              status: "blocked",
            },
          },
        },
      ],
    });

    expect(getSessionOverviewStatus(session)).toBe("failed");
  });

  it("tracks unread completed responses until the session is read", () => {
    const session = createSession({
      updatedAt: 20,
      lastReadAt: 10,
      messages: [
        {
          id: "user-task",
          taskId: "task-1",
          role: "user",
          content: "finish this task",
          createdAt: 10,
        },
        {
          id: "agent-task",
          taskId: "task-1",
          role: "agent",
          content: "done",
          createdAt: 20,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("finish this task"),
          },
        },
      ],
    });

    expect(getLatestCompletedSessionResponseAt(session)).toBe(20);
    expect(hasUnreadCompletedSessionResponse(session)).toBe(true);

    const readSession = markSessionRead(session, 15);

    expect(readSession.lastReadAt).toBe(20);
    expect(hasUnreadCompletedSessionResponse(readSession)).toBe(false);
  });

  it("keeps session ordering based on the latest user request instead of progress", () => {
    const unreadSession = createSession({
      id: "unread-session",
      updatedAt: 900,
      lastReadAt: 200,
      messages: [
        {
          id: "unread-user",
          taskId: "unread-task",
          role: "user",
          content: "finish in the background",
          createdAt: 300,
        },
        {
          id: "unread-agent",
          taskId: "unread-task",
          role: "agent",
          content: "done",
          createdAt: 900,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("finish in the background"),
          },
        },
      ],
    });
    const runningSession = createSession({
      id: "running-session",
      updatedAt: 800,
      messages: [
        {
          id: "running-user",
          taskId: "running-task",
          role: "user",
          content: "keep working",
          createdAt: 800,
        },
      ],
    });
    const recentRequestedSession = createSession({
      id: "recent-requested-session",
      updatedAt: 1_200,
      messages: [
        {
          id: "recent-user",
          taskId: "recent-task",
          role: "user",
          content: "recent request",
          createdAt: 700,
        },
        {
          id: "recent-agent",
          taskId: "recent-task",
          role: "agent",
          content: "done",
          createdAt: 1_200,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("recent request"),
          },
        },
      ],
    });
    const olderRequestedSession = createSession({
      id: "older-requested-session",
      updatedAt: 1_300,
      messages: [
        {
          id: "older-user",
          taskId: "older-task",
          role: "user",
          content: "older request",
          createdAt: 600,
        },
        {
          id: "older-agent",
          taskId: "older-task",
          role: "agent",
          content: "done later",
          createdAt: 1_300,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("older request"),
          },
        },
      ],
    });

    expect(getLatestSessionUserRequestAt(olderRequestedSession)).toBe(600);
    expect(
      sortSessionsByUpdatedAt([
        olderRequestedSession,
        recentRequestedSession,
        runningSession,
        unreadSession,
      ]).map((session) => session.id),
    ).toEqual([
      "running-session",
      "recent-requested-session",
      "older-requested-session",
      "unread-session",
    ]);
  });

  it("does not reorder empty sessions when their drafts update", () => {
    const older = createSession({
      id: "older-empty",
      createdAt: 100,
      updatedAt: 10_000,
      draft: "new typing",
    });
    const newer = createSession({
      id: "newer-empty",
      createdAt: 200,
      updatedAt: 200,
    });

    expect(getLatestSessionUserRequestAt(older)).toBe(100);
    expect(
      sortSessionsByUpdatedAt([older, newer]).map((session) => session.id),
    ).toEqual(["newer-empty", "older-empty"]);
  });

  it("keeps unpinned empty sessions directly after pinned sessions", () => {
    const now = Date.now();
    const pinnedDoneSession = createSession({
      id: "pinned-done-session",
      pinnedAt: now - 1_000,
      updatedAt: now - 5_000,
      messages: [
        {
          id: "pinned-user",
          taskId: "pinned-task",
          role: "user",
          content: "Finish pinned task",
          createdAt: now - 5_100,
        },
        {
          id: "pinned-agent",
          taskId: "pinned-task",
          role: "agent",
          content: "Pinned task finished.",
          createdAt: now - 5_000,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("Finish pinned task"),
          },
        },
      ],
    });
    const emptySession = createSession({
      id: "empty-session",
      updatedAt: now,
    });
    const runningSession = createSession({
      id: "running-session",
      updatedAt: now - 100,
      messages: [
        {
          id: "running-user",
          taskId: "running-task",
          role: "user",
          content: "Keep running",
          createdAt: now - 100,
        },
      ],
    });
    const doneSession = createSession({
      id: "done-session",
      updatedAt: now - 50,
      messages: [
        {
          id: "done-user",
          taskId: "done-task",
          role: "user",
          content: "Finish normal task",
          createdAt: now - 60,
        },
        {
          id: "done-agent",
          taskId: "done-task",
          role: "agent",
          content: "Normal task finished.",
          createdAt: now - 50,
          source: {
            kind: "execution",
            execution: createMockExecutionFixture("Finish normal task"),
          },
        },
      ],
    });

    expect(
      sortSessionsByUpdatedAt([
        doneSession,
        runningSession,
        emptySession,
        pinnedDoneSession,
      ]).map((session) => session.id),
    ).toEqual([
      "pinned-done-session",
      "empty-session",
      "done-session",
      "running-session",
    ]);
  });

  it("does not allow archive, duplicate, or pin actions for empty sessions", () => {
    const emptySession = createSession({ id: "empty-action-session" });

    expect(isSessionEmpty(emptySession)).toBe(true);
    expect(canArchiveSession(emptySession)).toBe(false);
    expect(canDuplicateSession(emptySession)).toBe(false);
    expect(canPinSession(emptySession)).toBe(false);
  });
});

describe("getLatestRunningTaskId", () => {
  it("prevents deleting or cloning a running session", () => {
    const taskId = "guarded-running-task";
    const runningSession = createSession({
      messages: [
        {
          id: `${taskId}-user`,
          taskId,
          role: "user",
          content: "Keep this task alive",
          createdAt: 1,
        },
      ],
    });

    expect(canDeleteSession(runningSession)).toBe(false);
    expect(canDuplicateSession(runningSession)).toBe(false);
  });

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

  it("does not treat stale thinking after execution as a running task", () => {
    const session = createSession({
      messages: [
        {
          id: "user-task-1",
          taskId: "task-1",
          role: "user",
          content: "finish this task",
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
            execution: createMockExecutionFixture("finish this task"),
          },
        },
        {
          id: "late-thinking-task-1",
          taskId: "task-1",
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

    expect(getLatestRunningTaskId(session)).toBeNull();
    expect(getSessionOverviewStatus(session)).toBe("done");
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
          content: "blocked by ask mode",
          createdAt: 5,
        },
        {
          id: "task-3-agent",
          taskId: "task-3",
          role: "agent",
          content: "blocked",
          createdAt: 6,
          source: {
            kind: "execution",
            execution: {
              ...createMockExecutionFixture("blocked by ask mode"),
              status: "blocked",
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
    expect(getSessionOverviewStatus(recoveredSession!)).toBe("failed");

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

  it("keeps persisted running tasks alive when the desktop runtime still reports them active", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-with-live-task",
      messages: [
        {
          id: "task-1-user",
          taskId: "task-1",
          role: "user",
          content: "answer the live task",
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
      ],
    });

    const recovered = recoverInterruptedTasksForLaunch(
      {
        ...baseState,
        activeSessionId: session.id,
        sessions: [session],
      },
      "launch-live",
      100,
      ["task-1"],
    );
    const recoveredSession = recovered.sessions[0];

    expect(recoveredSession).toBeDefined();
    expect(getSessionOverviewStatus(recoveredSession!)).toBe("running");
    expect(recoveredSession!.messages.map((message) => message.id)).toEqual([
      "task-1-user",
      "task-1-thinking",
    ]);
  });

  it("marks inactive running tasks as crashed without changing launch recovery state", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-with-inactive-task",
      messages: [
        {
          id: "task-1-user",
          taskId: "task-1",
          role: "user",
          content: "answer the inactive task",
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
      ],
    });

    const recovered = recoverInactiveRunningTasks(
      {
        ...baseState,
        activeSessionId: session.id,
        lastRecoveredLaunchId: "launch-current",
        sessions: [session],
      },
      [],
      100,
    );
    const recoveredSession = recovered.sessions[0];

    expect(recovered.lastRecoveredLaunchId).toBe("launch-current");
    expect(recoveredSession).toBeDefined();
    expect(getSessionOverviewStatus(recoveredSession!)).toBe("crashed");
    expect(
      recoveredSession!.messages.some(
        (message) => message.id === "task-1-thinking",
      ),
    ).toBe(false);
    expect(recoveredSession!.messages.at(-1)?.content).toBe(
      "**Task crashed.** machdoch no longer sees an active desktop task before a final response was produced, so it was marked as crashed.",
    );
  });

  it("marks stale running tasks even after the launch was already recovered when no active task remains", () => {
    const baseState = createInitialShellState();
    const session = createSession({
      id: "session-with-same-launch-stale-task",
      messages: [
        {
          id: "task-1-user",
          taskId: "task-1",
          role: "user",
          content: "answer the stale task",
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
      ],
    });

    const recovered = recoverInterruptedTasksForLaunch(
      {
        ...baseState,
        activeSessionId: session.id,
        lastRecoveredLaunchId: "launch-current",
        sessions: [session],
      },
      "launch-current",
      100,
      [],
    );
    const recoveredSession = recovered.sessions[0];

    expect(recoveredSession).toBeDefined();
    expect(getSessionOverviewStatus(recoveredSession!)).toBe("crashed");
    expect(
      recoveredSession!.messages.some(
        (message) => message.id === "task-1-thinking",
      ),
    ).toBe(false);
    expect(
      recoveredSession!.messages.filter((message) =>
        message.content.startsWith("**Task crashed.**"),
      ),
    ).toHaveLength(1);
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
  it("keeps non-preview messages in order and replaces thinking with terminal output", () => {
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

  it("keeps the terminal response visible when stale thinking arrives later", () => {
    const visibleMessages = createVisibleConversationMessages([
      {
        id: "user-task-1",
        taskId: "task-1",
        role: "user",
        content: "first request",
      },
      {
        id: "execution-task-1",
        taskId: "task-1",
        role: "agent",
        content: "final answer",
        source: {
          kind: "execution",
          execution: createMockExecutionFixture("scan this workspace"),
        },
      },
      {
        id: "late-thinking-task-1",
        taskId: "task-1",
        role: "agent",
        content: "late progress update",
        source: {
          kind: "thinking",
          thinking: createInitialThinkingTrace("ask", 2),
        },
      },
    ]);

    expect(visibleMessages.map((message) => message.id)).toEqual([
      "user-task-1",
      "execution-task-1",
    ]);
  });

  it("keeps the latest thinking update visible until a terminal response exists", () => {
    const visibleMessages = createVisibleConversationMessages([
      {
        id: "user-task-1",
        taskId: "task-1",
        role: "user",
        content: "first request",
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
        id: "latest-thinking-task-1",
        taskId: "task-1",
        role: "agent",
        content: "still thinking",
        source: {
          kind: "thinking",
          thinking: createInitialThinkingTrace("ask", 2),
        },
      },
    ]);

    expect(visibleMessages.map((message) => message.id)).toEqual([
      "user-task-1",
      "latest-thinking-task-1",
    ]);
  });

  it("keeps multiple intentional terminal messages for the same task", () => {
    const visibleMessages = createVisibleConversationMessages([
      {
        id: "user-task-1",
        taskId: "task-1",
        role: "user",
        content: "first request",
      },
      {
        id: "execution-task-1-part-1",
        taskId: "task-1",
        role: "agent",
        content: "first result",
        source: {
          kind: "execution",
          execution: createMockExecutionFixture("first request"),
        },
      },
      {
        id: "execution-task-1-part-2",
        taskId: "task-1",
        role: "agent",
        content: "follow-up result",
        source: {
          kind: "execution",
          execution: createMockExecutionFixture("first request"),
        },
      },
    ]);

    expect(visibleMessages.map((message) => message.id)).toEqual([
      "user-task-1",
      "execution-task-1-part-1",
      "execution-task-1-part-2",
    ]);
  });
});
