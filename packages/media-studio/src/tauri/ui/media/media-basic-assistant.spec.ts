import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import { createDefaultMediaNodeConfig } from "../../../core/media/node-registry.js";
import { DEFAULT_MEDIA_STUDIO_STATE } from "./media-studio-store";
import {
  basicAssistantDraftIdentity,
  createBasicAssistantFlow,
  readBasicAssistantDraft,
  type MediaBasicAssistantDraft,
} from "./media-basic-assistant";

const models = createMediaModelCatalogSnapshot({
  isOpenAiConfigured: false,
  isLocalFluxInstalled: true,
}).models;
models.push(
  {
    ...models.find((model) => model.id === "local:flux-2-klein-4b")!,
    id: "local:sdxl",
    displayName: "SDXL",
    architecture: "stable-diffusion-xl",
    capabilities: ["text-to-image"],
  },
  {
    ...models.find((model) => model.id === "local:flux-2-klein-4b")!,
    id: "local:minimax",
    displayName: "MiniMax H3",
    architecture: "minimax-h3-ref2va",
    capabilities: ["image-to-video"],
  },
);
const draft = (
  target: MediaBasicAssistantDraft["target"] = "image",
): MediaBasicAssistantDraft =>
  structuredClone({
    target,
    recipe: {
      ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
      prompt: "A ceramic teapot",
      outputFormat: target === "svg" ? "svg" : "png",
      qualityGateEnabled: false,
    },
    videoRecipe: DEFAULT_MEDIA_STUDIO_STATE.videoRecipe,
    audioRecipe: {
      ...DEFAULT_MEDIA_STUDIO_STATE.audioRecipe,
      prompt: "Waves breaking on a beach",
    },
  });

describe("Basic assistant settings", () => {
  it.each(["image", "svg", "audio", "video"] as const)(
    "preserves the %s recipe through the graph",
    (target) => {
      const current = draft(target);
      const flow = createBasicAssistantFlow(current, models);
      const updated = readBasicAssistantDraft(flow, current, models);
      expect(
        readBasicAssistantDraft(
          createBasicAssistantFlow(updated, models),
          updated,
          models,
        ),
      ).toEqual(updated);
      expect(updated.target).toBe(target);
    },
  );

  it("fills image prompt, sampling, seed and synchronized outputs", () => {
    const current = draft();
    current.recipe.seed = 7;
    current.recipe.modelId = models.find(
      (model) => model.architecture === "stable-diffusion-xl",
    )!.id;
    const flow = createBasicAssistantFlow(current, models);
    flow.nodes.find((node) => node.type === "source.prompt")!.config.prompt =
      "A teapot on dark walnut";
    const task = flow.nodes.find(
      (node) => node.type === "task.generate-image",
    )!;
    Object.assign(task.config, {
      outputCount: 2,
      numInferenceSteps: 30,
      guidanceScale: 5,
    });
    flow.nodes.find((node) => node.type === "source.seed")!.config.seed = 42;
    flow.nodes.find(
      (node) => node.type === "output.asset",
    )!.config.outputCount = 2;
    const updated = readBasicAssistantDraft(flow, current, models);
    expect(updated.recipe).toMatchObject({
      prompt: "A teapot on dark walnut",
      seed: 42,
      outputCount: 2,
      sampling: { numInferenceSteps: 30, guidanceScale: 5 },
    });
    expect(updated.videoRecipe).toEqual(current.videoRecipe);
    expect(updated.audioRecipe).toEqual(current.audioRecipe);
  });

  it("fills standalone audio duration and negative prompt", () => {
    const current = draft("audio");
    const flow = createBasicAssistantFlow(current, models);
    Object.assign(
      flow.nodes.find((node) => node.type === "task.generate-audio")!.config,
      { durationSeconds: 8, negativePrompt: "Speech", seed: 123 },
    );
    expect(
      readBasicAssistantDraft(flow, current, models).audioRecipe,
    ).toMatchObject({
      durationSeconds: 8,
      negativePrompt: "Speech",
      seed: 123,
    });
  });

  it("rejects sampling settings the selected model cannot use", () => {
    const current = draft();
    current.recipe.modelId = "local:flux-2-klein-4b";
    const flow = createBasicAssistantFlow(current, models);
    const task = flow.nodes.find(
      (node) => node.type === "task.generate-image",
    )!;
    task.config.guidanceScale = 1;
    expect(() => readBasicAssistantDraft(flow, current, models)).toThrow(
      "Clear manual guidance",
    );
    task.config.guidanceScale = null;
    task.config.numInferenceSteps = 30;
    expect(() => readBasicAssistantDraft(flow, current, models)).toThrow(
      "4 sampling steps",
    );
    task.config.numInferenceSteps = 4;
    task.config.width = 512;
    expect(() => readBasicAssistantDraft(flow, current, models)).toThrow(
      "both width and height",
    );
  });

  it("retains MiniMax video audio and a connected starting image", () => {
    const current = draft("video");
    current.videoRecipe.modelId = "local:minimax";
    current.recipe.referenceImages = [
      { assetId: "asset:start", role: "base", influence: 1 },
    ];
    const flow = createBasicAssistantFlow(current, models);
    expect(
      flow.nodes.find((node) => node.type === "task.generate-video")!.config
        .generateAudio,
    ).toBe(true);
    expect(
      readBasicAssistantDraft(flow, current, models).recipe.referenceImages,
    ).toEqual(current.recipe.referenceImages);
  });

  it("preserves image references and their influence", () => {
    const current = draft();
    current.recipe.referenceImages = [
      { assetId: "asset:style", role: "style", influence: 0.6 },
    ];
    const flow = createBasicAssistantFlow(current, models);
    flow.nodes.find((node) => node.type === "source.prompt")!.config.prompt =
      "A blue teapot";
    expect(
      readBasicAssistantDraft(flow, current, models).recipe.referenceImages,
    ).toEqual(current.recipe.referenceImages);
  });

  it("rejects operations that cannot be represented in Basic", () => {
    const current = draft();
    const flow = createBasicAssistantFlow(current, models);
    const output = flow.edges.find((edge) => edge.toNodeId === "asset-output")!;
    flow.nodes.push({
      id: "resize",
      type: "operation.resize",
      label: "Resize",
      version: 1,
      layer: "operation",
      config: createDefaultMediaNodeConfig("operation.resize"),
    });
    flow.edges.push({
      id: "resize-output",
      fromNodeId: "resize",
      fromPortId: "image",
      toNodeId: "asset-output",
      toPortId: "image",
    });
    output.toNodeId = "resize";
    expect(() => readBasicAssistantDraft(flow, current, models)).toThrow(
      "Advanced mode",
    );
  });

  it("rejects unsynchronized output settings and a changed media type", () => {
    const current = draft();
    const flow = createBasicAssistantFlow(current, models);
    flow.nodes.find((node) => node.type === "output.asset")!.config.format =
      "webp";
    expect(() => readBasicAssistantDraft(flow, current, models)).toThrow();
    expect(() =>
      readBasicAssistantDraft(
        createBasicAssistantFlow(draft("audio"), models),
        current,
        models,
      ),
    ).toThrow();
  });

  it("detects target and hidden-setting changes while waiting", () => {
    const current = draft();
    const changed = structuredClone(current);
    changed.videoRecipe.seed = 123;
    expect(basicAssistantDraftIdentity(changed)).not.toBe(
      basicAssistantDraftIdentity(current),
    );
    expect(
      basicAssistantDraftIdentity({ ...current, target: "video" }),
    ).not.toBe(basicAssistantDraftIdentity(current));
  });
});
