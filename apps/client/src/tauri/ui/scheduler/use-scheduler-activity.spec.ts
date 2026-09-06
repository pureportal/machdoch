// @vitest-environment jsdom

import { createElement, StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSchedulerActivity } from "./use-scheduler-activity";
import type { WorkspaceSchedulerActivity } from "./scheduler-activity-runtime";

const { loadSchedulerActivity } = vi.hoisted(() => ({
  loadSchedulerActivity:
    vi.fn<
      (roots: readonly string[]) => Promise<WorkspaceSchedulerActivity[]>
    >(),
}));

vi.mock("./scheduler-activity-runtime", () => ({ loadSchedulerActivity }));

const running: WorkspaceSchedulerActivity[] = [
  { workspaceRoot: "first", runs: [{ id: "run-1", status: "running" }] },
];

beforeEach(() => {
  vi.useFakeTimers();
  loadSchedulerActivity.mockReset().mockResolvedValue(running);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("scheduler activity polling", () => {
  it("polls idle workspaces once per minute without restarting on navigation", async () => {
    loadSchedulerActivity.mockResolvedValue([
      { workspaceRoot: "first", runs: [] },
    ]);
    const { rerender } = renderHook(
      ({ viewed }) => useSchedulerActivity(["first"], viewed),
      { initialProps: { viewed: false } },
    );
    await settle();
    rerender({ viewed: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(loadSchedulerActivity).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(loadSchedulerActivity).toHaveBeenCalledTimes(2);
  });

  it("reports runs that start and finish between idle polls", async () => {
    loadSchedulerActivity.mockResolvedValue([
      { workspaceRoot: "first", runs: [] },
    ]);
    const { result } = renderHook(() => useSchedulerActivity(["first"], false));
    await settle();
    expect(result.current).toBe("idle");
    loadSchedulerActivity.mockResolvedValue([
      {
        workspaceRoot: "first",
        runs: [{ id: "quick-run", status: "succeeded" }],
      },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBe("completed");
  });

  it("batches workspaces and does not start more reads while one is pending", async () => {
    let finish!: (result: WorkspaceSchedulerActivity[]) => void;
    loadSchedulerActivity.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderHook(() => useSchedulerActivity(["second", "first", "first"], false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(loadSchedulerActivity).toHaveBeenCalledExactlyOnceWith([
      "first",
      "second",
    ]);
    await act(async () => {
      finish(running);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(loadSchedulerActivity).toHaveBeenCalledTimes(2);
  });

  it("does not restart polling when opening the scheduler during a read", async () => {
    let finish!: (result: WorkspaceSchedulerActivity[]) => void;
    const { result, rerender } = renderHook(
      ({ viewed }) => useSchedulerActivity(["first"], viewed),
      { initialProps: { viewed: false } },
    );
    await settle();
    expect(result.current).toBe("running");
    loadSchedulerActivity.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    rerender({ viewed: true });
    expect(loadSchedulerActivity).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish([{ workspaceRoot: "first", runs: [] }]);
    });
    expect(result.current).toBe("idle");
  });

  it("keeps the guard across workspace changes and ignores stale results", async () => {
    let finish!: (result: WorkspaceSchedulerActivity[]) => void;
    loadSchedulerActivity.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result, rerender } = renderHook(
      ({ roots }) => useSchedulerActivity(roots, false),
      { initialProps: { roots: ["first"] } },
    );
    rerender({ roots: ["second"] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(loadSchedulerActivity).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(running);
    });
    expect(result.current).toBe("idle");
    loadSchedulerActivity.mockResolvedValue([
      { workspaceRoot: "second", runs: [] },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(loadSchedulerActivity).toHaveBeenLastCalledWith(["second"]);
    expect(result.current).toBe("idle");
  });

  it("preserves activity through errors and records a later completion", async () => {
    const { result, rerender } = renderHook(
      ({ viewed }) => useSchedulerActivity(["first"], viewed),
      { initialProps: { viewed: false } },
    );
    await settle();
    loadSchedulerActivity.mockRejectedValueOnce(new Error("Read timed out"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toBe("running");
    loadSchedulerActivity.mockResolvedValue([
      { workspaceRoot: "first", runs: [] },
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current).toBe("completed");
    rerender({ viewed: true });
    expect(result.current).toBe("idle");
  });

  it("does not treat removing a workspace as a completed run", async () => {
    const { result, rerender } = renderHook(
      ({ roots }) => useSchedulerActivity(roots, false),
      { initialProps: { roots: ["first"] } },
    );
    await settle();
    loadSchedulerActivity.mockResolvedValue([
      { workspaceRoot: "second", runs: [] },
    ]);
    rerender({ roots: ["second"] });
    await settle();
    expect(result.current).toBe("idle");
  });

  it("does not poll without workspaces or after unmounting", async () => {
    const empty = renderHook(() => useSchedulerActivity([], false));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(loadSchedulerActivity).not.toHaveBeenCalled();
    empty.unmount();
    const populated = renderHook(() => useSchedulerActivity(["first"], false));
    await settle();
    populated.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(loadSchedulerActivity).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate the initial read under StrictMode", async () => {
    renderHook(() => useSchedulerActivity(["first"], false), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    });
    await settle();
    expect(loadSchedulerActivity).toHaveBeenCalledTimes(1);
  });
});
