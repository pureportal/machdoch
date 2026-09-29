import {
  createInitialShellState,
  createSession,
  normalizeShellState,
  type ChatSessionQueuedMessage,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  createShellStatePatch,
  mergeShellStateForPersistence,
  mergeShellStateFromExternalUpdate,
} from "./use-chat-session-shell-state";

const createQueuedMessage = (
  overrides: Partial<ChatSessionQueuedMessage> = {},
): ChatSessionQueuedMessage => ({
  id: "queued-1",
  sessionId: "session-1",
  task: "Review the change.",
  contentUpdatedAt: 10,
  attachmentsUpdatedAt: 10,
  attachmentTombstones: {},
  blockerUpdatedAt: 10,
  orderRank: 0,
  orderUpdatedAt: 10,
  status: "queued",
  statusUpdatedAt: 10,
  contextAttachments: [],
  createdAt: 10,
  updatedAt: 10,
  ...overrides,
});

const createState = (
  queuedSessionMessages: ChatSessionQueuedMessage[],
): ShellPersistedState => {
  const session = createSession({ id: "session-1" });

  return {
    ...createInitialShellState(),
    activeSessionId: session.id,
    sessions: [session],
    queuedSessionMessages,
  };
};

describe("external shell-state updates", () => {
  it("adopts a remote update when local sessions are unchanged", () => {
    const base = createState([]);
    const external = {
      ...base,
      recentWorkspaces: ["remote-workspace"],
    };

    expect(mergeShellStateFromExternalUpdate(base, base, external, false)).toBe(
      external,
    );
  });

  it("keeps local session input alongside a remote update", () => {
    const base = createState([]);
    const currentSession = {
      ...base.sessions[0],
      draft: "Local input",
      draftUpdatedAt: base.sessions[0].draftUpdatedAt + 1,
      updatedAt: base.sessions[0].updatedAt + 1,
    };
    const current = { ...base, sessions: [currentSession] };
    const external = {
      ...base,
      recentWorkspaces: ["remote-workspace"],
    };

    const merged = mergeShellStateFromExternalUpdate(
      current,
      base,
      external,
      false,
    );

    expect(merged.sessions[0].draft).toBe("Local input");
    expect(merged.recentWorkspaces).toEqual(["remote-workspace"]);
  });
});

describe("shell-state conflict patches", () => {
  it("retains local input and remote changes while omitting unchanged sessions", () => {
    const initial = createState([]);
    const base = normalizeShellState({
      ...initial,
      sessions: [
        initial.sessions[0],
        createSession({ id: "session-2" }),
        createSession({ id: "session-3" }),
      ],
    });
    const local = {
      ...base,
      sessions: base.sessions.map((session) =>
        session.id === "session-1"
          ? {
              ...session,
              draft: "Local input",
              draftUpdatedAt: session.draftUpdatedAt + 1,
              updatedAt: session.updatedAt + 1,
            }
          : session,
      ),
    };
    const external = normalizeShellState({
      ...base,
      sessions: base.sessions.map((session) =>
        session.id === "session-2"
          ? {
              ...session,
              manualTitle: "Remote title",
              updatedAt: session.updatedAt + 1,
            }
          : session,
      ),
    });

    const merged = mergeShellStateForPersistence(local, base, external);
    const normalized = normalizeShellState(merged);
    const normalizedWithKnownSessions = normalizeShellState(
      merged,
      new Set(external.sessions),
    );
    const patch = createShellStatePatch(external, normalized, merged);

    expect(normalizedWithKnownSessions).toEqual(normalized);
    expect(
      normalizedWithKnownSessions.sessions.find(
        (session) => session.id === "session-2",
      ),
    ).toBe(external.sessions.find((session) => session.id === "session-2"));
    expect(
      normalizedWithKnownSessions.sessions.find(
        (session) => session.id === "session-1",
      ),
    ).not.toBe(local.sessions.find((session) => session.id === "session-1"));
    expect(
      merged.sessions.find((session) => session.id === "session-1")?.draft,
    ).toBe("Local input");
    expect(
      merged.sessions.find((session) => session.id === "session-2")
        ?.manualTitle,
    ).toBe("Remote title");
    expect(patch).toEqual(createShellStatePatch(external, normalized));
    expect(patch.sessions).toEqual([
      normalized.sessions.find((session) => session.id === "session-1"),
    ]);
  });
});

