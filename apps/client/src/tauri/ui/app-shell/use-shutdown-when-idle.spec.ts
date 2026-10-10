// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen, type Event } from "@tauri-apps/api/event";
import { createDeferred } from "./__test__/deferred";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS as settings } from "../../../core/runtime-contract.generated.js";
import {
  createInitialShellState,
  createSession,
  type ChatSessionQueuedMessage,
} from "../chat-session.model";
import {
  loadShellStateRevision,
  loadShellStateSnapshot,
} from "../lib/shell-store";
import {
  useShutdownWhenIdle,
  type ShutdownWhenIdleOptions,
} from "./use-shutdown-when-idle";

const activity = vi.hoisted(() => ({
  media: false,
  native: false,
  chat: false,
  mode: { enabled: false, generation: 0 },
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("../lib/shell-store", () => ({
  loadShellStateRevision: vi.fn(),
  loadShellStateSnapshot: vi.fn(),
}));
vi.mock(
  "@machdoch/media-studio/tauri/ui/media/media-generation-service.js",
  () => ({
    hasPendingMediaGeneration: () => activity.media,
  }),
);

beforeEach(() => {
  vi.useFakeTimers();
  activity.media = false;
  activity.native = false;
  activity.chat = false;
  activity.mode = { enabled: false, generation: 0 };
  vi.mocked(listen).mockClear();
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      if (command === "supports_idle_shutdown") return true;
      if (command === "get_shutdown_when_idle") return { ...activity.mode };
      if (command === "set_shutdown_when_idle") {
        const enabled = (args as { enabled: boolean }).enabled;
        if (
          (args as { expectedGeneration: number }).expectedGeneration !==
          activity.mode.generation
        )
          return { ...activity.mode };
        if (activity.mode.enabled !== enabled) {
          activity.mode = { enabled, generation: activity.mode.generation + 1 };
        }
        return { ...activity.mode };
      }
      if (command === "set_window_pending_chat_work") {
        activity.chat = (args as { pending: boolean }).pending;
      }
      if (command === "has_pending_shutdown_work")
        return activity.native || activity.chat;
      if (command === "shutdown_if_idle") {
        if (
          !activity.mode.enabled ||
          (args as { expectedGeneration: number }).expectedGeneration !==
            activity.mode.generation
        )
          return false;
        activity.mode = {
          enabled: false,
          generation: activity.mode.generation + 1,
        };
        return true;
      }
      return undefined;
    });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const advance = async (milliseconds = 10_000) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
};

const shutdownCalls = () =>
  vi
    .mocked(invoke)
    .mock.calls.filter(([command]) => command === "shutdown_if_idle");

const publishMode = (enabled: boolean, generation: number): void => {
  activity.mode = { enabled, generation };
  const callback = vi.mocked(listen).mock.calls.at(-1)![1];
  callback({
    event: "shutdown-when-idle-changed",
    id: 1,
    payload: { enabled, generation },
  } as Event<unknown>);
};

const setup = async (autoEnable = true) => {
  const options: ShutdownWhenIdleOptions = {
    ready: true,
    state: createInitialShellState(),
    settings,
    hasUnsettledWork: () => false,
    flush: vi.fn(async () => undefined),
  };
  let persisted = options.state;
  let revision = 10;
  vi.mocked(loadShellStateRevision)
    .mockReset()
    .mockImplementation(async () => revision);
  vi.mocked(loadShellStateSnapshot)
    .mockReset()
    .mockImplementation(async () => ({ state: persisted, revision }));
  const view = renderHook(
    (input: ShutdownWhenIdleOptions) => useShutdownWhenIdle(input),
    { initialProps: options },
  );
  await act(async () => {});
  if (autoEnable) {
    await act(async () => {
      await view.result.current.toggle();
    });
  }
  const update = (patch: Partial<ShutdownWhenIdleOptions>) => {
    Object.assign(options, patch);
    persisted = options.state;
    revision += 1;
    view.rerender({ ...options });
  };
  return {
    ...view,
    options,
    update,
    persist: (state: typeof persisted) => {
      persisted = state;
      revision += 1;
    },
  };
};

describe("shutdown monitoring across chat and image work", () => {
  it("shuts down only after queued messages, retries, image jobs and settlement have all drained", async () => {
    const view = await setup();
    const background = createSession({ id: "background" });
    const queued = {
      id: "queued",
      sessionId: background.id,
      task: "Work",
      status: "queued",
    } as ChatSessionQueuedMessage;
    view.update({
      state: {
        ...view.options.state,
        sessions: [background],
        queuedSessionMessages: [queued],
      },
    });
    for (const status of ["queued", "enhancing", "dispatching"] as const) {
      view.update({
        state: {
          ...view.options.state,
          queuedSessionMessages: [{ ...queued, status }],
        },
      });
      await advance();
      expect(shutdownCalls()).toEqual([]);
    }
    background.messages.push({
      id: "task",
      role: "user",
      content: "Work",
      executionAttempt: {
        rootTaskId: "task",
        task: "Work",
        retryNumber: 0,
        retryLimit: 2,
      },
    });
    view.update({
      state: { ...view.options.state, queuedSessionMessages: [] },
    });
    await advance();
    expect(shutdownCalls()).toEqual([]);
    background.messages.push({
      id: "result",
      taskId: "task",
      role: "agent",
      content: "Failed",
      outcome: { status: "failed" },
    });
    view.update({ state: { ...view.options.state } });
    await advance(60_000);
    expect(shutdownCalls()).toEqual([]);
    background.messages[0].executionAttempt!.retryNumber = 2;
    activity.media = true;
    view.update({ state: { ...view.options.state } });
    await advance();
    expect(shutdownCalls()).toEqual([]);
    activity.media = false;
    activity.native = true;
    await advance();
    expect(shutdownCalls()).toEqual([]);
    activity.native = false;
    let unsettled = true;
    view.update({ hasUnsettledWork: () => unsettled });
    await advance();
    expect(activity.chat).toBe(true);
    expect(shutdownCalls()).toEqual([]);
    unsettled = false;
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
    expect(shutdownCalls()[0][1]).toEqual({
      expectedRevision: await loadShellStateRevision(),
      expectedGeneration: 1,
    });
    expect(view.result.current.enabled).toBe(false);
  });

  it("inspects queued work persisted by another window even when the local view is idle", async () => {
    const view = await setup();
    const background = createSession({ id: "background" });
    view.persist({
      ...view.options.state,
      sessions: [background],
      queuedSessionMessages: [
        {
          id: "other-window",
          sessionId: background.id,
          task: "Pending",
          status: "queued",
        } as ChatSessionQueuedMessage,
      ],
    });
    await advance();
    expect(shutdownCalls()).toEqual([]);
    view.persist(view.options.state);
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
  });

  it("disarms when work inspection fails", async () => {
    const view = await setup();
    vi.mocked(loadShellStateRevision).mockRejectedValue(
      new Error("Storage unavailable"),
    );
    await advance();
    expect(shutdownCalls()).toEqual([]);
    expect(view.result.current.enabled).toBe(false);
    expect(invoke).toHaveBeenCalledWith("set_shutdown_when_idle", {
      enabled: false,
      expectedGeneration: 1,
    });
  });

  it("finishes with failed entries retained and orphaned entries hidden from the UI", async () => {
    const view = await setup();
    view.persist({
      ...view.options.state,
      queuedSessionMessages: [
        {
          id: "failed",
          sessionId: view.options.state.sessions[0].id,
          status: "failed",
        },
        { id: "orphan", sessionId: "deleted-chat", status: "queued" },
      ] as ChatSessionQueuedMessage[],
    });
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
    expect(view.result.current.enabled).toBe(false);
  });

  it("finishes despite a new saved revision on every poll", async () => {
    const view = await setup();
    vi.mocked(loadShellStateRevision).mockImplementation(
      async () => 10 + Math.floor(performance.now() / 1000),
    );
    vi.mocked(loadShellStateSnapshot).mockImplementation(async () => ({
      state: view.options.state,
      revision: await loadShellStateRevision(),
    }));
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
  });

  it("does not allow changes to the wall clock to shorten the quiet period", async () => {
    await setup();
    await advance(1000);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await advance(3000);
    expect(shutdownCalls()).toEqual([]);
    await advance(3000);
    expect(shutdownCalls()).toHaveLength(1);
  });

  it("keeps native activity checked when the window is hidden", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await setup();
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
  });

  it("preserves a newer event when the initial read resolves with an older mode", async () => {
    const pending = createDeferred<{ enabled: boolean; generation: number }>();
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "get_shutdown_when_idle"
        ? pending.promise
        : original(command, args),
    );
    const view = await setup(false);
    await act(async () => {
      publishMode(true, 3);
      pending.resolve({ enabled: false, generation: 2 });
    });
    expect(view.result.current.enabled).toBe(true);
    expect(view.result.current.available).toBe(true);
    await advance(6000);
    expect(shutdownCalls()[0][1]).toEqual({
      expectedRevision: 10,
      expectedGeneration: 3,
    });
  });

  it("ignores old events after cancellation and rearming", async () => {
    const view = await setup();
    await act(async () => {
      publishMode(false, 2);
      publishMode(true, 3);
    });
    const callback = vi.mocked(listen).mock.calls.at(-1)![1];
    await act(async () => {
      callback({
        event: "shutdown-when-idle-changed",
        id: 1,
        payload: { enabled: false, generation: 2 },
      } as Event<unknown>);
    });
    expect(view.result.current.enabled).toBe(true);
    await advance();
    expect(shutdownCalls()[0][1]).toEqual({
      expectedRevision: 10,
      expectedGeneration: 3,
    });
  });

  it("blocks duplicate clicks before React updates the changing state", async () => {
    const view = await setup(false);
    const pending = createDeferred<{ enabled: boolean; generation: number }>();
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) =>
      command === "set_shutdown_when_idle"
        ? pending.promise
        : original(command, args),
    );
    await act(async () => {
      const first = view.result.current.toggle();
      const second = view.result.current.toggle();
      pending.resolve({ enabled: true, generation: 1 });
      await Promise.all([first, second]);
    });
    expect(
      vi
        .mocked(invoke)
        .mock.calls.filter(([command]) => command === "set_shutdown_when_idle"),
    ).toHaveLength(1);
    expect(view.result.current.enabled).toBe(true);
  });

  it("does not let a delayed enable request override a later cancellation", async () => {
    const view = await setup(false);
    const pending = createDeferred<void>();
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "set_shutdown_when_idle") await pending.promise;
      return original(command, args);
    });
    let toggle!: Promise<void>;
    await act(async () => {
      toggle = view.result.current.toggle();
      publishMode(false, 2);
      pending.resolve();
      await toggle;
    });
    expect(invoke).toHaveBeenCalledWith("set_shutdown_when_idle", {
      enabled: true,
      expectedGeneration: 0,
    });
    expect(view.result.current.enabled).toBe(false);
    await advance();
    expect(shutdownCalls()).toEqual([]);
  });

  it.each(["supports_idle_shutdown", "get_shutdown_when_idle"])(
    "reports a failed %s initialization and leaves the control unavailable",
    async (failedCommand) => {
      const original = vi.mocked(invoke).getMockImplementation()!;
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === failedCommand) throw new Error("IPC unavailable");
        return original(command, args);
      });
      const view = await setup(false);
      expect(view.result.current.available).toBe(false);
      expect(view.result.current.error).toContain("could not be loaded");
      await act(async () => {
        await view.result.current.toggle();
      });
      await advance();
      expect(shutdownCalls()).toEqual([]);
    },
  );

  it.each(["flush", "revision", "snapshot", "native"] as const)(
    "disarms a hung %s check and prevents it from triggering shutdown after it recovers",
    async (phase) => {
      const view = await setup();
      const pending = createDeferred<never>();
      if (phase === "flush") view.update({ flush: () => pending.promise });
      if (phase === "revision")
        vi.mocked(loadShellStateRevision).mockImplementationOnce(
          () => pending.promise,
        );
      if (phase === "snapshot") {
        view.persist(view.options.state);
        vi.mocked(loadShellStateSnapshot).mockImplementationOnce(
          () => pending.promise,
        );
      }
      if (phase === "native") {
        const original = vi.mocked(invoke).getMockImplementation()!;
        vi.mocked(invoke).mockImplementation(async (command, args) =>
          command === "has_pending_shutdown_work"
            ? pending.promise
            : original(command, args),
        );
      }
      await advance(31_000);
      expect(view.result.current.enabled).toBe(false);
      expect(view.result.current.error).toContain("timed out");
      expect(shutdownCalls()).toEqual([]);
      pending.reject(new Error("Late failure"));
      await advance(1000);
      expect(shutdownCalls()).toEqual([]);
    },
  );

  it("displays native command failures even when a disarmed event arrives first", async () => {
    const view = await setup();
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "shutdown_if_idle") {
        publishMode(false, 2);
        throw new Error("Access is denied (5)");
      }
      return original(command, args);
    });
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
    expect(view.result.current.enabled).toBe(false);
    expect(view.result.current.error).toContain("Access is denied");
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
  });

  it("restores the enabled monitor when cancelling fails", async () => {
    const view = await setup();
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === "set_shutdown_when_idle")
        throw new Error("IPC unavailable");
      return original(command, args);
    });
    await act(async () => {
      await view.result.current.toggle();
    });
    expect(view.result.current.enabled).toBe(true);
    expect(view.result.current.changing).toBe(false);
    expect(view.result.current.error).toContain("IPC unavailable");
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
  });

  it("stops before native commit when the component unmounts during inspection", async () => {
    const view = await setup();
    const pending = createDeferred<number>();
    vi.mocked(loadShellStateRevision).mockImplementationOnce(
      () => pending.promise,
    );
    await advance(1000);
    view.unmount();
    pending.resolve(10);
    await advance(31_000);
    expect(shutdownCalls()).toEqual([]);
  });

  it("keeps the mode cancellable and reports a failed native disarm", async () => {
    const view = await setup();
    vi.mocked(loadShellStateRevision).mockRejectedValue(
      new Error("Storage unavailable"),
    );
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (
        command === "set_shutdown_when_idle" &&
        (args as { enabled: boolean }).enabled === false
      )
        throw new Error("IPC unavailable");
      return original(command, args);
    });
    await advance(1000);
    expect(view.result.current.enabled).toBe(true);
    expect(view.result.current.error).toContain("could not be disabled");
    expect(shutdownCalls()).toEqual([]);
    vi.mocked(invoke).mockImplementation(original);
    await act(async () => {
      await view.result.current.toggle();
    });
    expect(view.result.current.enabled).toBe(false);
  });

  it("does not overwrite a newer arm when an old check fails", async () => {
    const view = await setup();
    const pending = createDeferred<number>();
    vi.mocked(loadShellStateRevision).mockImplementationOnce(
      () => pending.promise,
    );
    await advance(1000);
    await act(async () => {
      publishMode(false, 2);
      publishMode(true, 3);
      pending.reject(new Error("Old failure"));
    });
    expect(view.result.current.enabled).toBe(true);
    expect(view.result.current.error).toBeNull();
    await advance();
    expect(shutdownCalls()).toHaveLength(1);
    expect(shutdownCalls()[0][1]).toEqual({
      expectedRevision: 10,
      expectedGeneration: 3,
    });
  });
});
