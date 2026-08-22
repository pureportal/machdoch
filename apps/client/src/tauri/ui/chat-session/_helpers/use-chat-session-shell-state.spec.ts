import {
  createInitialShellState,
  createSession,
  normalizeShellState,
  type ChatSessionQueuedMessage,
  type ShellPersistedState,
} from "../../chat-session.model";
import { mergeShellStateForPersistence } from "./use-chat-session-shell-state";

const createQueuedMessage = (
  overrides: Partial<ChatSessionQueuedMessage> = {},
): ChatSessionQueuedMessage => ({
  id: "queued-1",
  sessionId: "session-1",
  task: "Review the change.",
  dispatchPolicy: "after-success",
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

describe("queued message persistence", () => {
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
