import { describe, expect, it } from "vitest";
import {
  applySessionRetentionPolicy,
  canDeleteSession,
  canDuplicateSession,
  createInitialShellState,
  createSession,
  getLatestRunningTaskId,
  isSessionWorkspaceLocked,
  normalizeTaskExecutionFileChange,
  normalizeShellState,
  recoverInactiveRunningTasks,
  recoverInterruptedTasksForLaunch,
  QUICK_VOICE_SESSION_KIND,
} from "./chat-session.model";
import {
  createMockExecutionFixture,
  createPreviewFixture,
} from "./preview/fixtures";
import { createInitialThinkingTrace } from "./task-thinking.model";

const SESSION_DAY_MS = 24 * 60 * 60 * 1_000;

describe("normalizeTaskExecutionFileChange", () => {
  it("rejects the removed legacy file-change shape", () => {
    expect(
      normalizeTaskExecutionFileChange({
        path: "src/source.ts",
        kind: "modified",
        additions: 1,
        deletions: 1,
      }),
    ).toBeUndefined();
  });
});

describe("normalizeShellState", () => {
  it("preserves the active timeout state across session restoration", () => {
    const normalized = normalizeShellState({
      activeSessionId: "timeout-session",
      sessions: [
        {
          id: "timeout-session",
          provider: "openai",
          workspace: null,
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: "running-trace",
              role: "agent",
              content: "running",
              source: {
                kind: "thinking",
                thinking: {
                  ...createInitialThinkingTrace("ask", 100),
                  lastActivityAt: 250,
                  timeout: {
                    startedAt: 150,
                    lastActivityAt: 250,
                    idleTimeoutMs: 1_000,
                    absoluteTimeoutMs: 5_000,
                  },
                },
              },
            },
          ],
        },
      ],
    });
    const source = normalized.sessions[0]?.messages[0]?.source;

    expect(source?.kind).toBe("thinking");
    if (source?.kind !== "thinking") {
      throw new Error("Expected a normalized thinking trace.");
    }

    expect(source.thinking.lastActivityAt).toBe(250);
    expect(source.thinking.timeout).toEqual({
      startedAt: 150,
      lastActivityAt: 250,
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 5_000,
    });
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

  it("repairs persisted execution contract data", () => {
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
              id: "legacy-execution",
              role: "agent",
              content: "legacy result",
              source: {
                kind: "execution",
                execution: {
                  task: "legacy execution",
                  mode: "safe",
                  status: "executed",
                  metadata: {
                    instructionResolutionId: "resolution-1",
                    instructionCanonicalDigest: "canonical-digest",
                    instructionDeliveryReceipts: [
                      {
                        receiptId: "receipt-1",
                        status: "delivered",
                        bodyStored: false,
                      },
                    ],
                  },
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
                        operation: "modified",
                        entryType: "text",
                        repositoryPath: "api\\service",
                        oldMode: "100644",
                        newMode: "100644",
                        lineAnalysis: {
                          state: "complete",
                          additions: 3.4,
                          deletions: -2,
                        },
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
                        operation: "unknown",
                      },
                    ],
                    totalFiles: 2_000_000,
                    additions: 3,
                    deletions: 0,
                    binaryFiles: 0,
                    gitlinkFiles: 0,
                    symlinkFiles: 0,
                    modeOnlyFiles: 0,
                    failedFiles: 0,
                    status: "complete",
                    attribution: "workspace-observed",
                    completeness: {
                      discovery: { state: "complete" },
                      startSnapshots: { state: "complete" },
                      finishSnapshots: { state: "complete" },
                      renameAnalysis: { state: "complete" },
                      lineAnalysis: { state: "complete" },
                      persistence: { state: "complete" },
                    },
                    repositoryCount: 2,
                    issues: [
                      {
                        stage: "discovery",
                        code: "scan-note",
                        message: "Repository discovery note.",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    });
    const messages = normalized.sessions[0]?.messages ?? [];
    const executionSource = messages[0]?.source;

    expect(executionSource).toMatchObject({
      kind: "execution",
      execution: {
        mode: "ask",
        status: "executed",
        metadata: {
          instructionResolutionId: "resolution-1",
          instructionCanonicalDigest: "canonical-digest",
          instructionDeliveryReceipts: [
            {
              receiptId: "receipt-1",
              status: "delivered",
              bodyStored: false,
            },
          ],
        },
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
              operation: "modified",
              entryType: "text",
              repositoryPath: "api/service",
              oldMode: "100644",
              newMode: "100644",
              lineAnalysis: {
                state: "complete",
                additions: 3,
                deletions: 0,
              },
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
          totalFiles: 2_000_000,
          additions: 3,
          deletions: 0,
          binaryFiles: 0,
          gitlinkFiles: 0,
          symlinkFiles: 0,
          modeOnlyFiles: 0,
          failedFiles: 0,
          status: "complete",
          completeness: {
            discovery: { state: "complete" },
            startSnapshots: { state: "complete" },
            finishSnapshots: { state: "complete" },
            renameAnalysis: { state: "complete" },
            lineAnalysis: { state: "complete" },
            persistence: { state: "complete" },
          },
          attribution: "workspace-observed",
          repositoryCount: 2,
          issues: [
            {
              stage: "discovery",
              code: "scan-note",
              message: "Repository discovery note.",
            },
          ],
        },
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
    expect(normalized.version).toBe(2);
    expect(
      normalized.sessions[0]?.messages[0]?.contextAttachments?.[0],
    ).toMatchObject({ source: "path" });
  });

  it("preserves the composer settings used by a sent message", () => {
    const normalized = normalizeShellState({
      activeSessionId: "message-settings-session",
      sessions: [
        {
          id: "message-settings-session",
          provider: "openai",
          model: "gpt-5.5",
          workspace: "C:\\Docs",
          createdAt: 1,
          updatedAt: 2,
          messages: [
            {
              id: "user-with-settings",
              role: "user",
              content: "Review the plan",
              settings: {
                workspace: "C:\\Docs",
                provider: "openai",
                model: "gpt-5.5",
                mode: "ask",
                reasoning: "high",
                sessionMemoryEnabled: false,
                useGlobalMemory: true,
                uiControlEnabled: true,
                promptEnhancementMode: "web-search",
                interviewEnabled: true,
              },
            },
          ],
        },
      ],
    });

    expect(normalized.sessions[0]?.messages[0]?.settings).toEqual({
      workspace: "C:\\Docs",
      provider: "openai",
      model: "gpt-5.5",
      mode: "ask",
      reasoning: "high",
      sessionMemoryEnabled: false,
      useGlobalMemory: true,
      uiControlEnabled: true,
      promptEnhancementMode: "web-search",
      interviewEnabled: true,
    });
  });

  it("migrates durable Media Studio attachments without inventing paths", () => {
    const normalized = normalizeShellState({
      version: 1,
      activeSessionId: "media-attachment-session",
      sessions: [
        {
          id: "media-attachment-session",
          provider: "openai",
          model: "gpt-5.5",
          workspace: "C:\\Project",
          createdAt: 1,
          updatedAt: 2,
          draftContextAttachments: [
            {
              id: "media-attachment",
              source: "media-asset",
              workspaceRoot: "C:\\Project",
              assetId: "asset:approved-image",
              kind: "image",
              name: "Approved cutout",
              displayName: "Approved cutout",
              rendition: "original",
              path: "media://must-not-survive",
            },
          ],
        },
      ],
    });

    expect(normalized.version).toBe(2);
    expect(normalized.sessions[0]?.draftContextAttachments).toEqual([
      {
        id: "media-attachment",
        source: "media-asset",
        workspaceRoot: "C:\\Project",
        assetId: "asset:approved-image",
        kind: "image",
        name: "Approved cutout",
        displayName: "Approved cutout",
        rendition: "original",
      },
    ]);
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

});
