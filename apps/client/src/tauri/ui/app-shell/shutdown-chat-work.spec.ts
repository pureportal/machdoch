import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS as settings } from "../../../core/runtime-contract.generated.js";
import {
  createInitialShellState,
  createSession,
  type ChatSessionQueuedMessage,
  type ShellPersistedState,
} from "../chat-session.model";
import {
  hasPendingChatWork,
  IdleShutdownMonitor,
  PendingChatWorkInspector,
  type ShutdownWhenIdleOptions,
} from "./shutdown-when-idle";

const taskState = (
  status?: "succeeded" | "failed",
  retryNumber = 0,
): ShellPersistedState => {
  const session = createSession({
    id: "background",
    messages: [
      {
        id: "task",
        role: "user",
        content: "Work",
        executionAttempt: {
          rootTaskId: "task",
          task: "Work",
          retryNumber,
          retryLimit: 2,
        },
      },
    ],
  });
  if (status) {
    session.messages.push({
      id: "result",
      taskId: "task",
      role: "agent",
      content: "Result",
      outcome: { status },
    });
  }
  return { ...createInitialShellState(), sessions: [session] };
};

const queuedMessage = (
  sessionId: string,
  status: ChatSessionQueuedMessage["status"] = "queued",
): ChatSessionQueuedMessage => ({
  id: "queued",
  sessionId,
  task: "Work",
  status,
  contentUpdatedAt: 1,
  attachmentsUpdatedAt: 1,
  attachmentTombstones: {},
  blockerUpdatedAt: 1,
  orderRank: 0,
  orderUpdatedAt: 1,
  statusUpdatedAt: 1,
  contextAttachments: [],
  createdAt: 1,
  updatedAt: 1,
});

const setup = (state = createInitialShellState(), persisted = state) => {
  let options: ShutdownWhenIdleOptions = {
    ready: true,
    state,
    settings,
    hasUnsettledWork: () => false,
    flush: vi.fn(async () => undefined),
  };
  let snapshot = { state: persisted, revision: 10 };
  const loadRevision = vi.fn(async () => snapshot.revision);
  const loadSnapshot = vi.fn(async () => snapshot);
  const inspector = new PendingChatWorkInspector(loadRevision, loadSnapshot);
  return {
    inspector,
    loadRevision,
    loadSnapshot,
    read: () => options,
    inspect: () => inspector.inspect(() => options),
    update: (patch: Partial<ShutdownWhenIdleOptions>) => {
      options = { ...options, ...patch };
    },
    persist: (state: ShellPersistedState) => {
      snapshot = { state, revision: snapshot.revision + 1 };
    },
  };
};

