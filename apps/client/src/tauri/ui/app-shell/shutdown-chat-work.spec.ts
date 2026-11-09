import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS as settings } from "../../../core/runtime-contract.generated.js";
import { createInitialShellState } from "../chat-session.model";
import {
  IdleShutdownMonitor,
  inspectPendingChatWork,
  type ShutdownWhenIdleOptions,
  type WorkInspection,
} from "./shutdown-when-idle";

const setup = () => {
  let options: ShutdownWhenIdleOptions = {
    ready: true,
    state: createInitialShellState(),
    settings,
    hasUnsettledWork: () => false,
    flush: vi.fn(async () => undefined),
  };
  let persisted: WorkInspection = { busy: false, revision: 10 };
  const inspectPersisted = vi.fn(async () => persisted);
  return {
    inspectPersisted,
    read: () => options,
    inspect: () => inspectPendingChatWork(() => options, inspectPersisted),
    update: (patch: Partial<ShutdownWhenIdleOptions>) => {
      options = { ...options, ...patch };
    },
    persist: (busy: boolean) => {
      persisted = { busy, revision: persisted.revision + 1 };
    },
  };
};

describe("shared shutdown chat activity", () => {
  it("lets a window become idle once saved chat work finishes", async () => {
    const work = setup();
    const monitor = new IdleShutdownMonitor(5000);
    const shutdown = vi.fn(async () => true);
    monitor.setEnabled(true);
    work.persist(true);

    expect(await work.inspect()).toEqual({ busy: true, revision: 11 });
    expect(await monitor.check(work.inspect, shutdown, 0)).toBe(false);
    work.persist(false);
    expect(await work.inspect()).toEqual({ busy: false, revision: 12 });
    expect(await monitor.check(work.inspect, shutdown, 1000)).toBe(false);
    expect(await monitor.check(work.inspect, shutdown, 5999)).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();
    expect(await monitor.check(work.inspect, shutdown, 6000)).toBe(true);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(12);
  });

  it("flushes local changes before inspecting saved activity", async () => {
    const work = setup();
    work.update({ flush: vi.fn(async () => work.persist(true)) });
    expect(await work.inspect()).toEqual({ busy: true, revision: 11 });
  });

  it.each(["hydrating", "unsettled", "transient"] as const)(
    "keeps %s local work busy without inspecting saved activity",
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
      expect(work.read().flush).not.toHaveBeenCalled();
      expect(work.inspectPersisted).not.toHaveBeenCalled();
    },
  );

  it.each(["flush", "inspection"] as const)(
    "rejects an idle result when local state changes during %s",
    async (phase) => {
      const work = setup();
      const change = () => work.update({ state: createInitialShellState() });
      if (phase === "flush") work.update({ flush: async () => change() });
      if (phase === "inspection")
        work.inspectPersisted.mockImplementationOnce(async () => {
          change();
          return { busy: false, revision: 10 };
        });
      expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    },
  );

  it("rechecks non-reactive activity and settings after an asynchronous read", async () => {
    const work = setup();
    let unsettled = false;
    work.update({ hasUnsettledWork: () => unsettled });
    work.inspectPersisted.mockImplementationOnce(async () => {
      unsettled = true;
      return { busy: false, revision: 10 };
    });
    expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    unsettled = false;
    work.inspectPersisted.mockImplementationOnce(async () => {
      work.update({ settings: { ...settings, automaticRetries: false } });
      return { busy: false, revision: 10 };
    });
    expect(await work.inspect()).toEqual({ busy: true, revision: 10 });
    expect(await work.inspect()).toEqual({ busy: false, revision: 10 });
  });

  it.each(["flush", "inspection"] as const)(
    "propagates %s failures rather than treating unknown activity as idle",
    async (phase) => {
      const work = setup();
      const failure = new Error("Storage unavailable");
      if (phase === "flush")
        work.update({ flush: async () => Promise.reject(failure) });
      if (phase === "inspection")
        work.inspectPersisted.mockRejectedValueOnce(failure);
      await expect(work.inspect()).rejects.toThrow(failure);
    },
  );
});
