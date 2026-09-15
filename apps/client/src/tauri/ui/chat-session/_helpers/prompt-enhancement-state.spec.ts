import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS } from "../../../../core/runtime-contract.generated.js";
import {
  createInitialShellState,
  createSession,
  getActivePromptEnhancementEditMessageId,
  getActiveChatOperationIds,
  normalizeShellState,
  type ChatSessionQueuedMessage,
  type ShellPersistedState,
} from "../../chat-session.model";
import { createInitialThinkingTrace } from "../../task-thinking.model";
import {
  getExecutionAttemptTaskId,
  type AutomaticRetrySettings,
} from "./execution-retry-policy";
import type { PromptEnhancementAttempt } from "./prompt-enhancement-attempt";
import {
  PromptEnhancementCancellationError,
  type PromptEnhancementPendingPlacement,
} from "./prompt-enhancement";
import {
  isPromptEnhancementCurrent,
  updatePromptEnhancementAttempt,
} from "./prompt-enhancement-state";
import {
  canStartQueuedMessageDispatch,
  createQueuedMessageDispatchAttempt,
  createQueuedMessageRetry,
} from "./queued-message-lifecycle";
import { runPromptEnhancement } from "./run-prompt-enhancement";
import { reconcileQueuedMessagesForTaskSubmission } from "./use-session-task-submission";
import { mergeShellStateForPersistence } from "./use-chat-session-shell-state";

const createQueueItem = (): ChatSessionQueuedMessage => ({
  id: "queued",
  sessionId: "session",
  task: "Original request",
  promptEnhancementRequest: { mode: "web-search" },
  contextAttachments: [
    {
      id: "attachment",
      source: "path",
      path: "/project/source.ts",
      name: "source.ts",
      kind: "file",
    },
  ],
  contentUpdatedAt: 100,
  attachmentsUpdatedAt: 100,
  attachmentTombstones: {},
  blockerUpdatedAt: 100,
  orderRank: 0,
  orderUpdatedAt: 100,
  status: "enhancing",
  statusUpdatedAt: 100,
  createdAt: 100,
  updatedAt: 100,
});

const createHarness = (
  placement: PromptEnhancementPendingPlacement,
  previousAttempt?: PromptEnhancementAttempt,
  settings: AutomaticRetrySettings = DEFAULT_USER_AGENT_LIMITS_SETTINGS,
) => {
  let taskId = previousAttempt
    ? getExecutionAttemptTaskId(previousAttempt.execution)
    : "enhancement";
  const queueItem =
    placement === "queued-message"
      ? {
          ...createQueueItem(),
          ...(previousAttempt
            ? { promptEnhancementAttempt: previousAttempt }
            : {}),
        }
      : undefined;
  const controller = new AbortController();
  const session = createSession({
    id: "session",
    messages: [
      { id: "target", role: "user", content: "Original target" },
      {
        id: "response",
        taskId: "target",
        role: "agent",
        content: "Done",
        outcome: { status: "succeeded" },
      },
      {
        id: "marker",
        taskId,
        role: "agent",
        content: "",
        createdAt: 100,
        lifecycle: {
          kind: "transient",
          owner: "prompt-enhancement",
          operationId: taskId,
          slot: placement === "edit-composer" ? "marker" : "thinking",
          ownerLaunchId: "launch",
          ownerWindowId: "window",
          ownerInstanceId: "instance",
          placement,
          ...(placement === "edit-composer"
            ? { targetMessageId: "target" }
            : {}),
        },
        source: {
          kind: "thinking",
          thinking: createInitialThinkingTrace("ask", 100),
        },
      },
    ],
  });
  let state: ShellPersistedState = {
    ...createInitialShellState(),
    activeSessionId: session.id,
    sessions: [session],
    queuedSessionMessages: [
      ...(queueItem ? [queueItem] : []),
      {
        ...createQueueItem(),
        id: "follower",
        task: "Follow-up",
        status: "queued",
        orderRank: 1,
        blockedByTaskId: taskId,
      },
    ],
  };
  const run = vi
    .fn<Parameters<typeof runPromptEnhancement>[0]["run"]>()
    .mockResolvedValue({
      execution: { status: "executed", summary: "Enhanced request" },
    });
  const start = () =>
    runPromptEnhancement({
      taskId,
      task: "Enhance the request",
      previousAttempt,
      signal: controller.signal,
      getSettings: () => settings,
      assertActive: () => {
        if (
          !isPromptEnhancementCurrent({
            session: state.sessions[0],
            taskId,
            ...(placement === "edit-composer"
              ? { targetMessageId: "target" }
              : {}),
            queuedMessage: queueItem,
            currentQueuedMessage: state.queuedSessionMessages.find(
              (message) => message.id === queueItem?.id,
            ),
          })
        )
          throw new PromptEnhancementCancellationError(taskId);
      },
      persist: async (attempt) => {
        state = normalizeShellState(
          JSON.parse(
            JSON.stringify(
              updatePromptEnhancementAttempt(state, {
                sessionId: "session",
                taskId,
                attempt,
                queuedMessage: queueItem,
              }),
            ),
          ),
        );
        taskId = getExecutionAttemptTaskId(attempt.execution);
      },
      run,
    });
  return {
    start,
    run,
    controller,
    read: () => state,
    replace: (next: ShellPersistedState) => {
      state = next;
    },
  };
};

