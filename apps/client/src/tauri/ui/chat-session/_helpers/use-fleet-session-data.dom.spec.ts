// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFleetSessionData } from "./use-fleet-session-data";
import {
  createInitialShellState,
  createSession,
  type ChatSessionMessage,
} from "../../chat-session.model";
import type { ProductSession } from "@machdoch/fleet-protocol";
import { ALL_SESSION_PROJECTS_FILTER } from "@machdoch/product-ui";
import type { ChatSessionContextAttachment } from "@machdoch/client-ui/composer/model";
import { createInitialThinkingTrace } from "../../task-thinking.model";

const { invoke, listen, windowLabel } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  windowLabel: vi.fn(() => "main"),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock(
  "@machdoch/media-studio/tauri/ui/lib/_helpers/shell-store-storage.helper.js",
  () => ({ getCurrentShellWindowLabel: windowLabel }),
);
beforeEach(() => {
  listen.mockResolvedValue(vi.fn());
  vi.stubGlobal("crypto", webcrypto);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  windowLabel.mockReturnValue("main");
});

const projectSession = (
  session: ReturnType<typeof createSession>,
): ProductSession => ({
  id: session.id,
  title: session.manualTitle ?? "Session",
  status: "done",
  provider: session.provider,
  model: session.model,
  effectiveMode: "ask",
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  tags: session.tags,
  messageCount: session.messages.length,
  promptHistoryCount: session.promptHistory.length,
  attachmentCount: session.draftContextAttachments.length,
  canRename: true,
  canDelete: true,
  canArchive: true,
  canPin: true,
  canDuplicate: true,
  canBranch: true,
});
const projectMessage = (message: ChatSessionMessage) => ({
  id: message.id,
  role: message.role,
  content: message.content,
  rawContent: message.content,
  presentation: "message" as const,
  attachments: [],
  actions: {
    canRetry: false,
    canContinue: false,
    canSaveAsContextPack: message.role === "user",
    canSpeak: false,
    isSpeaking: false,
  },
});
const setup = (sessions: ReturnType<typeof createSession>[]) => {
  const state = { ...createInitialShellState(), sessions };
  const options = {
    state,
    hasHydrated: true,
    projectSession,
    projectMessage,
    projectAttachment: (attachment: ChatSessionContextAttachment) => ({
      ...attachment,
    }),
    importSessionPayload: vi.fn(() => 1),
    flushPersistence: vi.fn().mockResolvedValue(undefined),
  };
  const view = renderHook(() => useFleetSessionData(options));
  const send = async (command: string, args: unknown) => {
    await waitFor(() => expect(listen).toHaveBeenCalled());
    await act(async () => {
      await listen.mock.calls[0]![1]({
        payload: { id: "request", command, args },
      });
    });
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    const response = invoke.mock.calls.at(-1)![1];
    invoke.mockClear();
    return response as { result: unknown; error: string | null };
  };
  return { ...view, options, send };
};

it("exports full native sessions outside the live snapshot without truncating draft or transcript content", async () => {
  const sessions = Array.from({ length: 90 }, (_, index) =>
    createSession({
      id: `session-${index}`,
      draft: "🌿".repeat(9_000),
      messages: [
        {
          id: `message-${index}`,
          role: "user",
          content: "Grüße".repeat(3_000),
        },
      ],
    }),
  );
  const { send } = setup(sessions);
  const response = await send("get_session_export", {
    sessionIds: ["session-89"],
  });
  expect(response.error).toBeNull();
  expect(response.result).toMatchObject({
    kind: "machdoch.sessions",
    version: 1,
    sessions: [
      {
        id: "session-89",
        draft: sessions[89]!.draft,
        messages: sessions[89]!.messages,
      },
    ],
  });
});

