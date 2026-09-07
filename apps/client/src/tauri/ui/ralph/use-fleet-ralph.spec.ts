// @vitest-environment jsdom

import { createElement, StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetShellRalphSnapshot } from "../runtime";
import { useFleetRalph } from "./use-fleet-ralph";

const { loadFleetRalphSnapshot } = vi.hoisted(() => ({
  loadFleetRalphSnapshot:
    vi.fn<(workspace: string) => Promise<FleetShellRalphSnapshot>>(),
}));

vi.mock("./fleet-ralph", () => ({ loadFleetRalphSnapshot }));

const snapshot = (
  workspaceRoot = "first",
  updatedAt = 1,
): FleetShellRalphSnapshot => ({
  workspaceRoot,
  loading: false,
  flows: [],
  runs: [],
  updatedAt,
});

const pendingSnapshot = () => {
  let resolve!: (value: FleetShellRalphSnapshot) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<FleetShellRalphSnapshot>(
    (onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    },
  );
  return { promise, resolve, reject };
};

const advance = async (milliseconds = 0): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  loadFleetRalphSnapshot
    .mockReset()
    .mockImplementation(async (workspace) => snapshot(workspace));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Fleet Ralph refreshes", () => {
  it("waits five seconds after a slow query completes before polling again", async () => {
    const pending = pendingSnapshot();
    loadFleetRalphSnapshot.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useFleetRalph("first", true));

    await advance(25_000);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledExactlyOnceWith("first");
    await act(async () => pending.resolve(snapshot()));
    expect(result.current.ralphState).toEqual({
      snapshot: snapshot(),
      loading: false,
      error: null,
    });

    await advance(4_999);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(2);
  });

  it("coalesces command refreshes into one follow-up after the pending query", async () => {
    const first = pendingSnapshot();
    const second = pendingSnapshot();
    loadFleetRalphSnapshot
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => useFleetRalph("first", true));

    const requests = Array.from({ length: 5 }, () =>
      result.current.refreshRalph(),
    );
    expect(new Set(requests).size).toBe(1);
    await advance(10_000);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => first.resolve(snapshot()));
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.ralphState.snapshot).toBeNull();

    await act(async () => {
      second.resolve(snapshot("first", 2));
      await Promise.all(requests);
    });
    expect(result.current.ralphState.snapshot?.updatedAt).toBe(2);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(2);
  });

  it("serializes workspace switches and ignores stale failures", async () => {
    const first = pendingSnapshot();
    const latest = pendingSnapshot();
    loadFleetRalphSnapshot
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(latest.promise);
    const { result, rerender } = renderHook(
      ({ workspace }) => useFleetRalph(workspace, true),
      {
        initialProps: { workspace: "first" },
      },
    );
    rerender({ workspace: "second" });
    rerender({ workspace: "third" });
    await advance(15_000);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => first.reject(new Error("Old workspace failed")));
    expect(loadFleetRalphSnapshot.mock.calls).toEqual([["first"], ["third"]]);
    expect(result.current.ralphState.error).toBeNull();
    await advance(10_000);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(2);
    await act(async () => latest.resolve(snapshot("third")));
    expect(result.current.ralphState.snapshot?.workspaceRoot).toBe("third");
  });

  it("keeps pending work serialized through disable and re-enable", async () => {
    const pending = pendingSnapshot();
    loadFleetRalphSnapshot.mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useFleetRalph("first", enabled),
      {
        initialProps: { enabled: true },
      },
    );
    rerender({ enabled: false });
    rerender({ enabled: true });
    await advance(10_000);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => pending.resolve(snapshot("first", 99)));
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(2);
    expect(result.current.ralphState.snapshot?.updatedAt).toBe(1);
  });

  it("does not release the pending guard during Strict Mode effect replay", async () => {
    const pending = pendingSnapshot();
    loadFleetRalphSnapshot.mockReturnValueOnce(pending.promise);
    const { result } = renderHook(() => useFleetRalph("first", true), {
      wrapper: ({ children }) => createElement(StrictMode, null, children),
    });
    await advance(20_000);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(snapshot()));
    expect(result.current.ralphState.loading).toBe(false);
    expect(result.current.ralphState.snapshot?.workspaceRoot).toBe("first");
  });

  it("stops queued refreshes and timers on unmount", async () => {
    const pending = pendingSnapshot();
    loadFleetRalphSnapshot.mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() => useFleetRalph("first", true));
    void result.current.refreshRalph();
    unmount();
    await act(async () => pending.resolve(snapshot()));
    await advance(30_000);
    await result.current.refreshRalph();
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains the last snapshot on failure and recovers on the next poll", async () => {
    const { result } = renderHook(() => useFleetRalph("first", true));
    await advance();
    loadFleetRalphSnapshot.mockRejectedValueOnce(
      new Error("Status query timed out"),
    );
    await advance(5_000);
    expect(result.current.ralphState).toMatchObject({
      snapshot: { workspaceRoot: "first", flows: [], runs: [] },
      loading: false,
      error: "Status query timed out",
    });

    await advance(5_000);
    expect(result.current.ralphState.error).toBeNull();
    expect(result.current.ralphState.snapshot?.error).toBeUndefined();
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(3);
  });

  it("skips polling while hidden and resumes when visible", async () => {
    renderHook(() => useFleetRalph("first", true));
    await advance();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await advance(30_000);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(1);

    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await advance(5_000);
    expect(loadFleetRalphSnapshot).toHaveBeenCalledTimes(2);
  });

  it("does no background work when disabled or without a workspace", async () => {
    const initialProps: { workspace: string | null; enabled: boolean } = {
      workspace: "first",
      enabled: false,
    };
    const { result, rerender } = renderHook(
      ({
        workspace,
        enabled,
      }: {
        workspace: string | null;
        enabled: boolean;
      }) => useFleetRalph(workspace, enabled),
      { initialProps },
    );
    await advance(10_000);
    await result.current.refreshRalph();
    rerender({ workspace: null, enabled: true });
    await advance(10_000);
    expect(loadFleetRalphSnapshot).not.toHaveBeenCalled();
    expect(result.current.ralphState.snapshot).toMatchObject({
      flows: [],
      runs: [],
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
