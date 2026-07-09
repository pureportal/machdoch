import { act, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";
import type { TaskExecutionProgress } from "../../../../core/types.js";
import {
  subscribeToDesktopTaskProgress,
  type DesktopTaskProgressEvent,
} from "../../runtime";
import { createInitialThinkingTrace } from "../../task-thinking.model";
import { useDesktopTaskProgress } from "./use-desktop-task-progress";

vi.mock("../../runtime", () => ({
  subscribeToDesktopTaskProgress: vi.fn(),
}));

const mockedSubscribeToDesktopTaskProgress =
  subscribeToDesktopTaskProgress as MockedFunction<
    typeof subscribeToDesktopTaskProgress
  >;

const createProgress = (
  message: string,
  cancellable: boolean,
): TaskExecutionProgress => ({
  task: "Inspect the workspace",
  mode: "machdoch",
  state: cancellable ? "executing" : "completed",
  message,
  executedTools: [],
  outputSections: [],
  cancellable,
});

describe("useDesktopTaskProgress", () => {
  let progressListener: ((event: DesktopTaskProgressEvent) => void) | null = null;
  let restoreAnimationFrame: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    progressListener = null;
    mockedSubscribeToDesktopTaskProgress.mockImplementation(async (listener) => {
      progressListener = listener;
      return () => undefined;
    });

    const originalRequestAnimationFrame = window.requestAnimationFrame;
    const originalCancelAnimationFrame = window.cancelAnimationFrame;

    window.requestAnimationFrame = (callback): number =>
      window.setTimeout(() => callback(Date.now()), 16);
    window.cancelAnimationFrame = (id): void => window.clearTimeout(id);
    restoreAnimationFrame = () => {
      window.requestAnimationFrame = originalRequestAnimationFrame;
      window.cancelAnimationFrame = originalCancelAnimationFrame;
    };
  });

  afterEach(() => {
    restoreAnimationFrame?.();
    mockedSubscribeToDesktopTaskProgress.mockReset();
    vi.useRealTimers();
  });

  it("batches cancellable progress until the next animation frame", async () => {
    let trace = createInitialThinkingTrace("machdoch", 0);
    const updateThinkingTrace = vi.fn((_sessionId, _taskId, updater) => {
      trace = updater(trace);
    });

    renderHook(() =>
      useDesktopTaskProgress({
        activeDesktopTasksRef: {
          current: new Map([["task-1", "session-1"]]),
        },
        ignoredDesktopTaskIdsRef: { current: new Set() },
        updateThinkingTrace,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      progressListener?.({
        taskId: "task-1",
        progress: createProgress("Running first step.", true),
        timestamp: 10,
      });
      progressListener?.({
        taskId: "task-1",
        progress: createProgress("Running second step.", true),
        timestamp: 20,
      });
    });

    expect(updateThinkingTrace).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(16);
    });

    expect(updateThinkingTrace).toHaveBeenCalledTimes(1);
    expect(trace.entries.map((entry) => entry.detail)).toContain(
      "Running first step.",
    );
    expect(trace.entries.map((entry) => entry.detail)).toContain(
      "Running second step.",
    );
  });

  it("flushes queued progress before applying terminal progress", async () => {
    let trace = createInitialThinkingTrace("machdoch", 0);
    const updateThinkingTrace = vi.fn((_sessionId, _taskId, updater) => {
      trace = updater(trace);
    });

    renderHook(() =>
      useDesktopTaskProgress({
        activeDesktopTasksRef: {
          current: new Map([["task-1", "session-1"]]),
        },
        ignoredDesktopTaskIdsRef: { current: new Set() },
        updateThinkingTrace,
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      progressListener?.({
        taskId: "task-1",
        progress: createProgress("Running before terminal.", true),
        timestamp: 10,
      });
      progressListener?.({
        taskId: "task-1",
        progress: createProgress("Finished.", false),
        timestamp: 20,
      });
    });

    expect(updateThinkingTrace).toHaveBeenCalledTimes(2);
    expect(trace.status).toBe("complete");
    expect(trace.entries.map((entry) => entry.detail)).toContain(
      "Running before terminal.",
    );
    expect(trace.entries.map((entry) => entry.detail)).toContain("Finished.");
  });
});
