import { describe, expect, it, vi } from "vitest";
import { DEFAULT_USER_AGENT_LIMITS_SETTINGS as settings } from "../../../core/runtime-contract.generated.js";
import {
  createInitialShellState,
  createSession,
  type ChatSessionQueuedMessage,
} from "../chat-session.model";
import { hasPendingChatWork, IdleShutdownMonitor } from "./shutdown-when-idle";

describe("shutdown eligibility", () => {
  it("includes other chats, queued messages, and pending retries", () => {
    const state = createInitialShellState();
    expect(hasPendingChatWork(state, settings)).toBe(false);
    state.sessions.push(
      createSession({
        id: "background",
        messages: [
          {
            id: "task",
            role: "user",
            content: "Work",
            executionAttempt: {
              rootTaskId: "task",
              task: "Work",
              retryNumber: 0,
              retryLimit: 2,
            },
          },
        ],
      }),
    );
    expect(hasPendingChatWork(state, settings)).toBe(true);
    state.sessions.at(-1)!.messages.push({
      id: "failure",
      taskId: "task",
      role: "agent",
      content: "Provider error",
      outcome: { status: "failed" },
    });
    expect(hasPendingChatWork(state, settings)).toBe(true);
    expect(
      hasPendingChatWork(state, { ...settings, automaticRetries: false }),
    ).toBe(false);
    state.queuedSessionMessages.push({
      id: "queued",
      status: "queued",
    } as ChatSessionQueuedMessage);
    expect(
      hasPendingChatWork(state, { ...settings, automaticRetries: false }),
    ).toBe(true);
    state.queuedSessionMessages[0].status = "failed";
    expect(
      hasPendingChatWork(state, { ...settings, automaticRetries: false }),
    ).toBe(true);
    state.queuedSessionMessages = [];
    expect(
      hasPendingChatWork(state, { ...settings, automaticRetries: false }),
    ).toBe(false);
  });

  it("resets the quiet period whenever any chat, image, or retry work remains", async () => {
    const monitor = new IdleShutdownMonitor(5000);
    const shutdown = vi.fn(async () => true);
    const inspect = vi.fn(async () => ({ busy: false, revision: 4 }));
    expect(await monitor.check(inspect, shutdown, 0)).toBe(false);
    monitor.setEnabled(true);
    await monitor.check(inspect, shutdown, 0);
    await monitor.check(
      async () => ({ busy: true, revision: 5 }),
      shutdown,
      4900,
    );
    await monitor.check(inspect, shutdown, 5000);
    await monitor.check(inspect, shutdown, 9999);
    expect(shutdown).not.toHaveBeenCalled();
    expect(await monitor.check(inspect, shutdown, 10000)).toBe(true);
    await monitor.check(inspect, shutdown, 20000);
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("rechecks after native activity or a changed snapshot prevents shutdown", async () => {
    const monitor = new IdleShutdownMonitor(5);
    monitor.setEnabled(true);
    const inspect = async () => ({ busy: false, revision: 4 });
    const shutdown = vi.fn(async () => false);
    await monitor.check(inspect, shutdown, 0);
    await monitor.check(inspect, shutdown, 5);
    await monitor.check(inspect, shutdown, 6);
    expect(shutdown).toHaveBeenCalledTimes(1);
    await monitor.check(inspect, shutdown, 11);
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it("requires a fresh quiet period after work changes between inspections", async () => {
    const monitor = new IdleShutdownMonitor(5000);
    monitor.setEnabled(true);
    const shutdown = vi.fn(async () => true);
    await monitor.check(
      async () => ({ busy: false, revision: 1 }),
      shutdown,
      0,
    );
    await monitor.check(
      async () => ({ busy: false, revision: 2 }),
      shutdown,
      5000,
    );
    await monitor.check(
      async () => ({ busy: false, revision: 2 }),
      shutdown,
      9999,
    );
    expect(shutdown).not.toHaveBeenCalled();
    expect(
      await monitor.check(
        async () => ({ busy: false, revision: 2 }),
        shutdown,
        10000,
      ),
    ).toBe(true);
  });

  it("cancels an in-flight inspection and treats failed checks as unknown activity", async () => {
    const monitor = new IdleShutdownMonitor(0);
    monitor.setEnabled(true);
    let resolve!: (value: { busy: boolean; revision: number }) => void;
    const shutdown = vi.fn(async () => true);
    const checking = monitor.check(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      shutdown,
    );
    monitor.setEnabled(false);
    resolve({ busy: false, revision: 4 });
    await checking;
    expect(shutdown).not.toHaveBeenCalled();
    monitor.setEnabled(true);
    await expect(
      monitor.check(async () => {
        throw new Error("Activity unavailable");
      }, shutdown),
    ).rejects.toThrow("Activity unavailable");
    expect(shutdown).not.toHaveBeenCalled();
  });
});
