import { describe, expect, it, vi } from "vitest";
import { MediaImportQueue } from "./media-import-queue";

describe("background model imports", () => {
  it("queues independent imports, keeps the UI free, and retries a failure", async () => {
    const queue = new MediaImportQueue();
    let complete!: (id: string) => void;
    const first = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const second = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Disk full"))
      .mockResolvedValueOnce("addon-id");
    queue.enqueue("Model", () => first);
    queue.enqueue("LoRA", second);
    expect(queue.getSnapshot().map((job) => job.status)).toEqual([
      "importing",
      "queued",
    ]);
    expect(second).not.toHaveBeenCalled();
    expect(queue.hasPendingWork()).toBe(true);
    complete("model-id");
    await vi.waitFor(() =>
      expect(queue.getSnapshot()[1]?.status).toBe("failed"),
    );
    expect(queue.getSnapshot()[0]?.resourceId).toBe("model-id");
    expect(queue.getSnapshot()[1]?.error).toBe("Disk full");
    expect(queue.hasPendingWork()).toBe(true);
    queue.retry(queue.getSnapshot()[1]!.id);
    await vi.waitFor(() =>
      expect(queue.getSnapshot()[1]?.resourceId).toBe("addon-id"),
    );
    expect(second).toHaveBeenCalledTimes(2);
    expect(queue.hasPendingWork()).toBe(false);
  });

  it("cancels waiting work without interrupting the current native copy", async () => {
    const queue = new MediaImportQueue();
    let complete!: (id: string) => void;
    queue.enqueue(
      "First",
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const execute = vi.fn().mockResolvedValue("second");
    queue.enqueue("Second", execute);
    queue.dismiss(queue.getSnapshot()[0]!.id);
    expect(queue.getSnapshot()).toHaveLength(2);
    queue.dismiss(queue.getSnapshot()[1]!.id);
    complete("first");
    await vi.waitFor(() => expect(queue.hasPendingWork()).toBe(false));
    expect(execute).not.toHaveBeenCalled();
    queue.dismiss(queue.getSnapshot()[0]!.id);
    expect(queue.getSnapshot()).toEqual([]);
  });
});
