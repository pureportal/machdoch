// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS as settings } from "../../../core/runtime-contract.generated.js";
import {
  createInitialShellState,
  createSession,
  type ChatSessionQueuedMessage,
} from "../chat-session.model";
import { loadShellStateSnapshot } from "../lib/shell-store";
import {
  useShutdownWhenIdle,
  type ShutdownWhenIdleOptions,
} from "./use-shutdown-when-idle";

const activity = vi.hoisted(() => ({
  media: false,
  native: false,
  chat: false,
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock("../lib/shell-store", () => ({ loadShellStateSnapshot: vi.fn() }));
vi.mock("../media/media-generation-service", () => ({
  hasPendingMediaGeneration: () => activity.media,
}));

beforeEach(() => {
  vi.useFakeTimers();
  activity.media = false;
  activity.native = false;
  activity.chat = false;
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      if (command === "supports_idle_shutdown") return true;
      if (command === "get_shutdown_when_idle") return false;
      if (command === "set_window_pending_chat_work") {
        activity.chat = (args as { pending: boolean }).pending;
      }
      if (command === "has_pending_shutdown_work")
        return activity.native || activity.chat;
      if (command === "shutdown_if_idle") return true;
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

const setup = async () => {
  const options: ShutdownWhenIdleOptions = {
    ready: true,
    state: createInitialShellState(),
    settings,
    hasUnsettledWork: () => false,
    flush: vi.fn(async () => undefined),
  };
  let persisted = options.state;
  vi.mocked(loadShellStateSnapshot)
    .mockReset()
    .mockImplementation(async () => ({ state: persisted, revision: 10 }));
  const view = renderHook(
    (input: ShutdownWhenIdleOptions) => useShutdownWhenIdle(input),
    { initialProps: options },
  );
  await act(async () => {});
  await act(async () => {
    await view.result.current.toggle();
  });
  const update = (patch: Partial<ShutdownWhenIdleOptions>) => {
    Object.assign(options, patch);
    persisted = options.state;
    view.rerender({ ...options });
  };
  return {
    ...view,
    options,
    update,
    persist: (state: typeof persisted) => {
      persisted = state;
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
    for (const status of [
      "queued",
      "enhancing",
      "dispatching",
      "failed",
    ] as const) {
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
    expect(shutdownCalls()[0][1]).toEqual({ expectedRevision: 10 });
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
    vi.mocked(loadShellStateSnapshot).mockRejectedValue(
      new Error("Storage unavailable"),
    );
    await advance();
    expect(shutdownCalls()).toEqual([]);
    expect(view.result.current.enabled).toBe(false);
    expect(invoke).toHaveBeenCalledWith("set_shutdown_when_idle", {
      enabled: false,
    });
  });
});
