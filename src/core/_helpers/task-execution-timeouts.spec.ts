import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TASK_EXECUTION_ABSOLUTE_TIMEOUT_MS,
  TASK_EXECUTION_IDLE_TIMEOUT_MS,
  createManagedTaskExecutionTimeout,
  resolveTaskExecutionTimeouts,
} from "./task-execution-timeouts.js";

describe("task execution timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves the default idle and absolute safety limits", () => {
    expect(resolveTaskExecutionTimeouts({})).toEqual({
      idleTimeoutMs: TASK_EXECUTION_IDLE_TIMEOUT_MS,
      absoluteTimeoutMs: TASK_EXECUTION_ABSOLUTE_TIMEOUT_MS,
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
      absoluteTimeoutMs: TASK_EXECUTION_ABSOLUTE_TIMEOUT_MS,
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
