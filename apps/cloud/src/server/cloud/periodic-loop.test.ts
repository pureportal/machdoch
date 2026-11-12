import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CloudPeriodicLoop } from "./periodic-loop";

let startedAt: number;
const loops: CloudPeriodicLoop[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  startedAt = Date.now();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  for (const loop of loops.splice(0)) await loop.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function loopWith(outcomes: (number | Error)[]) {
  const calls: number[] = [];
  const tick = vi.fn(async () => {
    calls.push(Date.now() - startedAt);
    const outcome = outcomes.shift() ?? 0;
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  const loop = new CloudPeriodicLoop("Schedule dispatch", tick, 5);
  loops.push(loop);
  return { loop, tick, calls };
}

it("dispatches at once, then every five seconds or after one second while a full batch was due", async () => {
  const { loop, calls } = loopWith([5, 2, 0]);
  loop.start();
  loop.start();
  await vi.advanceTimersByTimeAsync(11_000);
  expect(calls).toEqual([0, 1000, 6000, 11_000]);
});

it("retries failed dispatches with a doubling delay capped at one minute and resets after success", async () => {
  const failure = new Error("database unavailable");
  const { loop, calls } = loopWith([
    ...Array.from({ length: 7 }, () => failure),
    0,
    failure,
  ]);
  loop.start();
  await vi.advanceTimersByTimeAsync(200_000);
  expect(calls.slice(0, 10)).toEqual([
    0, 2000, 6000, 14_000, 30_000, 62_000, 122_000, 182_000, 187_000, 189_000,
  ]);
  expect(console.error).toHaveBeenCalledWith(
    "Schedule dispatch failed",
    "Error",
  );
});

it("waits for the running dispatch on close and never dispatches again", async () => {
  let finish: (processed: number) => void = () => undefined;
  const tick = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const loop = new CloudPeriodicLoop("Schedule dispatch", tick, 5);
  loop.start();
  await vi.advanceTimersByTimeAsync(0);
  let closed = false;
  const closing = loop.close().then(() => {
    closed = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toBe(false);
  finish(5);
  await closing;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(tick).toHaveBeenCalledTimes(1);
  expect(() => loop.start()).toThrow("Schedule dispatch is closed.");
});
