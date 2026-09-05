// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRalphActivity } from "./use-ralph-activity";
import type { MainAppId } from "../lib/shell-store";
const { loadTasks } = vi.hoisted(() => ({ loadTasks: vi.fn() }));
vi.mock("../runtime", () => ({ loadActiveDesktopTasks: loadTasks }));
beforeEach(() => {
  vi.useFakeTimers();
  loadTasks.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("polls idle RALPH activity less often and keeps an active read across navigation", async () => {
  let finish = (_tasks: unknown[]) => {};
  loadTasks.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, rerender } = renderHook(({ app }) => useRalphActivity(app), {
    initialProps: { app: "chat" as MainAppId },
  });
  rerender({ app: "media" as MainAppId });
  expect(loadTasks).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish([]);
  });
  expect(result.current).toBe("idle");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29_999);
  });
  expect(loadTasks).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(loadTasks).toHaveBeenCalledTimes(2);
});

it("preserves activity through transient read failures and reports completion after recovery", async () => {
  loadTasks
    .mockResolvedValueOnce([{ id: "run", kind: "ralph" }])
    .mockRejectedValueOnce(new Error("restarting"))
    .mockResolvedValue([]);
  const { result } = renderHook(() => useRalphActivity("chat" as MainAppId));
  await act(async () => {});
  expect(result.current).toBe("running");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(result.current).toBe("running");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(result.current).toBe("completed");
});
