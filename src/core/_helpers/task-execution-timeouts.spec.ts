import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TASK_EXECUTION_IDLE_TIMEOUT_MS,
  createManagedTaskExecutionTimeout,
  resolveTaskExecutionTimeouts,
} from "./task-execution-timeouts.js";

describe("task execution timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to inactivity detection without an absolute runtime limit", () => {
    expect(resolveTaskExecutionTimeouts({})).toEqual({
      idleTimeoutMs: TASK_EXECUTION_IDLE_TIMEOUT_MS,
      absoluteTimeoutMs: undefined,
    });
  });

  it("supports disabling or enabling each timeout independently", () => {
    expect(resolveTaskExecutionTimeouts({ maxDurationMs: null })).toEqual({
      idleTimeoutMs: undefined,
      absoluteTimeoutMs: undefined,
    });
    expect(
      resolveTaskExecutionTimeouts({
        maxDurationMs: null,
        idleTimeoutMs: 500,
      }),
    ).toEqual({
      idleTimeoutMs: 500,
      absoluteTimeoutMs: undefined,
    });
    expect(resolveTaskExecutionTimeouts({ idleTimeoutMs: null })).toEqual({
      idleTimeoutMs: undefined,
      absoluteTimeoutMs: undefined,
    });
    expect(
      resolveTaskExecutionTimeouts({
        maxDurationMs: 500,
        idleTimeoutMs: null,
      }),
    ).toEqual({
      idleTimeoutMs: undefined,
      absoluteTimeoutMs: 500,
    });
  });

  it("clamps the idle timeout to the absolute deadline", () => {
    expect(
      resolveTaskExecutionTimeouts({
        maxDurationMs: 250,
        idleTimeoutMs: 500,
      }),
    ).toEqual({
      idleTimeoutMs: 250,
      absoluteTimeoutMs: 250,
    });
  });

  it("resets only the idle deadline when activity arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const timeout = createManagedTaskExecutionTimeout(undefined, {
      idleTimeoutMs: 100,
      absoluteTimeoutMs: 500,
    });

    vi.advanceTimersByTime(90);
    timeout.markActivity();

    expect(timeout.getState()).toEqual({
      startedAt: 1_000,
      lastActivityAt: 1_090,
      idleTimeoutMs: 100,
      absoluteTimeoutMs: 500,
    });

    vi.advanceTimersByTime(99);
    expect(timeout.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toContain("without meaningful progress");
  });

  it("does not extend the absolute deadline when activity arrives", () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const timeout = createManagedTaskExecutionTimeout(undefined, {
      idleTimeoutMs: 100,
      absoluteTimeoutMs: 250,
    });

    vi.advanceTimersByTime(90);
    timeout.markActivity();
    vi.advanceTimersByTime(90);
    timeout.markActivity();
    vi.advanceTimersByTime(70);

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).not.toContain("without meaningful progress");
  });

  it("continues beyond sixty minutes while meaningful activity continues", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeout = createManagedTaskExecutionTimeout(
      undefined,
      resolveTaskExecutionTimeouts({}),
    );

    for (let interval = 0; interval < 7; interval += 1) {
      vi.advanceTimersByTime(10 * 60 * 1_000);
      timeout.markActivity();
    }

    expect(Date.now()).toBe(70 * 60 * 1_000);
    expect(timeout.signal.aborted).toBe(false);
    expect(timeout.getState().absoluteTimeoutMs).toBeNull();

    vi.advanceTimersByTime(TASK_EXECUTION_IDLE_TIMEOUT_MS);

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toContain("without meaningful progress");
  });

  it("forwards cancellation from the caller", () => {
    const source = new AbortController();
    const timeout = createManagedTaskExecutionTimeout(source.signal, {
      idleTimeoutMs: undefined,
      absoluteTimeoutMs: undefined,
    });

    source.abort("Stopped by the user.");

    expect(timeout.signal.aborted).toBe(true);
    expect(timeout.signal.reason).toBe("Stopped by the user.");
  });
});
