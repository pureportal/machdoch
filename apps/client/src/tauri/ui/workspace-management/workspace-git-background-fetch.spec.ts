import { describe, expect, it, vi } from "vitest";
import {
  backgroundFetchDelay,
  createBackgroundFetchScheduler,
} from "./workspace-git-background-fetch";

const flush = async (): Promise<void> => {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
};

const harness = (fetch: (root: string) => Promise<void>) => {
  let clock = 0;
  let isOnline = true;
  const timers: { at: number; task: () => void; cancelled: boolean }[] = [];
  const scheduler = createBackgroundFetchScheduler({
    intervalMs: 1_000,
    maxBackoffMs: 8_000,
    fetch,
    online: () => isOnline,
    visible: () => true,
    now: () => clock,
    setTimer: (task, delay) => {
      const timer = { at: clock + delay, task, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const advance = async (to: number): Promise<void> => {
    clock = to;
    for (const timer of [...timers]) {
      if (!timer.cancelled && timer.at <= clock) {
        timer.cancelled = true;
        timer.task();
        await flush();
      }
    }
  };
  return {
    scheduler,
    advance,
    setOnline: (value: boolean) => {
      isOnline = value;
    },
  };
};

describe("background fetch scheduler", () => {
  it("fetches on the interval while watched and stops after the last watcher leaves", async () => {
    const fetch = vi.fn(() => Promise.resolve());
    const { scheduler, advance } = harness(fetch);
    const stop = scheduler.watch("repo");
    await advance(999);
    expect(fetch).not.toHaveBeenCalled();
    await advance(1_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    stop();
    await advance(5_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("backs off exponentially after failures and resets after success", async () => {
    let fail = true;
    const fetch = vi.fn(() =>
      fail ? Promise.reject(new Error("offline")) : Promise.resolve(),
    );
    const { scheduler, advance } = harness(fetch);
    scheduler.watch("repo");
    await advance(1_000);
    expect(scheduler.nextFetchAt("repo")).toBe(3_000);
    await advance(3_000);
    expect(scheduler.nextFetchAt("repo")).toBe(7_000);
    fail = false;
    await advance(7_000);
    expect(scheduler.nextFetchAt("repo")).toBe(8_000);
    expect(backgroundFetchDelay(1_000, 8_000, 10)).toBe(8_000);
  });

  it("skips fetching while offline and after a manual fetch", async () => {
    const fetch = vi.fn(() => Promise.resolve());
    const { scheduler, advance, setOnline } = harness(fetch);
    scheduler.watch("repo");
    setOnline(false);
    await advance(1_000);
    expect(fetch).not.toHaveBeenCalled();
    setOnline(true);
    await advance(1_500);
    scheduler.fetched("repo");
    await advance(2_000);
    expect(fetch).not.toHaveBeenCalled();
    await advance(2_500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
