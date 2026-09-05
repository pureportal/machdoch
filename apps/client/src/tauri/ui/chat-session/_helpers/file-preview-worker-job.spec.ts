// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFilePreviewWorkerJob } from "./file-preview-worker-job";

const makeWorker = () => ({
  onmessage: null,
  onerror: null,
  onmessageerror: null,
  postMessage: vi.fn(),
  terminate: vi.fn(),
});
const deliver = (worker: ReturnType<typeof makeWorker>, data: unknown) =>
  (worker as unknown as Worker).onmessage?.(
    new MessageEvent("message", { data }),
  );

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("preview worker ownership", () => {
  it("waits for worker readiness, returns results, and releases timers and the worker", async () => {
    const worker = makeWorker();
    const job = runFilePreviewWorkerJob(
      () => worker as unknown as Worker,
      { query: "hello" },
      new AbortController().signal,
      500,
      "timeout",
    );
    expect(worker.postMessage).not.toHaveBeenCalled();
    deliver(worker, { ready: true });
    expect(worker.postMessage).toHaveBeenCalledWith({ query: "hello" });
    deliver(worker, { value: 123 });
    await expect(job).resolves.toBe(123);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates stalled computation independently of slow script loading", async () => {
    const worker = makeWorker();
    const job = runFilePreviewWorkerJob(
      () => worker as unknown as Worker,
      {},
      new AbortController().signal,
      500,
      "Search took too long",
    );
    const assertion = expect(job).rejects.toThrow("Search took too long");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    deliver(worker, { ready: true });
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels both starting and running workers without retaining listeners", async () => {
    for (const ready of [false, true]) {
      const worker = makeWorker();
      const controller = new AbortController();
      const job = runFilePreviewWorkerJob(
        () => worker as unknown as Worker,
        {},
        controller.signal,
        500,
        "timeout",
      );
      const assertion = expect(job).rejects.toMatchObject({
        name: "AbortError",
      });
      if (ready) deliver(worker, { ready: true });
      controller.abort();
      await assertion;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(worker.onmessage).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("handles failed startup and synchronous postMessage failures", async () => {
    const worker = makeWorker();
    worker.postMessage.mockImplementation(() => {
      throw new Error("clone failed");
    });
    const job = runFilePreviewWorkerJob(
      () => worker as unknown as Worker,
      {},
      new AbortController().signal,
      500,
      "timeout",
    );
    const assertion = expect(job).rejects.toThrow("clone failed");
    deliver(worker, { ready: true });
    await assertion;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    const stalled = makeWorker();
    const starting = runFilePreviewWorkerJob(
      () => stalled as unknown as Worker,
      {},
      new AbortController().signal,
      500,
      "timeout",
    );
    const startingAssertion =
      expect(starting).rejects.toThrow("could not start");
    await vi.advanceTimersByTimeAsync(5_000);
    await startingAssertion;
    expect(stalled.terminate).toHaveBeenCalledTimes(1);
  });
});
