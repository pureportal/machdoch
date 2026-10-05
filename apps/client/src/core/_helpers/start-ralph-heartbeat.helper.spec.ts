import { afterEach, expect, it, vi } from "vitest";
import { startRalphHeartbeat } from "./start-ralph-heartbeat.helper.js";

afterEach(() => vi.useRealTimers());

it("stops after a slow renewal without waiting for queued renewals", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const renewal = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refresh = vi.fn(() => renewal);
  const onError = vi.fn();
  const stop = startRalphHeartbeat(refresh, 250, onError);
  await vi.advanceTimersByTimeAsync(10_000);
  const stopped = stop();
  release();
  await stopped;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});

it("reports a renewal failure and renews again on the next interval", async () => {
  vi.useFakeTimers();
  const error = new Error("Temporary lock contention");
  const refresh = vi
    .fn()
    .mockRejectedValueOnce(error)
    .mockResolvedValue(undefined);
  const onError = vi.fn();
  const stop = startRalphHeartbeat(refresh, 250, onError);
  await vi.advanceTimersByTimeAsync(500);
  await stop();
  expect(onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(refresh).toHaveBeenCalledTimes(2);
});
