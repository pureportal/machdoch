import { describe, expect, it, vi } from "vitest";
import type { MediaRunDetail } from "../../../core/media/contracts.js";
import {
  MediaGenerationQueue,
  type MediaGenerationRecipeSnapshot,
} from "./media-generation-queue";
import { MediaRuntimeError } from "./media-runtime";

const recipe = (
  target: MediaGenerationRecipeSnapshot["target"],
  prompt: string,
): MediaGenerationRecipeSnapshot => ({
  schemaVersion: 1,
  mode: "basic",
  target,
  flowId: `flow-${target}`,
  flowName: `Create ${target}`,
  flowRevisionId: `revision-${target}`,
  flowRevisionNumber: 1,
  planId: `plan-${target}`,
  prompt,
  modelId: `model-${target}`,
  modelLabel: `Model ${target}`,
  modelAddons: [],
  outputBranches: [],
  imageSettings: null,
  videoSettings: null,
  resultDestination: "assets",
});

const detail = (
  runId: string,
  status: MediaRunDetail["status"] = "completed",
): MediaRunDetail => ({
  id: runId,
  flowId: `flow-${runId}`,
  flowRevisionId: `revision-${runId}`,
  flowName: runId,
  planId: `plan-${runId}`,
  status,
  createdAt: "2026-08-20T10:00:00.000Z",
  updatedAt: "2026-08-20T10:00:10.000Z",
  prompt: runId,
  modelLabel: "Model",
  target: "local",
  outputCount: 1,
  diagnosticCount: 0,
  progress: status === "completed" ? 1 : 0.5,
  currentStep: status === "completed" ? "Completed" : "Running",
  executor: "local-import",
  error: null,
  failure: null,
  events: [],
  assets: [],
  providerJobs: [],
  humanReviews: [],
  nodeExecutions: [],
  planSnapshot: null,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("MediaGenerationQueue", () => {
  it("runs mixed immutable jobs serially", async () => {
    const first = deferred<MediaRunDetail>();
    const second = deferred<MediaRunDetail>();
    const order: string[] = [];
    const queue = new MediaGenerationQueue();
    const imageRecipe = recipe("image", "Original image prompt");
    queue.enqueue({
      runId: "image-run",
      recipe: imageRecipe,
      execute: () => {
        order.push("image");
        return first.promise;
      },
    });
    queue.enqueue({
      runId: "video-run",
      recipe: recipe("video", "Original video prompt"),
      execute: () => {
        order.push("video");
        return second.promise;
      },
    });
    imageRecipe.prompt = "Changed after submission";

    await vi.waitFor(() => expect(order).toEqual(["image"]));
    expect(queue.getSnapshot()[0]?.recipe.prompt).toBe("Original image prompt");
    expect(queue.getSnapshot()[1]?.status).toBe("queued");

    first.resolve(detail("image-run"));
    await vi.waitFor(() => expect(order).toEqual(["image", "video"]));
    second.resolve(detail("video-run"));
    await vi.waitFor(() =>
      expect(queue.getSnapshot().map((job) => job.status)).toEqual([
        "completed",
        "completed",
      ]),
    );
  });

  it("holds the serial slot when submission returns a queued run", async () => {
    const firstCompleted = deferred<MediaRunDetail>();
    const order: string[] = [];
    const queue = new MediaGenerationQueue({
      pollIntervalMs: 1,
      readRunDetail: async (runId) => {
        if (runId === "image-run") return firstCompleted.promise;
        return detail(runId);
      },
    });
    queue.enqueue({
      runId: "image-run",
      recipe: recipe("image", "Image"),
      execute: async () => {
        order.push("image");
        return detail("image-run", "queued");
      },
    });
    queue.enqueue({
      runId: "video-run",
      recipe: recipe("video", "Video"),
      execute: async () => {
        order.push("video");
        return detail("video-run");
      },
    });

    await vi.waitFor(() => expect(order).toEqual(["image"]));
    expect(queue.getSnapshot()[1]?.status).toBe("queued");
    firstCompleted.resolve(detail("image-run"));
    await vi.waitFor(() => expect(order).toEqual(["image", "video"]));
  });

  it("fails unavailable queued work and continues the queue", async () => {
    const order: string[] = [];
    const queue = new MediaGenerationQueue({
      pollIntervalMs: 1,
      readRunDetail: async () => {
        throw new Error("Run record unavailable");
      },
    });
    queue.enqueue({
      runId: "missing-run",
      recipe: recipe("image", "Missing"),
      execute: async () => {
        order.push("missing");
        return detail("missing-run", "queued");
      },
    });
    queue.enqueue({
      runId: "next-run",
      recipe: recipe("svg", "Continue"),
      execute: async () => {
        order.push("next");
        return detail("next-run");
      },
    });

    await vi.waitFor(() => expect(order).toEqual(["missing", "next"]));
    expect(queue.getSnapshot()[0]).toMatchObject({
      status: "failed",
      error: "Generation status became unavailable.",
    });
  });

  it("cancels queued work without starting or retaining its executor", async () => {
    const first = deferred<MediaRunDetail>();
    const executeSecond = vi.fn(() => Promise.resolve(detail("svg-run")));
    const queue = new MediaGenerationQueue();
    queue.enqueue({
      runId: "image-run",
      recipe: recipe("image", "Image"),
      execute: () => first.promise,
    });
    queue.enqueue({
      runId: "svg-run",
      recipe: recipe("svg", "SVG"),
      execute: executeSecond,
    });

    await queue.cancel("svg-run");
    first.resolve(detail("image-run"));
    await vi.waitFor(() =>
      expect(queue.getSnapshot()[0]?.status).toBe("completed"),
    );

    expect(executeSecond).not.toHaveBeenCalled();
    expect(queue.getSnapshot()[1]).toMatchObject({
      status: "canceled",
      currentStep: "Canceled",
    });
  });

  it("continues after a failed executor", async () => {
    const order: string[] = [];
    const queue = new MediaGenerationQueue();
    queue.enqueue({
      runId: "failed-run",
      recipe: recipe("image", "Fail"),
      execute: async () => {
        order.push("failed");
        throw new Error("Worker crashed");
      },
    });
    queue.enqueue({
      runId: "next-run",
      recipe: recipe("svg", "Continue"),
      execute: async () => {
        order.push("next");
        return detail("next-run");
      },
    });

    await vi.waitFor(() => expect(order).toEqual(["failed", "next"]));
    expect(queue.getSnapshot()[0]).toMatchObject({
      status: "failed",
      error: "Worker crashed",
    });
    expect(queue.getSnapshot()[1]?.status).toBe("completed");
  });

  it("preserves structured failure diagnostics when submission fails before persistence", async () => {
    const queue = new MediaGenerationQueue({
      readRunDetail: async () => {
        throw new Error("Run record unavailable");
      },
    });
    queue.enqueue({
      runId: "invalid-run",
      recipe: recipe("image", "Invalid request"),
      execute: async () => {
        throw new MediaRuntimeError({
          schemaVersion: 1,
          code: "INVALID_REQUEST",
          category: "validation",
          message: "Some media settings are invalid.",
          technicalDiagnostic: "editMask must match baseImageAssetId",
          retryability: "after-user-action",
          suggestedActions: [],
          context: {
            providerId: null,
            modelId: null,
            runtimeId: null,
            runId: null,
            assetId: null,
            nodeId: null,
            operation: "media_generate_images",
          },
          partialOutputsExist: false,
        });
      },
    });

    await vi.waitFor(() =>
      expect(queue.getSnapshot()[0]?.status).toBe("failed"),
    );
    expect(queue.getSnapshot()[0]?.failure).toMatchObject({
      code: "INVALID_REQUEST",
      technicalDiagnostic: "editMask must match baseImageAssetId",
    });
  });

  it("keeps a multi-stage job canceled when its active stage exits", async () => {
    const activeStage = deferred<MediaRunDetail>();
    const cancelStage = vi.fn(async () => detail("endpoint-run", "canceled"));
    const queue = new MediaGenerationQueue();
    queue.enqueue({
      runId: "video-run",
      recipe: recipe("video", "Video"),
      execute: () => activeStage.promise,
      cancel: cancelStage,
    });

    await vi.waitFor(() =>
      expect(queue.getSnapshot()[0]?.status).toBe("running"),
    );
    await queue.cancel("video-run");
    activeStage.reject(new Error("Endpoint canceled"));
    await vi.waitFor(() =>
      expect(queue.getSnapshot()[0]?.status).toBe("canceled"),
    );

    expect(cancelStage).toHaveBeenCalledOnce();
    expect(queue.getSnapshot()[0]?.error).toBeNull();
  });

  it("removes subscriptions on teardown", () => {
    const queue = new MediaGenerationQueue();
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    unsubscribe();
    queue.enqueue({
      runId: "image-run",
      recipe: recipe("image", "Image"),
      execute: async () => detail("image-run"),
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
