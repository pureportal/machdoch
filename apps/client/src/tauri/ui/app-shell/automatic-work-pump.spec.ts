import { afterEach, describe, expect, it, vi } from "vitest";
import { startAutomaticWorkPump } from "./automatic-work-pump";

afterEach(() => vi.useRealTimers());

describe("automatic work pump", () => {
  it("checks again when a non-reactive lock settles without a render", async () => {
    vi.useFakeTimers();
    let locked = true;
    const execute = vi.fn();
    const pump = startAutomaticWorkPump(async () => {
      if (!locked) execute();
    }, vi.fn());
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).not.toHaveBeenCalled();
    locked = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(1);
    pump.stop();
  });

  it("coalesces changes during a check and never overlaps checks", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const process = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pump = startAutomaticWorkPump(process, vi.fn());
    pump.wake();
    pump.wake();
    await vi.advanceTimersByTimeAsync(2000);
    expect(process).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(process).toHaveBeenCalledTimes(2);
    pump.stop();
    release();
    await vi.advanceTimersByTimeAsync(10000);
    expect(process).toHaveBeenCalledTimes(2);
  });
});
