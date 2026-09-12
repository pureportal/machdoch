import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { MediaRunDetail } from "../../../core/media/contracts.js";
import {
  enqueueMediaGeneration,
  hasPendingMediaGeneration,
  setMediaGenerationPreparing,
} from "./media-generation-service";

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(async () => undefined),
}));

vi.mock("./media-runtime", () => ({
  cancelMediaRun: vi.fn(),
  getMediaRunDetail: vi.fn(),
}));

describe("media shutdown activity", () => {
  it("keeps concurrent preparation visible to every window until all submissions settle", async () => {
    const first = Symbol();
    const second = Symbol();
    expect(hasPendingMediaGeneration()).toBe(false);
    await setMediaGenerationPreparing(first, true);
    await setMediaGenerationPreparing(second, true);
    await setMediaGenerationPreparing(first, false);
    expect(hasPendingMediaGeneration()).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("set_window_pending_media_work", {
      pending: true,
    });
    await setMediaGenerationPreparing(second, false);
    expect(hasPendingMediaGeneration()).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("set_window_pending_media_work", {
      pending: false,
    });
  });

  it("registers queued work before executing and releases it only after settlement", async () => {
    let finish!: (detail: MediaRunDetail) => void;
    const result = new Promise<MediaRunDetail>((resolve) => {
      finish = resolve;
    });
    const execute = vi.fn(() => {
      expect(invoke).toHaveBeenLastCalledWith("set_window_pending_media_work", {
        pending: true,
      });
      return result;
    });
    enqueueMediaGeneration({
      runId: "registered-image",
      recipe: {
        schemaVersion: 1,
        mode: "basic",
        target: "image",
        flowId: "flow",
        flowName: "Image",
        flowRevisionId: "revision",
        flowRevisionNumber: 1,
        planId: "plan",
        prompt: "Image",
        modelId: null,
        modelLabel: "Model",
        modelAddons: [],
        outputBranches: [],
        imageSettings: null,
        videoSettings: null,
        resultDestination: "assets",
      },
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(hasPendingMediaGeneration()).toBe(true);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    finish({
      id: "registered-image",
      flowId: "flow",
      flowRevisionId: "revision",
      flowName: "Image",
      planId: "plan",
      status: "completed",
      createdAt: "2026-09-12T12:00:00Z",
      updatedAt: "2026-09-12T12:00:01Z",
      prompt: "Image",
      modelLabel: "Model",
      target: "local",
      outputCount: 1,
      diagnosticCount: 0,
      assets: [],
      progress: 1,
      currentStep: "Completed",
      executor: "local-import",
      error: null,
      failure: null,
      events: [],
      providerJobs: [],
      humanReviews: [],
      nodeExecutions: [],
      planSnapshot: null,
    });
    await vi.waitFor(() => expect(hasPendingMediaGeneration()).toBe(false));
    expect(invoke).toHaveBeenLastCalledWith("set_window_pending_media_work", {
      pending: false,
    });
  });
});