it("uses native content search across the full session index", async () => {
  const sessions = Array.from({ length: 90 }, (_, index) =>
    createSession({
      id: `session-${index}`,
      manualTitle: `Title ${index}`,
      messages: [
        {
          id: `message-${index}`,
          role: "user",
          content:
            index === 89 ? "Unique hidden transcript phrase" : "Other content",
        },
      ],
    }),
  );
  const { send } = setup(sessions);
  const response = await send("get_session_index", {
    offset: 0,
    limit: 80,
    query: "hidden transcript",
    scope: "all",
    statuses: [],
    project: ALL_SESSION_PROJECTS_FILTER,
    tags: [],
  });
  expect(response.error).toBeNull();
  expect(response.result).toMatchObject({
    total: 1,
    nextOffset: null,
    sessionIds: ["session-89"],
    sessions: [{ id: "session-89" }],
  });
});

it("returns complete native drafts, all forty history entries and long queued text", async () => {
  const content = "Grüße 🌿\n".repeat(2_000);
  const session = createSession({
    id: "session",
    draft: content,
    promptHistory: Array.from({ length: 40 }, () => content),
  });
  const { send, options } = setup([session]);
  options.state.queuedSessionMessages = [
    {
      id: "queue",
      sessionId: session.id,
      task: content,
      status: "queued",
      createdAt: 0,
      updatedAt: 0,
      contentUpdatedAt: 0,
      attachmentsUpdatedAt: 0,
      attachmentTombstones: {},
      blockerUpdatedAt: 0,
      orderRank: 0,
      orderUpdatedAt: 0,
      statusUpdatedAt: 0,
      contextAttachments: [],
    },
  ];
  const response = await send("get_session_composer_text", {
    sessionId: session.id,
  });
  expect(response.error).toBeNull();
  expect(response.result).toMatchObject({
    sessionId: session.id,
    draft: content,
    draftRevision: session.draftUpdatedAt,
    queuedMessages: [{ id: "queue", content }],
  });
  expect((response.result as { history: unknown[] }).history).toHaveLength(40);
  expect(
    (response.result as { history: { prompt: string }[] }).history[0]!.prompt,
  ).toBe(content);
});

it("returns chronological pages and lossless message text while rejecting a stale revision", async () => {
  const session = createSession({
    id: "session",
    messages: Array.from({ length: 165 }, (_, index) => ({
      id: `message-${index}`,
      role: "user" as const,
      content: "🌿".repeat(9_000),
    })),
  });
  const { send, options } = setup([session]);
  const latest = (
    await send("get_session_message_page", { sessionId: session.id, limit: 80 })
  ).result as {
    revision: string;
    messages: ChatSessionMessage[];
    hasEarlier: boolean;
  };
  expect(latest.messages[0]!.id).toBe("message-85");
  expect(latest.messages[79]!.content).toBe(session.messages[164]!.content);
  expect(latest.hasEarlier).toBe(true);
  const previous = (
    await send("get_session_message_page", {
      sessionId: session.id,
      beforeMessageId: "message-85",
      expectedRevision: latest.revision,
      limit: 80,
    })
  ).result as { messages: ChatSessionMessage[] };
  expect(previous.messages.map(({ id }) => id)).toEqual(
    session.messages.slice(5, 85).map(({ id }) => id),
  );
  options.state.sessions = [
    { ...session, messages: session.messages.slice(0, 164) },
  ];
  const rejected = await send("get_session_message_page", {
    sessionId: session.id,
    beforeMessageId: "message-85",
    expectedRevision: latest.revision,
    limit: 80,
  });
  expect(rejected.error).toBe("The conversation changed. Reload its history.");
});

it("confirms imports only after canonical native mutation and persistence", async () => {
  const { send, options } = setup([createSession({ id: "session" })]);
  const payload = { kind: "machdoch.sessions", version: 1, sessions: [{}] };
  expect(await send("import_session_export", { payload })).toEqual({
    id: "request",
    result: { imported: 1 },
    error: null,
  });
  expect(options.importSessionPayload).toHaveBeenCalledWith(payload);
  expect(options.flushPersistence).toHaveBeenCalledOnce();
  options.importSessionPayload.mockImplementation(() => {
    throw new Error("Invalid native archive");
  });
  const rejected = await send("import_session_export", { payload });
  expect(rejected.error).toBe("Invalid native archive");
  expect(options.flushPersistence).toHaveBeenCalledOnce();
});

