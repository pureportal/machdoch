// @vitest-environment jsdom
/// <reference types="vitest/globals" />
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSchedulerActivity } from "./use-scheduler-activity";

const { listSchedulerRuns } = vi.hoisted(() => ({
  listSchedulerRuns: vi.fn(),
}));
vi.mock("../runtime", () => ({ listSchedulerRuns }));

beforeEach(() => {
  vi.useFakeTimers();
  listSchedulerRuns.mockReset().mockResolvedValue({ runs: [] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const flush = async () => {
  await act(async () => {});
};

it("polls idle workspaces once per minute and does not restart on navigation", async () => {
  const { rerender } = renderHook(
    ({ viewed }) => useSchedulerActivity(["a", "a", "b"], viewed),
    {
      initialProps: { viewed: false },
    },
  );
  await flush();
  expect(listSchedulerRuns).toHaveBeenCalledTimes(2);
  rerender({ viewed: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(59_999);
  });
  expect(listSchedulerRuns).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(listSchedulerRuns).toHaveBeenCalledTimes(4);
});

it("limits simultaneous CLI launches and stops pending batches on unmount", async () => {
  let release: (value: { runs: [] }) => void = () => {};
  const pending = new Promise<{ runs: [] }>((resolve) => {
    release = resolve;
  });
  listSchedulerRuns.mockReturnValue(pending);
  const { unmount } = renderHook(() =>
    useSchedulerActivity(["a", "b", "c", "d", "e"], false),
  );
  expect(listSchedulerRuns).toHaveBeenCalledTimes(2);
  unmount();
  release({ runs: [] });
  await flush();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(listSchedulerRuns).toHaveBeenCalledTimes(2);
});

it("keeps fast polling while a run is active, including after a failed read", async () => {
  listSchedulerRuns
    .mockResolvedValueOnce({ runs: [{ id: "run", status: "running" }] })
    .mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() => useSchedulerActivity(["a"], false));
  await flush();
  const running = result.current;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(result.current).toEqual(running);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(listSchedulerRuns).toHaveBeenCalledTimes(3);
});

it("reports runs that start and finish between idle polls", async () => {
  const { result } = renderHook(() => useSchedulerActivity(["a"], false));
  await flush();
  expect(result.current).toBe("idle");
  listSchedulerRuns.mockResolvedValue({
    runs: [{ id: "quick-run", status: "succeeded" }],
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(result.current).toBe("completed");
});
