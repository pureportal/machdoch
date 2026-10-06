import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import type {
  MediaModelAddonDescriptor,
  MediaModelDescriptor,
} from "../../../core/media/contracts.js";
import { getMediaModelAddonCapabilities } from "../../../core/media/model-addons.js";
import { createOpenMediaModels } from "../../../core/media/open-model-profiles.js";
import { selectMediaAddonImageModel } from "./media-addon-model";

const template = createMediaModelCatalogSnapshot({ isOpenAiConfigured: false })
  .models[0];
if (!template) throw new Error("The catalog fixture has no models.");

const model = (
  id: string,
  overrides: Partial<MediaModelDescriptor> = {},
): MediaModelDescriptor => ({
  ...template,
  id,
  displayName: id,
  providerId: "local-diffusers",
  target: "local",
  family: "SDXL",
  architecture: "stable-diffusion-xl",
  installed: true,
  configured: true,
  capabilities: ["text-to-image"],
  addonCapabilities: getMediaModelAddonCapabilities(
    "local-diffusers",
    "stable-diffusion-xl",
  ),
  ...overrides,
});

const addon: MediaModelAddonDescriptor = {
  id: "trained-addon",
  kind: "lora",
  displayName: "Trained concept",
  architecture: "stable-diffusion-xl",
  architectureConfidence: "high",
  format: "safetensors",
  targetComponents: ["denoiser"],
  embeddingVectors: [],
  loraProfile: {
    algorithm: "lora",
    dialect: "diffusers-peft",
    rankMinimum: 4,
    rankMaximum: 4,
    heterogeneousRanks: false,
    targetModuleCount: 4,
    convolutionTargetCount: 0,
    magnitudeVectorCount: 0,
    networkAlphaCount: 0,
  },
  baseModelHint: null,
  triggerWords: ["concept"],
  defaultToken: null,
  digest: "a".repeat(64),
  headerDigest: "b".repeat(64),
  byteSize: 4096,
  relativePath: "addons/concept.safetensors",
  sourceUrl: null,
  license: template.license,
  importedAt: "2026-10-06T00:00:00Z",
};

describe("trained addon model selection", () => {
  it.each(["flux-1-dev", "flux-1-schnell", "sana"] as const)(
    "selects the catalog training base for a %s LoRA",
    (architecture) => {
      const catalogModel = createOpenMediaModels("test").find(
        (candidate) => candidate.architecture === architecture,
      );
      if (!catalogModel)
        throw new Error("The training model is missing from the catalog.");
      const base = { ...catalogModel, installed: true };
      expect(
        selectMediaAddonImageModel(
          [base],
          { ...addon, architecture },
          [base.id],
          null,
          base.id,
        )?.id,
      ).toBe(base.id);
    },
  );

  it("selects the training base when Basic has no model selected", () => {
    expect(
      selectMediaAddonImageModel(
        [model("training-base")],
        addon,
        ["training-base"],
        null,
        "training-base",
      )?.id,
    ).toBe("training-base");
  });

  it("selects the training base over another compatible model in Basic", () => {
    const models = [model("other"), model("training-base")];
    expect(
      selectMediaAddonImageModel(
        models,
        addon,
        ["other", "training-base"],
        "other",
        "training-base",
      )?.id,
    ).toBe("training-base");
  });

  it.each([
    { installed: false },
    { architecture: "stable-diffusion-1" },
  ] as const)(
    "rejects an unavailable or incompatible training base",
    (overrides) => {
      const models = [model("other"), model("training-base", overrides)];
      expect(
        selectMediaAddonImageModel(
          models,
          addon,
          ["other", "training-base"],
          "other",
          "training-base",
        ),
      ).toBeUndefined();
    },
  );

  it("requires the training base to be runnable", () => {
    const models = [model("other"), model("training-base")];
    expect(
      selectMediaAddonImageModel(
        models,
        addon,
        ["other"],
        "other",
        "training-base",
      ),
    ).toBeUndefined();
  });

  it("keeps a compatible Basic selection for an addon without a training base", () => {
    const models = [model("first"), model("selected")];
    expect(
      selectMediaAddonImageModel(
        models,
        addon,
        ["first", "selected"],
        "selected",
        null,
      )?.id,
    ).toBe("selected");
  });

  it("selects the training base for paired CLIP embeddings", () => {
    const embedding: MediaModelAddonDescriptor = {
      ...addon,
      kind: "textual-inversion",
      loraProfile: null,
      targetComponents: ["text-encoder", "text-encoder-2"],
      defaultToken: "<concept>",
      embeddingVectors: [
        {
          component: "text-encoder",
          tensorKey: "clip_l",
          vectorCount: 1,
          dimension: 768,
        },
        {
          component: "text-encoder-2",
          tensorKey: "clip_g",
          vectorCount: 1,
          dimension: 1280,
        },
      ],
    };
    expect(
      selectMediaAddonImageModel(
        [model("other"), model("training-base")],
        embedding,
        ["other", "training-base"],
        "other",
        "training-base",
      )?.id,
    ).toBe("training-base");
  });
});
