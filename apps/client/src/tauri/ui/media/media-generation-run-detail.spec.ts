import { afterEach, describe, expect, it, vi } from "vitest";
import type { MediaRunDetail } from "../../../core/media/contracts.js";
import type { MediaGenerationRecipeSnapshot } from "./media-generation-queue";
import { generationJobToRunDetail } from "./media-generation-run";
import {
  getMediaGenerationRunDetail,
  mediaGenerationQueue,
} from "./media-generation-service";
import { getMediaRunDetail } from "./media-runtime";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => false,
}));

vi.mock("./media-runtime", () => ({
  getMediaRunDetail: vi.fn(),
  cancelMediaRun: vi.fn(),
  normalizeMediaError: vi.fn(),
}));

const recipe: MediaGenerationRecipeSnapshot = {
  schemaVersion: 1,
  mode: "advanced",
  target: "video",
  flowId: "video-flow",
  flowName: "Animate image",
  flowRevisionId: "revision-1",
  flowRevisionNumber: 1,
  planId: "plan-1",
  prompt: "Painting process",
  modelId: "local:wan2.2-ti2v-5b",
  modelLabel: "WAN",
  modelAddons: [],
  outputBranches: [],
  imageSettings: null,
  videoSettings: null,
  resultDestination: "assets",
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("generation run details", () => {
  it("reads queued and starting runs without querying missing native records", async () => {
    vi.useFakeTimers();
    let complete!: (detail: MediaRunDetail) => void;
    const active = mediaGenerationQueue.enqueue({
      runId: "active-video",
      recipe,
      execute: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    });
    const pending = mediaGenerationQueue.enqueue({
      runId: "queued-video",
      recipe,
      execute: vi.fn(),
    });

    await expect(
      getMediaGenerationRunDetail(active.runId),
    ).resolves.toMatchObject({
      id: active.runId,
      status: "running",
      prompt: recipe.prompt,
    });
    await expect(
      getMediaGenerationRunDetail(pending.runId),
    ).resolves.toMatchObject({
      id: pending.runId,
      status: "queued",
      currentStep: "Waiting in queue",
    });
    expect(getMediaRunDetail).not.toHaveBeenCalled();

    await mediaGenerationQueue.cancel(pending.id);
    complete({ ...generationJobToRunDetail(active), status: "completed" });
    await vi.waitFor(() =>
      expect(mediaGenerationQueue.hasPendingWork()).toBe(false),
    );
  });

  it("loads stored runs and preserves native errors for unknown runs", async () => {
    const detail = {
      id: "stored-video",
      status: "completed",
    } as MediaRunDetail;
    vi.mocked(getMediaRunDetail).mockResolvedValueOnce(detail);
    await expect(getMediaGenerationRunDetail(detail.id)).resolves.toBe(detail);
    expect(getMediaRunDetail).toHaveBeenCalledWith(detail.id);

    const error = new Error("Run is unavailable");
    vi.mocked(getMediaRunDetail).mockRejectedValueOnce(error);
    await expect(getMediaGenerationRunDetail("missing-video")).rejects.toBe(
      error,
    );
  });
});