describe("queued message persistence", () => {
  it("preserves enhancement attempts when another window changes queue order", () => {
    const base = createQueuedMessage({
      promptEnhancementRequest: { mode: "simple" },
    });
    const attempt = {
      execution: {
        rootTaskId: "enhancement",
        task: "Enhance",
        retryNumber: 1,
        retryLimit: 2,
      },
      status: "waiting" as const,
      readyAt: 2_020,
      updatedAt: 20,
    };
    const retry = {
      ...base,
      status: "enhancing" as const,
      statusUpdatedAt: 20,
      updatedAt: 20,
      promptEnhancementAttempt: attempt,
    };
    const reordered = {
      ...base,
      orderRank: 2,
      orderUpdatedAt: 30,
      updatedAt: 30,
    };
    for (const [local, latest] of [
      [retry, reordered],
      [reordered, retry],
    ]) {
      const restored = normalizeShellState(
        mergeShellStateForPersistence(
          createState([local]),
          createState([base]),
          createState([latest]),
        ),
      );
      expect(restored.queuedSessionMessages[0]).toMatchObject({
        orderRank: 2,
        status: "enhancing",
        promptEnhancementAttempt: attempt,
      });
    }
  });

  it("does not apply an old enhancement attempt to edited queued content", () => {
    const base = createQueuedMessage({
      promptEnhancementRequest: { mode: "simple" },
    });
    const retry = {
      ...base,
      promptEnhancementAttempt: {
        execution: {
          rootTaskId: "enhancement",
          task: "Enhance",
          retryNumber: 1,
          retryLimit: 2,
        },
        status: "waiting" as const,
        readyAt: 2_020,
        updatedAt: 20,
      },
    };
    const edited = {
      ...base,
      task: "Changed request",
      contentUpdatedAt: 30,
      updatedAt: 30,
    };
    const merged = mergeShellStateForPersistence(
      createState([retry]),
      createState([base]),
      createState([edited]),
    );
    expect(merged.queuedSessionMessages[0].task).toBe("Changed request");
    expect(
      merged.queuedSessionMessages[0].promptEnhancementAttempt,
    ).toBeUndefined();
  });

  it("does not mistake enhancement placeholders for submitted queued messages", () => {
    const base = createQueuedMessage({
      promptEnhancementRequest: { mode: "simple" },
    });
    const local = createState([
      { ...base, status: "enhancing", statusUpdatedAt: 20 },
    ]);
    const latest = createState([]);
    latest.sessions[0].messages.push({
      id: "enhancement-user",
      taskId: "enhancement",
      role: "user",
      content: base.task,
      createdAt: 20,
      lifecycle: {
        kind: "transient",
        owner: "prompt-enhancement",
        operationId: "enhancement",
        slot: "user",
        ownerLaunchId: "launch",
        ownerWindowId: "window",
        ownerInstanceId: "instance",
        placement: "queued-message",
      },
    });
    const merged = mergeShellStateForPersistence(
      local,
      createState([base]),
      latest,
    );
    expect(merged.queuedSessionMessages).toHaveLength(1);
    expect(merged.queuedSessionMessages[0].id).toBe(base.id);
  });

  it("keeps a prepended follow-up ahead of existing queued work after persistence", () => {
    const existing = createQueuedMessage({
      id: "existing",
      orderRank: 0,
      createdAt: 10,
    });
    const followUp = createQueuedMessage({
      id: "follow-up",
      task: "Apply this correction next.",
      orderRank: -1,
      orderUpdatedAt: 20,
      createdAt: 20,
      updatedAt: 20,
    });
    const baseState = createState([existing]);
    const merged = mergeShellStateForPersistence(
      createState([followUp, existing]),
      baseState,
      baseState,
    );

    expect(merged.queuedSessionMessages.map((message) => message.id)).toEqual([
      "follow-up",
      "existing",
    ]);
  });

  it("merges a failure state without discarding a newer queued message edit", () => {
    const baseMessage = createQueuedMessage();
    const localFailure = createQueuedMessage({
      status: "failed",
      statusUpdatedAt: 30,
      failureMessage: "Enhancement failed.",
      updatedAt: 30,
    });
    const latestEdit = createQueuedMessage({
      task: "Review the updated change.",
      visibleMessageContent: "Review the updated change.",
      promptHistoryContent: "Review the updated change.",
      contentUpdatedAt: 40,
      updatedAt: 40,
    });
    const merged = mergeShellStateForPersistence(
      createState([localFailure]),
      createState([baseMessage]),
      createState([latestEdit]),
    );

    expect(merged.queuedSessionMessages[0]).toMatchObject({
      task: "Review the updated change.",
      status: "failed",
      failureMessage: "Enhancement failed.",
    });
  });

  it("restores queue items in canonical order with a runnable default state", () => {
    const later = createQueuedMessage({ id: "later", orderRank: 1 });
    const next = createQueuedMessage({ id: "next", orderRank: 0 });
    const restored = normalizeShellState({
      ...createState([later, next]),
      queuedSessionMessages: [
        { ...later, status: undefined, statusUpdatedAt: undefined },
        { ...next, status: undefined, statusUpdatedAt: undefined },
      ],
    });

    expect(restored.queuedSessionMessages.map((message) => message.id)).toEqual(
      ["next", "later"],
    );
    expect(
      restored.queuedSessionMessages.every(
        (message) => message.status === "queued",
      ),
    ).toBe(true);
  });
});
