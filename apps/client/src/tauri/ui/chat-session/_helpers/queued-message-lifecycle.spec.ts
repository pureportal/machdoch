import { describe, expect, it } from "vitest";
import type { ChatSessionQueuedMessage } from "../../chat-session.model";
import {
  createFailedQueuedMessageRecovery,
  createQueuedMessageDispatchAttempt,
  createQueuedMessageRetry,
} from "./queued-message-lifecycle";
import { reconcileQueuedMessagesForTaskSubmission } from "./use-session-task-submission";

const createQueuedMessage = (
  overrides: Partial<ChatSessionQueuedMessage> = {},
): ChatSessionQueuedMessage => ({
  id: "queued-1",
  sessionId: "session-1",
  task: "Original request",
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

describe("queued message lifecycle", () => {
  it("dispatches and consumes an ordinary queued message once", () => {
    const attempt = createQueuedMessageDispatchAttempt(
      createQueuedMessage(),
      undefined,
      20,
    );

    expect(attempt.message.status).toBe("dispatching");
    expect(attempt.prompt).toEqual({
      task: "Original request",
      visibleMessageContent: "Original request",
      promptHistoryContent: "Original request",
    });

    const submitted = reconcileQueuedMessagesForTaskSubmission({
      queuedSessionMessages: [attempt.message],
      queuedMessageTombstones: {},
      sessionId: "session-1",
      consumedQueuedMessageId: attempt.message.id,
      timestamp: 30,
    });

    expect(submitted?.queuedSessionMessages).toEqual([]);
    expect(submitted?.queuedMessageTombstones).toEqual({ "queued-1": 30 });
  });

  it("consumes queued enhancement before execution and never retriggers it", () => {
    let enhancementCalls = 0;
    const prepareDispatch = (
      message: ChatSessionQueuedMessage,
    ): ReturnType<typeof createQueuedMessageDispatchAttempt> => {
      const enhancedPrompt = message.promptEnhancementRequest
        ? (() => {
            enhancementCalls += 1;
            return "Enhanced request";
          })()
        : undefined;

      return createQueuedMessageDispatchAttempt(message, enhancedPrompt, 20);
    };

    const firstAttempt = prepareDispatch(
      createQueuedMessage({ promptEnhancementRequest: { mode: "simple" } }),
    );

    expect(firstAttempt.prompt).toEqual({
      task: "Enhanced request",
      visibleMessageContent: "Enhanced request",
      promptHistoryContent: "Original request",
      promptEnhancement: { originalContent: "Original request" },
    });
    expect(firstAttempt.message.promptEnhancementRequest).toBeUndefined();

    const failedRecovery = createFailedQueuedMessageRecovery(
      firstAttempt.message,
      "queued-recovery",
      "active-task",
      30,
    );
    const retry = prepareDispatch(
      createQueuedMessageRetry(failedRecovery, "queued-retry", 40),
    );

    expect(enhancementCalls).toBe(1);
    expect(retry.message.id).toBe("queued-retry");
    expect(retry.prompt).toEqual(firstAttempt.prompt);
    expect(retry.message.promptEnhancementRequest).toBeUndefined();
  });

  it("turns execution conflicts into a terminal manual-retry state", () => {
    const recovery = createFailedQueuedMessageRecovery(
      createQueuedMessage({ status: "dispatching" }),
      "queued-recovery",
      "active-task",
      20,
    );

    expect(recovery).toMatchObject({
      id: "queued-recovery",
      blockedByTaskId: "active-task",
      status: "failed",
      failureMessage:
        "Task could not start because another task became active.",
    });
  });
});