describe("enhancement state and queue handoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  it("keeps the latest retry marker when stale progress is persisted by another window", () => {
    const harness = createHarness("edit-composer");
    const base = harness.read();
    const execution = {
      rootTaskId: "enhancement",
      task: "Enhance",
      retryNumber: 0,
      retryLimit: 2,
    };
    const old = updatePromptEnhancementAttempt(base, {
      sessionId: "session",
      taskId: "enhancement",
      attempt: { execution, status: "running", updatedAt: 10_000 },
    });
    const retry = updatePromptEnhancementAttempt(old, {
      sessionId: "session",
      taskId: "enhancement",
      attempt: {
        execution: { ...execution, retryNumber: 1 },
        status: "waiting",
        readyAt: 12_000,
        updatedAt: 10_001,
      },
    });
    old.sessions[0].messages = old.sessions[0].messages.map((message) =>
      message.id === "marker"
        ? { ...message, content: "Late progress from the earlier attempt" }
        : message,
    );
    for (const [local, latest] of [
      [old, retry],
      [retry, old],
    ]) {
      const merged = normalizeShellState(
        mergeShellStateForPersistence(local, base, latest),
      );
      expect(getActiveChatOperationIds(merged.sessions[0])).toContain(
        "enhancement-retry-1",
      );
      expect(getActivePromptEnhancementEditMessageId(merged.sessions[0])).toBe(
        "target",
      );
    }
  });

  it.each(["message", "edit-composer", "queued-message"] as const)(
    "preserves %s state and followers until a retry succeeds",
    async (placement) => {
      const harness = createHarness(placement);
      harness.run.mockRejectedValueOnce(new Error("Provider failed"));
      const result = harness.start();
      await vi.advanceTimersByTimeAsync(0);
      const waiting = harness.read();
      expect(getActiveChatOperationIds(waiting.sessions[0])).toContain(
        "enhancement-retry-1",
      );
      expect(
        waiting.sessions[0].messages.find((message) => message.id === "target")
          ?.content,
      ).toBe("Original target");
      expect(
        waiting.sessions[0].messages.find((message) => message.id === "marker")
          ?.promptEnhancementAttempt,
      ).toMatchObject({ status: "waiting", execution: { retryNumber: 1 } });
      expect(
        waiting.queuedSessionMessages.find(
          (message) => message.id === "follower",
        ),
      ).toMatchObject({
        status: "queued",
        blockedByTaskId: "enhancement-retry-1",
      });
      if (placement === "edit-composer")
        expect(
          getActivePromptEnhancementEditMessageId(waiting.sessions[0]),
        ).toBe("target");
      if (placement === "queued-message") {
        expect(waiting.queuedSessionMessages[0]).toMatchObject({
          ...createQueueItem(),
          updatedAt: expect.any(Number),
        });
        expect(
          canStartQueuedMessageDispatch(
            waiting.queuedSessionMessages[0],
            "queued",
            waiting.sessions[0],
            null,
          ),
        ).toBe(false);
      }
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toBe("Enhanced request");
      expect(harness.run).toHaveBeenCalledTimes(2);
    },
  );

  it("consumes successful queued enhancement once and preserves original content and attachments", async () => {
    const harness = createHarness("queued-message");
    harness.run.mockRejectedValueOnce(new Error("Failed"));
    const result = harness.start();
    await vi.advanceTimersByTimeAsync(2_000);
    const enhanced = await result;
    const state = harness.read();
    const attempt = createQueuedMessageDispatchAttempt(
      state.queuedSessionMessages[0],
      enhanced,
      Date.now(),
    );
    expect(attempt.message.promptEnhancementRequest).toBeUndefined();
    expect(attempt.message.promptEnhancementAttempt).toBeUndefined();
    expect(attempt.message.contextAttachments).toEqual(
      createQueueItem().contextAttachments,
    );
    expect(attempt.prompt).toMatchObject({
      task: "Enhanced request",
      promptHistoryContent: "Original request",
      promptEnhancement: { originalContent: "Original request" },
    });
    const session = {
      ...state.sessions[0],
      messages: state.sessions[0].messages.filter(
        (message) => message.id !== "marker",
      ),
    };
    expect(
      canStartQueuedMessageDispatch(attempt.message, "queued", session, null),
    ).toBe(true);
    const submitted = reconcileQueuedMessagesForTaskSubmission({
      queuedSessionMessages: [attempt.message, state.queuedSessionMessages[1]],
      queuedMessageTombstones: {},
      sessionId: "session",
      consumedQueuedMessageId: "queued",
      timestamp: Date.now(),
    });
    expect(
      submitted?.queuedSessionMessages.map((message) => message.id),
    ).toEqual(["follower"]);
    expect(submitted?.queuedMessageTombstones.queued).toBe(Date.now());
    expect(() =>
      createQueuedMessageDispatchAttempt(attempt.message, enhanced, Date.now()),
    ).toThrow("already consumed");
  });

  it.each([
    { automaticRetries: true, retryAttempts: 2, attempts: 3 },
    { automaticRetries: false, retryAttempts: 2, attempts: 1 },
  ])(
    "retains queued input and visible failure after $attempts attempts",
    async ({ attempts, ...settings }) => {
      const harness = createHarness("queued-message", undefined, settings);
      harness.run.mockRejectedValue(new Error("Failed"));
      const result = expect(harness.start()).rejects.toThrow("Failed");
      await vi.runAllTimersAsync();
      await result;
      const queued = harness.read().queuedSessionMessages[0];
      expect(harness.run).toHaveBeenCalledTimes(attempts);
      expect(queued).toMatchObject({
        id: "queued",
        task: "Original request",
        status: "failed",
        failureMessage: "Enhancement failed.",
        promptEnhancementRequest: { mode: "web-search" },
        contextAttachments: createQueueItem().contextAttachments,
      });
      expect(queued.promptEnhancementAttempt?.execution.retryNumber).toBe(
        attempts - 1,
      );
      expect(
        createQueuedMessageRetry(queued, "manual-retry", 20_000)
          .promptEnhancementAttempt,
      ).toBeUndefined();
    },
  );

  it("resumes a persisted waiting attempt without resetting or incrementing its retry count", async () => {
    const harness = createHarness("queued-message");
    harness.run.mockRejectedValueOnce(new Error("Failed"));
    const first = expect(harness.start()).rejects.toBeInstanceOf(
      PromptEnhancementCancellationError,
    );
    await vi.advanceTimersByTimeAsync(0);
    const saved =
      harness.read().queuedSessionMessages[0].promptEnhancementAttempt!;
    harness.controller.abort();
    await first;
    const recovered = createHarness("queued-message", saved);
    const result = recovered.start();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(recovered.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("Enhanced request");
    expect(recovered.run.mock.calls[0][1]).toBe("enhancement-retry-1");
  });

  it.each([0, 1, 2])(
    "accounts for interrupted running attempt %i after a restart",
    async (retryNumber) => {
      const harness = createHarness("queued-message", {
        execution: {
          rootTaskId: "enhancement",
          task: "Enhance the request",
          retryNumber,
          retryLimit: 2,
        },
        status: "running",
        updatedAt: 1_000,
      });
      const result = harness.start();
      if (retryNumber === 2) {
        await expect(result).rejects.toThrow("interrupted");
        expect(harness.run).not.toHaveBeenCalled();
        expect(harness.read().queuedSessionMessages[0].status).toBe("failed");
      } else {
        await vi.runAllTimersAsync();
        await expect(result).resolves.toBe("Enhanced request");
        expect(harness.run.mock.calls[0][1]).toBe(
          `enhancement-retry-${retryNumber + 1}`,
        );
      }
    },
  );

  it.each(["running", "waiting"] as const)(
    "does not resume a persisted %s attempt when retries are disabled",
    async (status) => {
      const previous: PromptEnhancementAttempt = {
        execution: {
          rootTaskId: "enhancement",
          task: "Enhance the request",
          retryNumber: 1,
          retryLimit: 2,
        },
        updatedAt: 1_000,
        ...(status === "waiting" ? { status, readyAt: 12_000 } : { status }),
      };
      const harness = createHarness("queued-message", previous, {
        automaticRetries: false,
        retryAttempts: 2,
      });
      const result = expect(harness.start()).rejects.toThrow();
      await vi.runAllTimersAsync();
      await result;
      expect(harness.run).not.toHaveBeenCalled();
      expect(harness.read().queuedSessionMessages[0]).toMatchObject({
        status: "failed",
        task: "Original request",
        failureMessage: "Enhancement failed.",
      });
    },
  );

  it("discards queued enhancement output if attachments change during the attempt", async () => {
    const harness = createHarness("queued-message");
    harness.run.mockImplementationOnce(async () => {
      const state = harness.read();
      harness.replace({
        ...state,
        queuedSessionMessages: state.queuedSessionMessages.map((message) =>
          message.id === "queued"
            ? {
                ...message,
                contextAttachments: [],
                attachmentsUpdatedAt: 20_000,
                status: "queued",
              }
            : message,
        ),
      });
      return { execution: { status: "executed", summary: "Outdated result" } };
    });
    await expect(harness.start()).rejects.toBeInstanceOf(
      PromptEnhancementCancellationError,
    );
    expect(harness.run).toHaveBeenCalledTimes(1);
    expect(harness.read().queuedSessionMessages[0]).toMatchObject({
      task: "Original request",
      status: "queued",
      contextAttachments: [],
    });
  });

  it.each(["edit-composer", "queued-message"] as const)(
    "cancels %s retries when their target is removed",
    async (placement) => {
      const harness = createHarness(placement);
      harness.run.mockRejectedValueOnce(new Error("Failed"));
      const result = expect(harness.start()).rejects.toBeInstanceOf(
        PromptEnhancementCancellationError,
      );
      await vi.advanceTimersByTimeAsync(0);
      const state = harness.read();
      harness.replace(
        placement === "queued-message"
          ? {
              ...state,
              queuedSessionMessages: state.queuedSessionMessages.filter(
                (message) => message.id !== "queued",
              ),
            }
          : {
              ...state,
              sessions: [
                {
                  ...state.sessions[0],
                  messages: state.sessions[0].messages.filter(
                    (message) => message.id !== "target",
                  ),
                },
              ],
            },
      );
      await vi.runAllTimersAsync();
      await result;
      expect(harness.run).toHaveBeenCalledTimes(1);
      if (placement === "queued-message")
        expect(
          harness
            .read()
            .queuedSessionMessages.some((message) => message.id === "queued"),
        ).toBe(false);
    },
  );
});
