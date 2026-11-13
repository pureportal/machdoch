import { describe, expect, it } from "vitest";
import {
  createSession,
  type ChatSessionMessage,
  type ChatSessionQueuedMessage,
  type ChatSessionRecord,
  type ChatSessionTaskOutcomeStatus,
} from "../../chat-session.model";
import {
  canDispatchQueuedMessage,
  canStartQueuedMessageDispatch,
  createConflictedQueuedMessageRecovery,
  createQueuedMessageDispatchAttempt,
  createQueuedMessageRetry,
  findQueuedHead,
  setSessionQueuePaused,
  shouldStopQueueAfterFailure,
} from "./queued-message-lifecycle";
import { reconcileQueuedMessagesForTaskSubmission } from "./use-session-task-submission";

const createQueuedMessage = (
  overrides: Partial<ChatSessionQueuedMessage> = {},
): ChatSessionQueuedMessage => ({
  id: "queued-1",
  sessionId: "session-1",
  task: "Original request",
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

const createTaskMessages = (
  taskId: string,
  status: ChatSessionTaskOutcomeStatus,
  createdAt: number,
): ChatSessionMessage[] => [
  { id: `${taskId}-user`, taskId, role: "user", content: taskId, createdAt },
  {
    id: `${taskId}-agent`,
    taskId,
    role: "agent",
    content: status,
    createdAt: createdAt + 1,
    outcome: { status },
  },
];

const appendTask = (
  session: ChatSessionRecord,
  taskId: string,
  status: ChatSessionTaskOutcomeStatus,
  createdAt: number,
): ChatSessionRecord => ({
  ...session,
  messages: [
    ...session.messages,
    ...createTaskMessages(taskId, status, createdAt),
  ],
});

describe("queue stop after failure", () => {
  it.each(["failed", "blocked", "timed-out", "unsupported", "crashed"] as const)(
    "stops the queue after a %s task",
    (status) => {
      const session = appendTask(createSession({ id: "session-1" }), "task-1", status, 10);

      expect(shouldStopQueueAfterFailure(session)).toBe(true);
    },
  );

  it.each(["succeeded", "cancelled"] as const)(
    "keeps the queue running after a %s task",
    (status) => {
      const session = appendTask(createSession({ id: "session-1" }), "task-1", status, 10);

      expect(shouldStopQueueAfterFailure(session)).toBe(false);
    },
  );

  it("does not stop an empty session", () => {
    expect(shouldStopQueueAfterFailure(createSession({ id: "session-1" }))).toBe(false);
  });

  it("stops once per failure and again after a later failure", () => {
    const failed = appendTask(createSession({ id: "session-1" }), "task-1", "failed", 10);
    const paused = setSessionQueuePaused(failed, true, 20);

    expect(paused.queuePausedAt).toBe(20);
    expect(shouldStopQueueAfterFailure(paused)).toBe(false);

    const resumed = setSessionQueuePaused(paused, false, 30);

    expect(resumed.queuePausedAt).toBeUndefined();
    expect(resumed.queueResumedAfterTaskId).toBe("task-1");
    expect(shouldStopQueueAfterFailure(resumed)).toBe(false);
    expect(
      shouldStopQueueAfterFailure(appendTask(resumed, "task-2", "succeeded", 40)),
    ).toBe(false);
    expect(
      shouldStopQueueAfterFailure(appendTask(resumed, "task-2", "failed", 40)),
    ).toBe(true);
  });

  it("does not acknowledge a running task when the queue is resumed", () => {
    const running: ChatSessionRecord = {
      ...createSession({ id: "session-1" }),
      messages: [
        { id: "task-1-user", taskId: "task-1", role: "user", content: "Run", createdAt: 10 },
      ],
    };
    const resumed = setSessionQueuePaused(
      setSessionQueuePaused(running, true, 20),
      false,
      30,
    );

    expect(resumed.queueResumedAfterTaskId).toBeUndefined();
    expect(
      shouldStopQueueAfterFailure({
        ...resumed,
        messages: createTaskMessages("task-1", "failed", 10),
      }),
    ).toBe(true);
  });

  it("holds later prompts behind a failed queued prompt only when stopping is enabled", () => {
    const failed = createQueuedMessage({ id: "queued-1", status: "failed" });
    const next = createQueuedMessage({ id: "queued-2", orderRank: 1 });
    const otherSession = createQueuedMessage({ id: "queued-3", sessionId: "session-2" });
    const messages = [failed, otherSession, next];

    expect(findQueuedHead(messages, "session-1", true)?.id).toBe("queued-1");
    expect(findQueuedHead(messages, "session-1", false)?.id).toBe("queued-2");
    expect(findQueuedHead(messages, "session-2", true)?.id).toBe("queued-3");
  });

  it("does not let an emptied queued prompt hold the queue", () => {
    const emptied = createQueuedMessage({ id: "queued-1", task: " ", status: "failed" });
    const next = createQueuedMessage({ id: "queued-2", orderRank: 1 });

    expect(findQueuedHead([emptied, next], "session-1", true)?.id).toBe("queued-2");
  });
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

    const failedRecovery = createConflictedQueuedMessageRecovery(
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

  it("starts an enhanced queued prompt after its enhancement placeholder is removed", () => {
    const enhancementTaskId = "prompt-enhancement-1";
    const renderedSession = createSession({
      id: "session-1",
      messages: [
        {
          id: `${enhancementTaskId}-user`,
          taskId: enhancementTaskId,
          role: "user",
          content: "Original request",
          lifecycle: {
            kind: "transient",
            owner: "prompt-enhancement",
            operationId: enhancementTaskId,
            slot: "user",
            ownerLaunchId: "launch-1",
            ownerWindowId: "window-1",
            ownerInstanceId: "instance-1",
            placement: "queued-message",
          },
        },
      ],
    });
    const currentSession = { ...renderedSession, messages: [] };
    const attempt = createQueuedMessageDispatchAttempt(
      createQueuedMessage({ promptEnhancementRequest: { mode: "simple" } }),
      "Enhanced request",
      20,
    );

    expect(
      canStartQueuedMessageDispatch(
        attempt.message,
        attempt.message.id,
        renderedSession,
        null,
      ),
    ).toBe(false);
    expect(
      canStartQueuedMessageDispatch(
        attempt.message,
        attempt.message.id,
        currentSession,
        null,
      ),
    ).toBe(true);

    const submitted = reconcileQueuedMessagesForTaskSubmission({
      queuedSessionMessages: [attempt.message],
      queuedMessageTombstones: {},
      consumedQueuedMessageId: attempt.message.id,
      timestamp: 30,
    });

    expect(attempt.prompt.task).toBe("Enhanced request");
    expect(submitted?.queuedSessionMessages).toEqual([]);
  });

  it("holds queued messages while the session queue is paused", () => {
    const message = createQueuedMessage();
    const pausedSession = createSession({ id: "session-1", queuePausedAt: 20 });
    const resumedSession = { ...pausedSession };
    delete resumedSession.queuePausedAt;

    expect(canDispatchQueuedMessage(message, pausedSession, null)).toBe(false);
    expect(
      canStartQueuedMessageDispatch(message, message.id, pausedSession, null),
    ).toBe(false);
    expect(canDispatchQueuedMessage(message, resumedSession, null)).toBe(true);
  });

  it("returns execution conflicts to the automatic queue", () => {
    const recovery = createConflictedQueuedMessageRecovery(
      createQueuedMessage({ status: "dispatching" }),
      "queued-recovery",
      "active-task",
      20,
    );

    expect(recovery).toMatchObject({
      id: "queued-recovery",
      blockedByTaskId: "active-task",
      status: "queued",
    });
  });
});