it("refuses removed sessions and excludes Quick Chat archives", async () => {
  const { send } = setup([
    createSession({ id: "quick", specialSession: "quick-voice" }),
  ]);
  expect(
    (await send("get_session_export", { sessionIds: ["quick"] })).error,
  ).toContain("An exported session changed");
  expect(
    (
      await send("get_session_message_page", {
        sessionId: "removed",
        limit: 80,
      })
    ).error,
  ).toContain("This session was removed");
});

it("returns the complete native activity trace including tool details and timeout state", async () => {
  const thinking = {
    ...createInitialThinkingTrace("ask", 1),
    timeout: {
      startedAt: 1,
      lastActivityAt: 2,
      idleTimeoutMs: 1_200_000,
      absoluteTimeoutMs: null,
    },
    timelineEvents: Array.from({ length: 120 }, (_, index) => ({
      id: `event-${index}`,
      kind: "tool-call" as const,
      phase: "completed" as const,
      label: "Tool",
      detail: "Tool result",
      tone: "success" as const,
      timestamp: index,
      elapsedMs: index,
      metadata: { argumentsPreview: "Native arguments 🌿" },
    })),
  };
  const session = createSession({
    id: "activity",
    messages: [
      {
        id: "message",
        role: "agent",
        content: "",
        source: { kind: "thinking", thinking },
      },
    ],
  });
  const { send } = setup([session]);
  const result = await send("get_session_message_page", {
    sessionId: session.id,
    limit: 1,
  });
  expect(result.error).toBeNull();
  expect(result.result).toMatchObject({
    messages: [{ id: "message", thinking }],
  });
});

it("keeps the paging revision stable while live execution updates and changes it when message text changes", async () => {
  const thinking = createInitialThinkingTrace("ask", 1);
  const session = createSession({
    id: "running-history",
    messages: [
      { id: "earlier", role: "user", content: "Full history" },
      {
        id: "live",
        role: "agent",
        content: "",
        source: { kind: "thinking", thinking },
      },
    ],
  });
  const { options, send, rerender } = setup([session]);
  const first = await send("get_session_message_page", {
    sessionId: session.id,
    limit: 1,
  });
  const revision = (first.result as { revision: string }).revision;
  options.state.sessions = [
    {
      ...session,
      messages: [
        session.messages[0]!,
        {
          ...session.messages[1]!,
          source: {
            kind: "thinking",
            thinking: {
              ...thinking,
              timeout: {
                startedAt: 1,
                lastActivityAt: 2,
                idleTimeoutMs: 180_000,
                absoluteTimeoutMs: null,
              },
            },
          },
        },
      ],
    },
  ];
  rerender();
  const older = await send("get_session_message_page", {
    sessionId: session.id,
    limit: 1,
    beforeMessageId: "live",
    expectedRevision: revision,
  });
  expect(older.error).toBeNull();
  expect(older.result).toMatchObject({
    revision,
    messages: [{ id: "earlier", content: "Full history" }],
  });
  options.state.sessions = [
    {
      ...session,
      messages: [
        { ...session.messages[0]!, content: "Edited history" },
        session.messages[1]!,
      ],
    },
  ];
  rerender();
  const stale = await send("get_session_message_page", {
    sessionId: session.id,
    limit: 1,
    beforeMessageId: "live",
    expectedRevision: revision,
  });
  expect(stale.error).toContain("The conversation changed");
});

