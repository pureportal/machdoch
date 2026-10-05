import { describe, expect, it } from "vitest";
import { createMediaModelCatalog } from "./catalog.js";
import { compileMediaFlow, createImageToVideoFlow } from "./compiler.js";
import type { MediaModelDescriptor } from "./contracts.js";

const createVideoModel = (id: string): MediaModelDescriptor => {
  const model = createMediaModelCatalog({
    isOpenAiConfigured: false,
    isLocalFluxInstalled: true,
  }).find((entry) => entry.id === "local:flux-2-klein-4b")!;
  return {
    ...model,
    id,
    architecture: "ltx-video",
    displayName: "LTX-Video",
    capabilities: ["text-to-video", "image-to-video", "start-end-to-video"],
    addonCapabilities: [],
  };
};

const compileVideo = (modelId: string | null, models: MediaModelDescriptor[]) => {
  const flow = createImageToVideoFlow({
    id: "video-readiness",
    createdAt: "2026-10-05T00:00:00.000Z",
    sourceAssetId: "asset:first-frame",
    lastFrameAssetId: "asset:last-frame",
    prompt: "A red teapot rotating on a tabletop",
    settings: {
      transparentBackground: false,
      loopMode: "none",
      resolution: "preview-512",
      fps: 8,
      numFrames: 33,
      numInferenceSteps: 8,
      guidanceScale: 1,
    },
  });
  const task = flow.nodes.find((node) => node.type === "task.generate-video")!;
  task.config.modelId = modelId;
  return compileMediaFlow({
    flow,
    models,
    compiledAt: "2026-10-05T00:01:00.000Z",
  });
};

describe("video model readiness", () => {
  it("retains a selected compatible model and gives its runtime recovery action", () => {
    const model = {
      ...createVideoModel("local:ltx-video"),
      configured: false,
      runtimeReadiness: "runtime-unavailable" as const,
    };
    const plan = compileVideo(model.id, [model]);
    expect(plan.status).toBe("blocked");
    expect(plan.model?.id).toBe(model.id);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "MODEL_NOT_READY",
        action: "Set up Media Studio to use local models.",
      }),
    );
    expect(
      plan.diagnostics.some((entry) => entry.code === "MODEL_NOT_FOUND"),
    ).toBe(false);
  });

  it("chooses only ready models when no model is selected", () => {
    const unavailable = {
      ...createVideoModel("local:ltx-unavailable"),
      configured: false,
      runtimeReadiness: "runtime-unavailable" as const,
      qualityScore: 100,
    };
    const ready = { ...createVideoModel("local:ltx-ready"), qualityScore: 50 };
    const plan = compileVideo(null, [unavailable, ready]);
    expect(plan.status, JSON.stringify(plan.diagnostics)).toBe("ready");
    expect(plan.model?.id).toBe(ready.id);
  });
});
