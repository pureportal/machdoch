// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useFilePreviewHighlight,
  useFilePreviewSearch,
} from "./use-file-preview-processing";

const workers: WorkerDouble[] = [];
class WorkerDouble {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  deliver(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  workers.length = 0;
  vi.stubGlobal("Worker", WorkerDouble);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("preview computation hooks", () => {
  it("debounces typing and terminates obsolete searches before starting a replacement", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ query }) => useFilePreviewSearch("first second", query, true),
      { initialProps: { query: "f" } },
    );
    rerender({ query: "fi" });
    rerender({ query: "first" });
    await advance(120);
    expect(workers).toHaveLength(1);
    workers[0]!.deliver({ ready: true });
    const staleHandler = workers[0]!.onmessage!;
    expect(workers[0]!.postMessage).toHaveBeenCalledWith({
      content: "first second",
      query: "first",
      isRegex: true,
    });
    rerender({ query: "second" });
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    await act(async () => {
      staleHandler(
        new MessageEvent("message", {
          data: { value: { matches: [{ start: 0, end: 5 }], error: null } },
        }),
      );
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.result.matches).toEqual([]);
    await advance(120);
    workers[1]!.deliver({ ready: true });
    await act(async () => {
      workers[1]!.deliver({
        value: { matches: [{ start: 6, end: 12 }], error: null },
      });
    });
    expect(result.current.result.matches).toEqual([{ start: 6, end: 12 }]);
    expect(result.current.pending).toBe(false);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(workers[1]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("clears stale matches immediately when file contents change", async () => {
    vi.stubGlobal("Worker", undefined);
    const { result, rerender } = renderHook(
      ({ content }) => useFilePreviewSearch(content, "old", false),
      { initialProps: { content: "old" } },
    );
    await advance(120);
    expect(result.current.result.matches).toHaveLength(1);
    rerender({ content: "different file" });
    expect(result.current.result.matches).toEqual([]);
    await advance(120);
    expect(result.current.result.matches).toEqual([]);
  });

  it("supports literal fallback but never executes arbitrary regex without a worker", async () => {
    vi.stubGlobal("Worker", undefined);
    const { result } = renderHook(() =>
      useFilePreviewSearch("a".repeat(60_000) + "!", "(a+)+$", true),
    );
    await advance(120);
    expect(result.current.result.error).toContain("unavailable");
    expect(result.current.pending).toBe(false);
  });

  it("falls back to plain text when highlighting exceeds its deadline or size budget", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ content }) => useFilePreviewHighlight(content, "typescript"),
      { initialProps: { content: "const value = 1;" } },
    );
    workers[0]!.deliver({ ready: true });
    await advance(1_500);
    expect(result.current).toBeNull();
    expect(workers[0]!.terminate).toHaveBeenCalledTimes(1);
    rerender({ content: "x".repeat(200_001) });
    expect(workers).toHaveLength(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