it("reads changed files only through the owning native session and message", async () => {
  const stage = { state: "complete" } as const;
  const execution = {
    task: "Native task",
    mode: "ask" as const,
    status: "executed" as const,
    summary: "Complete",
    executedTools: [],
    outputSections: [],
    response: {
      markdown: "Native answer",
      highlights: [],
      relatedFiles: [
        { path: "notes/Grüße.md", description: "Native reference" },
      ],
      verification: ["Verified"],
      followUps: [],
    },
    metadata: {
      instructionResolutionId: "resolution",
      instructionSources: [{ id: "source", name: "Workspace" }],
      privateDiagnostic: "Not projected",
    },
    fileChanges: {
      files: [],
      changeSetId: "native-set",
      totalFiles: 2,
      additions: 0,
      deletions: 0,
      binaryFiles: 0,
      gitlinkFiles: 0,
      symlinkFiles: 0,
      modeOnlyFiles: 0,
      failedFiles: 0,
      status: "complete" as const,
      attribution: "workspace-observed" as const,
      repositoryCount: 1,
      issues: [],
      completeness: {
        discovery: stage,
        startSnapshots: stage,
        finishSnapshots: stage,
        renameAnalysis: stage,
        lineAnalysis: stage,
        persistence: stage,
      },
    },
  };
  const session = createSession({
    id: "native-session",
    messages: [
      {
        id: "native-message",
        role: "agent",
        content: "Native answer",
        source: { kind: "execution", execution },
      },
    ],
  });
  const { send } = setup([session, createSession({ id: "other-session" })]);
  const nativeReads = vi.fn();
  invoke.mockImplementation(async (command, args) => {
    if (command === "get_task_file_change_files") {
      nativeReads(command, args);
      return { files: [], nextCursor: null };
    }
    if (command === "get_task_file_change_hunks") {
      nativeReads(command, args);
      return { ranges: [], nextCursor: null };
    }
    return undefined;
  });
  const args = {
    sessionId: session.id,
    messageId: "native-message",
    changeSetId: "native-set",
    limit: 100,
  };
  const read = await send("get_session_file_change_files", args);
  expect(read).toMatchObject({
    error: null,
    result: { files: [], nextCursor: null },
  });
  expect(nativeReads).toHaveBeenCalledWith("get_task_file_change_files", {
    request: { changeSetId: "native-set", limit: 100 },
  });
  for (const wrong of [
    { ...args, sessionId: "other-session" },
    { ...args, messageId: "missing" },
    { ...args, changeSetId: "other-set" },
  ]) {
    const rejected = await send("get_session_file_change_files", wrong);
    expect(rejected.error).toContain("no longer in this conversation");
    expect(nativeReads).toHaveBeenCalledTimes(1);
  }
  const hunks = await send("get_session_file_change_hunks", {
    ...args,
    fileId: 1,
    afterOrdinal: 0,
  });
  expect(hunks).toMatchObject({
    error: null,
    result: { ranges: [], nextCursor: null },
  });
  expect(nativeReads).toHaveBeenCalledWith("get_task_file_change_hunks", {
    request: {
      changeSetId: "native-set",
      limit: 100,
      fileId: 1,
      afterOrdinal: 0,
    },
  });
  const page = await send("get_session_message_page", {
    sessionId: session.id,
    limit: 1,
  });
  const projected = (
    page.result as {
      messages: {
        execution: { metadata: Record<string, unknown>; response: unknown };
      }[];
    }
  ).messages[0]!.execution;
  expect(projected.response).toEqual({
    relatedFiles: execution.response.relatedFiles,
    verification: execution.response.verification,
  });
  expect(projected.metadata).toEqual({
    instructionResolutionId: "resolution",
    instructionSources: execution.metadata.instructionSources,
  });
});

it("listens only in the main native window and releases the listener", async () => {
  windowLabel.mockReturnValue("assistant");
  const outside = setup([createSession()]);
  expect(listen).not.toHaveBeenCalled();
  outside.unmount();
  windowLabel.mockReturnValue("main");
  const stop = vi.fn();
  listen.mockResolvedValue(stop);
  const main = setup([createSession()]);
  await waitFor(() =>
    expect(listen).toHaveBeenCalledWith(
      "machdoch://fleet-client-request",
      expect.any(Function),
    ),
  );
  main.unmount();
  expect(stop).toHaveBeenCalledOnce();
});
