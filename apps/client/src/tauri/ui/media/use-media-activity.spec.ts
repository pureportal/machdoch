// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMediaActivity } from "./use-media-activity";
import type { MainAppId } from "../lib/shell-store";
const { listRuns } = vi.hoisted(() => ({ listRuns: vi.fn() }));
vi.mock("./media-runtime", () => ({ listMediaRuns: listRuns }));
beforeEach(() => {
  vi.useFakeTimers();
  listRuns.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("backs off idle media reads and refreshes immediately when opening Media Studio", async () => {
  const { rerender, unmount } = renderHook(({ app }) => useMediaActivity(app), {
    initialProps: { app: "chat" as MainAppId },
  });
  await act(async () => {});
  rerender({ app: "ralph" as MainAppId });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(29_999);
  });
  expect(listRuns).toHaveBeenCalledTimes(1);
  rerender({ app: "media" });
  await act(async () => {});
  expect(listRuns).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(listRuns).toHaveBeenCalledTimes(3);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the currently viewed section when an active read finishes", async () => {
  listRuns.mockResolvedValueOnce([{ id: "run", status: "running" }]);
  let finish = (_runs: unknown[]) => {};
  listRuns.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, rerender } = renderHook(({ app }) => useMediaActivity(app), {
    initialProps: { app: "chat" as MainAppId },
  });
  await act(async () => {});
  expect(result.current).toBe("running");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  rerender({ app: "media" });
  expect(listRuns).toHaveBeenCalledTimes(2);
  await act(async () => {
    finish([]);
  });
  expect(result.current).toBe("idle");
});
