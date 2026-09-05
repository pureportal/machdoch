// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startActivityPolling } from "./activity-polling";

let visibility: DocumentVisibilityState;
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("activity polling", () => {
  it("coalesces refreshes and waits for active requests before scheduling another", async () => {
    let finish = (_active: boolean) => {};
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    const poll = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(false);
    const polling = startActivityPolling(poll, (active) =>
      active ? 2_000 : 30_000,
    );
    polling.refresh();
    polling.refresh();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
    finish(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(poll).toHaveBeenCalledTimes(2);
    polling.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("suspends hidden windows, resumes immediately, and aborts stale work on stop", async () => {
    visibility = "hidden";
    let signal: AbortSignal | undefined;
    const poll = vi.fn(async (incoming: AbortSignal) => {
      signal = incoming;
      return false;
    });
    const polling = startActivityPolling(poll, () => 2_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(vi.getTimerCount()).toBe(0);
    polling.stop();
    expect(signal?.aborted).toBe(true);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(poll).toHaveBeenCalledTimes(1);
  });
  it("backs off transient failures without unhandled rejections and recovers normally", async () => {
    const poll = vi.fn().mockRejectedValue(new Error("runtime restarting"));
    const polling = startActivityPolling(poll, () => 2_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(poll).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
    poll.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(poll).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(poll).toHaveBeenCalledTimes(5);
    polling.stop();
  });
});
