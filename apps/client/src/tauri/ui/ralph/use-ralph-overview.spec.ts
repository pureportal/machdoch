// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RalphSnapshot } from "../../../core/ralph-snapshot.js";
import type { DesktopTaskProgressEvent } from "../runtime";
import { useRalphOverview } from "./use-ralph-overview";
import { createOverviewTask } from "./__test__/ralph-overview-fixtures";

const runtime = vi.hoisted(() => ({
  loadRalphSnapshot: vi.fn(),
  loadActiveDesktopTasks: vi.fn(),
  subscribeToDesktopTaskProgress: vi.fn(),
}));
vi.mock("../runtime", () => runtime);

const snapshot = (
  workspaceRoot = "/one",
  scope: "workspace" | "user" = "workspace",
): RalphSnapshot => ({
  workspaceRoot,
  scopes: [{ scope, flows: [], runs: [] }],
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const advance = async (milliseconds = 0) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  runtime.loadRalphSnapshot
    .mockReset()
    .mockImplementation(async (root, scope) => snapshot(root, scope));
  runtime.loadActiveDesktopTasks.mockReset().mockResolvedValue([]);
  runtime.subscribeToDesktopTaskProgress.mockReset().mockResolvedValue(vi.fn());
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RALPH overview loading", () => {
  it("publishes fast workspaces while a slow workspace is still loading and reads global storage once", async () => {
    const slow = deferred<RalphSnapshot>();
    runtime.loadRalphSnapshot.mockImplementation((root, scope) =>
      root === "/one" && scope === "workspace"
        ? slow.promise
        : Promise.resolve(snapshot(root, scope)),
    );
    const { result } = renderHook(() =>
      useRalphOverview(["/one", "/two", "/three"], true),
    );
    await advance();
    expect(
      result.current.libraries.find((entry) => entry.key === "workspace:/two")
        ?.loaded,
    ).toBe(true);
    expect(
      result.current.libraries.find((entry) => entry.key === "workspace:/one")
        ?.loading,
    ).toBe(true);
    expect(
      runtime.loadRalphSnapshot.mock.calls.filter(
        ([, scope]) => scope === "user",
      ),
    ).toHaveLength(1);
    await act(async () => slow.resolve(snapshot()));
    expect(result.current.libraries.every((entry) => entry.loaded)).toBe(true);
  });

  it("shows tasks and discovers their workspace before any slow snapshot returns", async () => {
    const slow = deferred<RalphSnapshot>();
    runtime.loadRalphSnapshot.mockReturnValue(slow.promise);
    runtime.loadActiveDesktopTasks.mockResolvedValue([
      createOverviewTask("/unlisted"),
    ]);
    const { result } = renderHook(() => useRalphOverview(["/one"], true));
    await advance();
    expect(result.current.tasks[0]?.workspaceRoot).toBe("/unlisted");
    expect(
      result.current.libraries.some(
        (entry) => entry.workspaceRoot === "/unlisted",
      ),
    ).toBe(true);
    expect(runtime.loadRalphSnapshot).toHaveBeenCalledTimes(3);
  });

  it("polls activity independently without reloading history until needed", async () => {
    const { result } = renderHook(() =>
      useRalphOverview(["/one", "/two"], true),
    );
    await advance(6_000);
    expect(runtime.loadActiveDesktopTasks).toHaveBeenCalledTimes(4);
    expect(runtime.loadRalphSnapshot).toHaveBeenCalledTimes(3);
    runtime.loadActiveDesktopTasks.mockResolvedValue([
      createOverviewTask("/two"),
    ]);
    await advance(2_000);
    expect(result.current.tasks).toHaveLength(1);
    expect(runtime.loadRalphSnapshot.mock.calls.slice(3)).toEqual([
      ["/two", "workspace"],
    ]);
    runtime.loadActiveDesktopTasks.mockResolvedValue([]);
    await advance(2_000);
    expect(result.current.tasks).toEqual([]);
    expect(runtime.loadRalphSnapshot.mock.calls.slice(4)).toEqual([
      ["/two", "workspace"],
    ]);
  });

  it("retains activity and marks failures rather than showing an idle workspace", async () => {
    runtime.loadActiveDesktopTasks.mockResolvedValue([
      createOverviewTask("/one"),
    ]);
    const { result } = renderHook(() => useRalphOverview(["/one"], true));
    await advance();
    runtime.loadActiveDesktopTasks.mockResolvedValue(null);
    runtime.loadRalphSnapshot.mockRejectedValue(
      new Error("Workspace disconnected"),
    );
    await act(async () => result.current.refresh());
    await advance();
    expect(result.current.tasks).toHaveLength(1);
    expect(result.current.taskError).toContain(
      "Activity could not be refreshed",
    );
    expect(
      result.current.libraries.every(
        (entry) => entry.error === "Workspace disconnected",
      ),
    ).toBe(true);
    runtime.loadActiveDesktopTasks.mockResolvedValue([]);
    runtime.loadRalphSnapshot.mockImplementation(async (root, scope) =>
      snapshot(root, scope),
    );
    await act(async () => result.current.refresh());
    await advance();
    expect(result.current.taskError).toBeNull();
    expect(
      result.current.libraries.every((entry) => entry.error === null),
    ).toBe(true);
  });

  it("bounds concurrency, ignores stale results, and serializes requests through Strict Mode and reactivation", async () => {
    const requests: Array<{
      root: string;
      scope: "workspace" | "user";
      pending: ReturnType<typeof deferred<RalphSnapshot>>;
    }> = [];
    runtime.loadRalphSnapshot.mockImplementation((root, scope) => {
      const pending = deferred<RalphSnapshot>();
      requests.push({ root, scope, pending });
      return pending.promise;
    });
    const { result, rerender, unmount } = renderHook(
      ({ enabled, roots }) => useRalphOverview(roots, enabled),
      {
        initialProps: {
          enabled: true,
          roots: ["/one", "/two", "/three", "/four"],
        },
        wrapper: ({ children }) => createElement(StrictMode, null, children),
      },
    );
    await advance(30_000);
    expect(requests).toHaveLength(3);
    rerender({ enabled: false, roots: ["/one"] });
    rerender({ enabled: true, roots: ["/one"] });
    await act(async () => {
      for (const request of requests.slice())
        request.pending.resolve(snapshot(request.root, request.scope));
    });
    expect(result.current.libraries.every((entry) => !entry.loaded)).toBe(true);
    await act(async () => {
      for (const request of requests.slice(3))
        request.pending.resolve(snapshot(request.root, request.scope));
    });
    expect(result.current.libraries.every((entry) => entry.loaded)).toBe(true);
    unmount();
    await advance(30_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates the global query workspace and ignores late failures from a removed workspace", async () => {
    const old = deferred<RalphSnapshot>();
    runtime.loadRalphSnapshot.mockImplementation((root, scope) =>
      root === "/one" ? old.promise : Promise.resolve(snapshot(root, scope)),
    );
    const { result, rerender } = renderHook(
      ({ roots }) => useRalphOverview(roots, true),
      { initialProps: { roots: ["/one"] } },
    );
    rerender({ roots: ["/two"] });
    await advance();
    expect(
      result.current.libraries.find((entry) => entry.key === "workspace:/two")
        ?.loaded,
    ).toBe(true);
    await act(async () => old.reject(new Error("Old workspace failed")));
    expect(runtime.loadRalphSnapshot).toHaveBeenCalledWith("/two", "user");
    expect(
      result.current.libraries.every(
        (entry) =>
          entry.workspaceRoot === "/two" && entry.loaded && !entry.error,
      ),
    ).toBe(true);
  });

  it("coalesces refresh clicks during an in-flight query and discards the stale response", async () => {
    const old = deferred<RalphSnapshot>();
    const latest = deferred<RalphSnapshot>();
    let workspaceCalls = 0;
    runtime.loadRalphSnapshot.mockImplementation((root, scope) =>
      scope === "workspace"
        ? ++workspaceCalls === 1
          ? old.promise
          : latest.promise
        : Promise.resolve(snapshot(root, scope)),
    );
    const { result } = renderHook(() => useRalphOverview(["/one"], true));
    await advance();
    await act(async () => {
      for (let index = 0; index < 5; index++) result.current.refresh();
    });
    expect(workspaceCalls).toBe(1);
    await act(async () => old.resolve(snapshot()));
    expect(
      result.current.libraries.find((entry) => entry.scope === "workspace")
        ?.loaded,
    ).toBe(false);
    expect(workspaceCalls).toBe(2);
    await act(async () => latest.resolve(snapshot()));
    expect(
      result.current.libraries.find((entry) => entry.scope === "workspace")
        ?.loaded,
    ).toBe(true);
  });

  it("coalesces lifecycle events into a fresh query and suspends hidden-window polling", async () => {
    runtime.loadActiveDesktopTasks.mockResolvedValue([
      createOverviewTask("/one", "task"),
    ]);
    renderHook(() => useRalphOverview(["/one"], true));
    await advance();
    const notify = runtime.subscribeToDesktopTaskProgress.mock
      .calls[0]?.[0] as (event: DesktopTaskProgressEvent) => void;
    runtime.loadRalphSnapshot.mockClear();
    for (let index = 0; index < 10; index++)
      notify({
        taskId: "task",
        timestamp: 1,
        progress: {
          task: "RALPH",
          mode: "machdoch",
          state: "completed",
          message: "Done",
          executedTools: [],
          outputSections: [],
          cancellable: false,
          timelineEvent: {
            kind: "state",
            phase: "completed",
            label: "Done",
            metadata: { ralphEventType: "end" },
          },
        },
      });
    await advance(200);
    expect(runtime.loadRalphSnapshot).toHaveBeenCalledExactlyOnceWith(
      "/one",
      "workspace",
    );
    const count = runtime.loadActiveDesktopTasks.mock.calls.length;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await advance(60_000);
    expect(runtime.loadActiveDesktopTasks).toHaveBeenCalledTimes(count);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    await advance();
    expect(runtime.loadActiveDesktopTasks.mock.calls.length).toBeGreaterThan(
      count,
    );
  });
});
