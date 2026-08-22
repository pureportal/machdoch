import type { ChatSessionQueuedMessage } from "../../chat-session.model";
import { reconcileQueuedMessagesForTaskSubmission } from "./use-session-task-submission";

const createQueuedMessage = (
  id: string,
  overrides: Partial<ChatSessionQueuedMessage> = {},
): ChatSessionQueuedMessage => ({
  id,
  sessionId: "session-1",
  task: `Task ${id}`,
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

describe("queued task submission reconciliation", () => {
  it("consumes a dispatched queue item atomically with a tombstone", () => {
    const reconciliation = reconcileQueuedMessagesForTaskSubmission({
      queuedSessionMessages: [
        createQueuedMessage("dispatched"),
        createQueuedMessage("follow-up", {
          orderRank: 1,
          createdAt: 20,
        }),
      ],
      queuedMessageTombstones: {},
      sessionId: "session-1",
      consumedQueuedMessageId: "dispatched",
      timestamp: 30,
    });

    expect(
      reconciliation?.queuedSessionMessages.map((message) => message.id),
    ).toEqual(["follow-up"]);
    expect(reconciliation?.queuedMessageTombstones.dispatched).toBe(30);
  });

  it("preserves queue items created after an edited-message branch began", () => {
    const reconciliation = reconcileQueuedMessagesForTaskSubmission({
      queuedSessionMessages: [
        createQueuedMessage("old", { createdAt: 10 }),
        createQueuedMessage("new", { orderRank: 1, createdAt: 25 }),
        createQueuedMessage("other-session", {
          sessionId: "session-2",
          createdAt: 5,
        }),
      ],
      queuedMessageTombstones: {},
      sessionId: "session-1",
      conversationCutoffMessageId: "message-1",
      preserveQueuedMessagesCreatedAfter: 20,
      timestamp: 30,
    });

    expect(
      reconciliation?.queuedSessionMessages.map((message) => message.id),
    ).toEqual(["new", "other-session"]);
    expect(reconciliation?.queuedMessageTombstones.old).toBe(30);
  });
});