describe("shared shutdown chat activity", () => {
  it("lets a stale window become idle when another window finishes work", async () => {
    const local = taskState();
    const work = setup(local);
    const monitor = new IdleShutdownMonitor(5000);
    const shutdown = vi.fn(async () => true);
    monitor.setEnabled(true);

    expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    expect(await monitor.check(work.inspect, shutdown, 0)).toBe(false);
    work.persist(taskState("succeeded"));
    expect(hasPendingChatWork(local, settings)).toBe(true);
    expect(await work.inspect()).toEqual({ busy: false, revision: 11 });
    expect(await monitor.check(work.inspect, shutdown, 1000)).toBe(false);
    expect(await monitor.check(work.inspect, shutdown, 5999)).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    expect(await monitor.check(work.inspect, shutdown, 6000)).toBe(true);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(11);
  });

  it("clears stale queues and retry candidates after another window drains them", async () => {
    const state = taskState("failed");
    state.queuedSessionMessages = [queuedMessage("background")];
    const work = setup(state, taskState("succeeded", 2));
    expect(hasPendingChatWork(state, settings)).toBe(true);
    expect(await work.inspect()).toEqual({ busy: false, revision: 10 });
  });

  it("keeps work saved by another window busy even when the local state is idle", async () => {
    const work = setup(createInitialShellState(), taskState());
    expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    work.persist(taskState("failed"));
    expect(await work.inspect()).toEqual({ busy: true, revision: 11 });
    work.persist(taskState("failed", settings.retryAttempts));
    expect(await work.inspect()).toEqual({ busy: false, revision: 12 });
    const queued = createInitialShellState();
    queued.queuedSessionMessages = [
      queuedMessage(queued.sessions[0].id, "failed"),
    ];
    work.persist(queued);
    expect(await work.inspect()).toEqual({ busy: false, revision: 13 });
  });

  it.each(["queued", "enhancing", "dispatching", "failed"] as const)(
    "ignores an orphaned %s entry that the work dispatcher cannot run",
    async (status) => {
      const state = createInitialShellState();
      state.queuedSessionMessages = [queuedMessage("deleted-chat", status)];
      expect(await setup(state).inspect()).toEqual({
        busy: false,
        revision: 10,
      });
    },
  );

  it("flushes local changes before inspecting shared activity", async () => {
    const work = setup(taskState(), createInitialShellState());
    work.update({
      flush: async () => {
        work.persist(work.read().state);
      },
    });
    expect(await work.inspect()).toEqual({ busy: true, revision: 11 });
  });

  it("does not reload unchanged snapshots but reevaluates current retry settings", async () => {
    const work = setup(taskState("failed"));
    expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    work.update({ settings: { ...settings, automaticRetries: false } });
    expect(await work.inspect()).toEqual({ busy: false, revision: 10 });
    expect(work.loadSnapshot).toHaveBeenCalledTimes(1);
    expect(work.loadRevision).toHaveBeenCalledTimes(2);
  });

  it.each(["hydrating", "unsettled", "transient"] as const)(
    "keeps %s local work busy even when saved state is idle",
    async (kind) => {
      const work = setup();
      if (kind === "hydrating") work.update({ ready: false });
      if (kind === "unsettled") work.update({ hasUnsettledWork: () => true });
      if (kind === "transient") {
        const state = createInitialShellState();
        state.sessions[0].messages.push({
          id: "interview",
          taskId: "interview",
          role: "user",
          content: "Work",
          lifecycle: {
            kind: "transient",
            owner: "task-interview",
            operationId: "interview",
            slot: "user",
            ownerLaunchId: "launch",
            ownerWindowId: "window",
            ownerInstanceId: "instance",
          },
        });
        work.update({ state });
      }
      expect(await work.inspect()).toEqual({ busy: true, revision: 0 });
      expect(work.loadSnapshot).not.toHaveBeenCalled();
      expect(work.loadRevision).not.toHaveBeenCalled();
    },
  );

  it.each(["flush", "revision", "snapshot"] as const)(
    "rejects an idle result when local state changes during %s",
    async (phase) => {
      const work = setup();
      const change = () => work.update({ state: taskState() });
      if (phase === "flush") work.update({ flush: async () => change() });
      if (phase === "revision")
        work.loadRevision.mockImplementationOnce(async () => {
          change();
          return 10;
        });
      if (phase === "snapshot")
        work.loadSnapshot.mockImplementationOnce(async () => {
          change();
          return { state: createInitialShellState(), revision: 10 };
        });
      expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    },
  );

  it("rechecks non-reactive activity and settings after an asynchronous read", async () => {
    const work = setup();
    let unsettled = false;
    work.update({ hasUnsettledWork: () => unsettled });
    work.loadSnapshot.mockImplementationOnce(async () => {
      unsettled = true;
      return { state: createInitialShellState(), revision: 10 };
    });
    expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    unsettled = false;
    work.loadRevision.mockImplementationOnce(async () => {
      work.update({ settings: { ...settings, automaticRetries: false } });
      return 10;
    });
    expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    expect(await work.inspect()).toEqual({ busy: false, revision: 10 });
  });

  it.each(["flush", "revision", "snapshot"] as const)(
    "propagates %s failures rather than treating unknown activity as idle",
    async (phase) => {
      const work = setup();
      const failure = new Error("Storage unavailable");
      if (phase === "flush")
        work.update({ flush: async () => Promise.reject(failure) });
      if (phase === "revision")
        work.loadRevision.mockRejectedValueOnce(failure);
      if (phase === "snapshot")
        work.loadSnapshot.mockRejectedValueOnce(failure);
      await expect(work.inspect()).rejects.toThrow(failure);
    },
  );
});
