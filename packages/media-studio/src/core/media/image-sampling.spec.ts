import { describe, expect, it } from "vitest";
import { compileMediaFlow, createImageRecipeFlow } from "./compiler.js";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import { DEFAULT_MEDIA_STUDIO_STATE } from "../../tauri/ui/media/media-studio-store.js";
import {
  compatibleMediaImageSamplers,
  mediaImageSamplingError,
  readMediaImageSampling,
  defaultMediaImageSteps,
  mediaImageSamplingConstraints,
  mediaImageSamplingProfile,
} from "./image-sampling.js";

describe("image samplers", () => {
  it("uses editable guidance and quality defaults for extended Krea", () => {
    expect(defaultMediaImageSteps("krea-2", "fast")).toBe(8);
    expect(defaultMediaImageSteps("krea-2", "quality")).toBe(12);
    expect(mediaImageSamplingConstraints("krea-2").manualGuidance).toBe(true);
    expect(mediaImageSamplingProfile("krea-2")?.defaultGuidance).toBe(0.5);
    expect(
      mediaImageSamplingError({ guidanceScale: 0.5 }, "krea-2"),
    ).toBeNull();
    expect(
      mediaImageSamplingError({ guidanceScale: 0.5 }, "krea-2-turbo"),
    ).toContain("guidance 0");
  });
  it("keeps base Qwen guidance editable while rejecting values below one", () => {
    expect(
      mediaImageSamplingError({ guidanceScale: 4 }, "qwen-image-2.1"),
    ).toBeNull();
    expect(
      mediaImageSamplingError({ guidanceScale: 0 }, "qwen-image-2.1"),
    ).toContain("at least 1");
  });
  it("compiles Automatic sampling without blocking Basic generation", () => {
    const catalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    });
    const flow = createImageRecipeFlow({
      id: "automatic-sampler",
      createdAt: "2026-10-11T00:00:00Z",
      settings: {
        ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
        prompt: "A red teapot",
        modelId: "local:flux-2-klein-4b",
        sampling: { sampler: null },
      },
    });
    const plan = compileMediaFlow({
      flow,
      models: catalog.models,
      compiledAt: "2026-10-11T00:00:01Z",
    });
    expect(
      plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ).toEqual([]);
  });

  it("compiles a Basic sampler into the advanced task and provider request", () => {
    const catalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    });
    const model = catalog.models.find(
      (model) => model.id === "local:flux-2-klein-4b",
    )!;
    const flow = createImageRecipeFlow({
      id: "sampler",
      createdAt: "2026-10-11T00:00:00Z",
      settings: {
        ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
        prompt: "A red teapot",
        modelId: model.id,
        sampling: { sampler: "flow-euler" },
      },
    });
    const task = flow.nodes.find(
      (node) => node.type === "task.generate-image",
    )!;
    expect(task.config.sampler).toBe("flow-euler");
    expect(readMediaImageSampling(task.config).sampler).toBe("flow-euler");
    const plan = compileMediaFlow({
      flow,
      models: catalog.models,
      compiledAt: "2026-10-11T00:00:01Z",
    });
    expect(
      plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
    ).toEqual([]);
  });

  it("rejects samplers from another model family and locks the Turbo schedule", () => {
    expect(
      compatibleMediaImageSamplers("krea-2").map((sampler) => sampler.value),
    ).toEqual(["flow-euler"]);
    expect(
      compatibleMediaImageSamplers("pony").some(
        (sampler) => sampler.value === "dpmpp-2m-karras",
      ),
    ).toBe(true);
    expect(
      mediaImageSamplingError({ sampler: "flow-euler" }, "pony"),
    ).toContain("compatible sampler");
    expect(
      mediaImageSamplingError(
        { numInferenceSteps: 20 },
        "qwen-image-2.1-turbo",
      ),
    ).toContain("8 sampling steps");
    expect(
      mediaImageSamplingError({ guidanceScale: 5 }, "qwen-image-2.1-turbo"),
    ).toContain("guidance 1");
  });
});
