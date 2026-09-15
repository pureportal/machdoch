import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS } from "../../../../core/runtime-contract.generated.js";
import {
  createInitialShellState,
  createSession,
  getSessionOverviewStatus,
  getSessionTaskOutcome,
  type ChatSessionQueuedMessage,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import { DesktopTaskRunProtocolError } from "../../desktop-task-error";
import { runDesktopTask } from "../../runtime";
import { useSessionTaskSubmission } from "./use-session-task-submission";
import {
  processAutomaticChatWork,
  type AutomaticChatWorkOptions,
} from "./use-automatic-chat-work";
import { hasPendingChatWork } from "../../app-shell/shutdown-when-idle";
import { getSessionMessageRunningAction } from "./composer-submission";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: <T>(current: T) => ({ current }),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("../../runtime", () => ({
  runDesktopTask: vi.fn(),
  loadUserMemorySettings: vi.fn(),
  loadActiveDesktopTasks: vi.fn(async () => []),
}));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
type TaskResult = Awaited<ReturnType<typeof runDesktopTask>>;
const success = (task: string): TaskResult =>
  ({
    execution: {
      task,
      mode: "machdoch",
      status: "executed",
      summary: "Done",
      executedTools: [],
      outputSections: [],
    },
  }) as TaskResult;

const setup = () => {
  const session = createSession({ id: crypto.randomUUID() });
  let shell = {
    ...createInitialShellState(),
    sessions: [session],
    activeSessionId: session.id,
  };
  const active = { current: new Map<string, string>() };
  const unsettled = { current: new Map<string, string>() };
  const progressRoutes: Parameters<
    typeof useSessionTaskSubmission
  >[0]["progressRoutesRef"] = { current: new Map() };
  const settings = { ...DEFAULT_USER_AGENT_LIMITS_SETTINGS };
  const state = {
    get shellState() {
      return shell;
    },
    get activeSession() {
      return shell.sessions[0];
    },
    applyShellState: (
      update: (previous: ShellPersistedState) => ShellPersistedState,
    ) => {
      shell = update(shell);
    },
    updateSessionById: (
      id: string,
      update: (session: ChatSessionRecord) => ChatSessionRecord,
    ) => {
      shell = {
        ...shell,
        sessions: shell.sessions.map((session) =>
          session.id === id ? update(session) : session,
        ),
      };
    },
    getSessionById: (id: string) =>
      shell.sessions.find((session) => session.id === id) ?? null,
    flushPersistence: vi.fn(async (): Promise<void> => undefined),
    setPromptHistoryIndex: vi.fn(),
    setDraftBeforeHistory: vi.fn(),
    setActiveSessionId: vi.fn(),
  };
  const submission = useSessionTaskSubmission({
    state: state as unknown as Parameters<
      typeof useSessionTaskSubmission
    >[0]["state"],
    runtime: {
      userMemorySettings: {
        globalEnabled: false,
        workspaceDefaultEnabled: false,
        entries: [],
      },
      userAgentLimitsSettings: settings,
    } as unknown as Parameters<typeof useSessionTaskSubmission>[0]["runtime"],
    voice: { stopSpeaking: vi.fn() },
    uiControlAvailability: undefined,
    aiContextMessageLimit: 50,
    activeDesktopTasksRef: active,
    unsettledDesktopTasksRef: unsettled,
    ignoredDesktopTaskIdsRef: { current: new Set() },
    progressRoutesRef: progressRoutes,
    applySessionMessageLimit: (session) => session,
    updateThinkingTrace: vi.fn(),
  });
  const options: AutomaticChatWorkOptions = {
    ready: true,
    state,
    settings,
    getUnsettledTaskId: (id) =>
      [...unsettled.current].find(([, session]) => id === session)?.[0] ?? null,
    submit: submission.submitTaskToSession,
    dispatchQueued: (session) => {
      const head = shell.queuedSessionMessages.find(
        (message) =>
          message.sessionId === session.id && message.status !== "failed",
      );
      if (head)
        submission.submitTaskToSession({
          sessionSnapshot: session,
          taskId: `queued-${head.id}`,
          task: head.task,
          contextAttachments: [],
          clearDraft: false,
          activateSession: false,
          consumedQueuedMessageId: head.id,
        });
    },
  };
  const enqueue = (task: string): void => {
    const timestamp = Date.now();
    const blockedByTaskId =
      [...active.current.keys()].at(-1) ??
      options.getUnsettledTaskId(session.id);
    shell.queuedSessionMessages.push({
      id: crypto.randomUUID(),
      sessionId: session.id,
      task,
      ...(blockedByTaskId ? { blockedByTaskId } : {}),
      contextAttachments: [],
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      contentUpdatedAt: timestamp,
      attachmentsUpdatedAt: timestamp,
      blockerUpdatedAt: timestamp,
      attachmentTombstones: {},
      orderRank: shell.queuedSessionMessages.length,
      orderUpdatedAt: timestamp,
      statusUpdatedAt: timestamp,
    } satisfies ChatSessionQueuedMessage);
  };
  const submit = (task: string) =>
    submission.submitTaskToSession({
      sessionSnapshot: state.activeSession,
      task,
      contextAttachments: [],
      clearDraft: false,
      activateSession: false,
    });
  return {
    state,
    options,
    submission,
    active,
    unsettled,
    progressRoutes,
    enqueue,
    submit,
    send: (task: string) => {
      const action = getSessionMessageRunningAction({
        session: state.activeSession,
        activeTaskId: [...active.current.keys()].at(-1) ?? null,
        unsettledTaskId: options.getUnsettledTaskId(session.id),
        runningAction: "queue",
      });
      if (action === "queue") {
        enqueue(task);
        return "queued";
      }
      return submit(task) ? "submitted" : "rejected";
    },
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", globalThis);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("chat execution lifecycle", () => {
  it("queues messages during Git diff processing and drains them once after settlement", async () => {
    vi.useFakeTimers();
    const work = setup();
    const first = deferred<TaskResult>();
    const second = deferred<TaskResult>();
    vi.mocked(runDesktopTask)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(success("Done"));

    expect(work.send("First")).toBe("submitted");
    await vi.advanceTimersByTimeAsync(0);
    const taskId = [...work.progressRoutes.current.keys()][0];
    work.progressRoutes.current.get(taskId)?.onProgress?.(
      {
        task: "First",
        mode: "machdoch",
        state: "completed",
        message: "Done",
        executedTools: [],
        outputSections: [],
        cancellable: false,
      },
      Date.now(),
    );
    await vi.advanceTimersByTimeAsync(1600);

    expect(getSessionOverviewStatus(work.state.activeSession)).toBe("done");
    expect(work.active.current.size).toBe(0);
    expect(work.unsettled.current.has(taskId)).toBe(true);
    expect(work.send("During diff")).toBe("queued");
    await processAutomaticChatWork(() => work.options);
    expect(runDesktopTask).toHaveBeenCalledTimes(1);
    expect(work.state.shellState.queuedSessionMessages[0]).toMatchObject({
      task: "During diff",
      blockedByTaskId: taskId,
      status: "queued",
    });

    first.resolve(success("First"));
    expect(work.send("At settlement")).toBe("queued");
    const queueIds = work.state.shellState.queuedSessionMessages.map(
      (message) => message.id,
    );
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([
      processAutomaticChatWork(() => work.options),
      processAutomaticChatWork(() => work.options),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(runDesktopTask).mock.calls.map((call) => call[1])).toEqual(
      ["First", "During diff"],
    );
    expect(
      work.state.shellState.queuedSessionMessages.map((item) => item.id),
    ).toEqual([queueIds[1]]);

    expect(work.send("While running")).toBe("queued");
    second.resolve(success("During diff"));
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 3; index += 1) {
      await processAutomaticChatWork(() => work.options);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(work.send("After idle")).toBe("submitted");
    await vi.advanceTimersByTimeAsync(0);
    const expectedTasks = [
      "First",
      "During diff",
      "At settlement",
      "While running",
      "After idle",
    ];
    expect(vi.mocked(runDesktopTask).mock.calls.map((call) => call[1])).toEqual(
      expectedTasks,
    );
    expect(
      work.state.activeSession.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content),
    ).toEqual(expectedTasks);
    expect(work.state.shellState.queuedSessionMessages).toEqual([]);
    expect(Object.keys(work.state.shellState.queuedMessageTombstones)).toEqual(
      expect.arrayContaining(queueIds),
    );
    expect(work.unsettled.current.size).toBe(0);
  });

  it("retains queued messages when a new send starts as the session becomes idle", async () => {
    const work = setup();
    const first = deferred<TaskResult>();
    const immediate = deferred<TaskResult>();
    vi.mocked(runDesktopTask)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(immediate.promise)
      .mockResolvedValue(success("Queued"));

    expect(work.send("First")).toBe("submitted");
    expect(work.send("Queued")).toBe("queued");
    first.resolve(success("First"));
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    expect(work.send("At idle")).toBe("submitted");
    await processAutomaticChatWork(() => work.options);
    expect(work.state.shellState.queuedSessionMessages).toHaveLength(1);
    immediate.resolve(success("At idle"));
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    await Promise.all([
      processAutomaticChatWork(() => work.options),
      processAutomaticChatWork(() => work.options),
    ]);
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    expect(vi.mocked(runDesktopTask).mock.calls.map((call) => call[1])).toEqual(
      ["First", "At idle", "Queued"],
    );
    expect(work.state.shellState.queuedSessionMessages).toEqual([]);
  });

  it("waits for the native promise after terminal progress and preserves a late cancellation", async () => {
    vi.useFakeTimers();
    const work = setup();
    const first = deferred<TaskResult>();
    vi.mocked(runDesktopTask)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(success("Next"));
    work.submit("First");
    work.enqueue("Next");
    await vi.advanceTimersByTimeAsync(0);
    const taskId = [...work.progressRoutes.current.keys()][0];
    work.progressRoutes.current.get(taskId)?.onProgress?.(
      {
        task: "First",
        mode: "machdoch",
        state: "completed",
        message: "Done",
        executedTools: [],
        outputSections: [],
        cancellable: false,
      },
      Date.now(),
    );
    await vi.advanceTimersByTimeAsync(1600);
    expect(work.unsettled.current.size).toBe(1);
    await processAutomaticChatWork(() => work.options);
    expect(runDesktopTask).toHaveBeenCalledTimes(1);
    first.reject(
      new DesktopTaskRunProtocolError({
        kind: "cancelled",
        message: "Stopped during completion",
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(
      getSessionTaskOutcome(work.state.activeSession, taskId)?.status,
    ).toBe("cancelled");
    await processAutomaticChatWork(() => work.options);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.mocked(runDesktopTask).mock.calls.map((call) => call[1])).toEqual(
      ["First", "Next"],
    );
  });

  it("persists the attempt before invoking a provider", async () => {
    const work = setup();
    const persistence = deferred<void>();
    work.state.flushPersistence.mockReturnValueOnce(persistence.promise);
    vi.mocked(runDesktopTask).mockResolvedValue(success("Task"));
    expect(work.submit("Task")).toBe(true);
    await Promise.resolve();
    expect(runDesktopTask).not.toHaveBeenCalled();
    expect(
      work.state.activeSession.messages[0].executionAttempt?.retryNumber,
    ).toBe(0);
    expect(work.unsettled.current.size).toBe(1);
    persistence.resolve();
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    expect(runDesktopTask).toHaveBeenCalledTimes(1);
  });

  it("advances multiple queued tasks automatically, once each, after settlement", async () => {
    const work = setup();
    const first = deferred<TaskResult>();
    vi.mocked(runDesktopTask)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(success("Queued"));
    work.submit("First");
    work.enqueue("Second");
    work.enqueue("Third");
    await processAutomaticChatWork(() => work.options);
    expect(runDesktopTask).toHaveBeenCalledTimes(1);
    first.resolve(success("First"));
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    await processAutomaticChatWork(() => work.options);
    await processAutomaticChatWork(() => work.options);
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    await processAutomaticChatWork(() => work.options);
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    await processAutomaticChatWork(() => work.options);
    expect(vi.mocked(runDesktopTask).mock.calls.map((call) => call[1])).toEqual(
      ["First", "Second", "Third"],
    );
    expect(work.state.shellState.queuedSessionMessages).toEqual([]);
    expect(
      hasPendingChatWork(work.state.shellState, work.options.settings),
    ).toBe(false);
  });

  it("passes provider failure context into bounded retries before advancing the queue", async () => {
    const work = setup();
    const failure = new DesktopTaskRunProtocolError({
      kind: "runtime",
      message: "Provider HTTP 503; request abc",
    });
    vi.mocked(runDesktopTask).mockRejectedValue(failure);
    work.submit("Original objective");
    work.enqueue("Next objective");
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    expect(
      hasPendingChatWork(work.state.shellState, work.options.settings),
    ).toBe(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 100_000);
    for (let retry = 1; retry <= 2; retry += 1) {
      await Promise.all([
        processAutomaticChatWork(() => work.options),
        processAutomaticChatWork(() => work.options),
      ]);
      await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
      expect(runDesktopTask).toHaveBeenCalledTimes(retry + 1);
      expect(
        work.state.activeSession.messages
          .filter((message) => message.role === "user")
          .at(-1)?.executionAttempt?.retryNumber,
      ).toBe(retry);
      clock.mockReturnValue(Date.now() + 100_000);
    }
    const retryPrompt = vi.mocked(runDesktopTask).mock.calls[1][1];
    expect(
      work.state.activeSession.messages
        .filter((message) => message.role === "user")
        .at(-1)?.content,
    ).toBe("Original objective");
    expect(retryPrompt).toContain("Original objective");
    expect(retryPrompt).toContain("Provider HTTP 503; request abc");
    vi.mocked(runDesktopTask).mockResolvedValue(success("Next objective"));
    await processAutomaticChatWork(() => work.options);
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    expect(runDesktopTask).toHaveBeenCalledTimes(4);
    expect(vi.mocked(runDesktopTask).mock.calls[3][1]).toBe("Next objective");
  });

  it("retries a failed provider result and keeps its diagnostic reason", async () => {
    const work = setup();
    const result = success("Task");
    result.execution.status = "failed";
    result.execution.reason = "Provider connection closed unexpectedly";
    vi.mocked(runDesktopTask)
      .mockResolvedValueOnce(result)
      .mockResolvedValue(success("Task"));
    work.submit("Task");
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 100_000);
    await processAutomaticChatWork(() => work.options);
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    expect(runDesktopTask).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runDesktopTask).mock.calls[1][1]).toContain(
      "Provider connection closed unexpectedly",
    );
  });

  it("advances after failure when retries are disabled and never retries cancellation", async () => {
    const work = setup();
    work.options.settings = {
      ...work.options.settings,
      automaticRetries: false,
    };
    vi.mocked(runDesktopTask)
      .mockRejectedValueOnce(new Error("Provider failed"))
      .mockRejectedValueOnce(
        new DesktopTaskRunProtocolError({
          kind: "cancelled",
          message: "Stopped",
        }),
      );
    work.submit("Fail");
    work.enqueue("Cancel");
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    await processAutomaticChatWork(() => work.options);
    await vi.waitFor(() => expect(work.unsettled.current.size).toBe(0));
    const latestTask = work.state.activeSession.messages
      .filter((message) => message.role === "user")
      .at(-1)!;
    expect(
      getSessionTaskOutcome(work.state.activeSession, latestTask.taskId!)
        ?.status,
    ).toBe("cancelled");
    work.options.settings = {
      ...work.options.settings,
      automaticRetries: true,
    };
    await processAutomaticChatWork(() => work.options);
    expect(runDesktopTask).toHaveBeenCalledTimes(2);
  });
});
