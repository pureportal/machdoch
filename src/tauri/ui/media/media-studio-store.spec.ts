import { describe, expect, it } from "vitest";
import { normalizeImageRecipeSettings } from "./media-studio-store";

describe("image recipe normalization", () => {
  it("normalizes unsafe recipe values into bounded settings", () => {
    expect(
      normalizeImageRecipeSettings({
        prompt: "Create a poster",
        providerPolicy: "unsupported",
        modelPolicy: "quality",
        aspectRatio: "4:5",
        outputCount: 100,
        outputFormat: "png",
        transparentBackground: true,
        qualityGateEnabled: false,
      }),
    ).toMatchObject({
      prompt: "Create a poster",
      providerPolicy: "auto",
      modelPolicy: "quality",
      aspectRatio: "4:5",
      outputCount: 8,
      transparentBackground: true,
      qualityGateEnabled: false,
      referenceImages: [],
    });
  });

  it("normalizes reference images into one base and bounded provider-neutral roles", () => {
    const recipe = normalizeImageRecipeSettings({
      referenceImages: [
        { assetId: "", role: "base", influence: 1 },
        { assetId: " asset:base ", role: "style", influence: 4 },
        { assetId: "asset:style", role: "palette", influence: 0.45 },
        { assetId: "asset:style", role: "detail", influence: 0.2 },
        { assetId: "asset:unknown", role: "unsupported", influence: -1 },
      ],
    });

    expect(recipe.referenceImages).toEqual([
      { assetId: "asset:base", role: "base", influence: 1 },
      { assetId: "asset:style", role: "palette", influence: 0.45 },
      { assetId: "asset:unknown", role: "subject", influence: 0 },
    ]);
  });

  it("normalizes persisted LoRA and textual-inversion controls", () => {
    const recipe = normalizeImageRecipeSettings({
      modelAddons: [
        {
          kind: "lora",
          addonId: " addon:lora:detail ",
          enabled: true,
          modelStrength: 999,
          textEncoderStrength: -999,
          denoisingSchedule: { start: -0.5, end: 0.75 },
        },
        {
          kind: "textual-inversion",
          addonId: "addon:embedding:concept",
          enabled: false,
          token: " <concept> ",
          placement: "negative",
        },
        { kind: "unknown", addonId: "addon:bad" },
      ],
    });

    expect(recipe.modelAddons).toEqual([
      {
        kind: "lora",
        addonId: "addon:lora:detail",
        enabled: true,
        modelStrength: 100,
        textEncoderStrength: -100,
        denoisingSchedule: { start: 0, end: 0.75 },
      },
      {
        kind: "textual-inversion",
        addonId: "addon:embedding:concept",
        enabled: false,
        token: "<concept>",
        placement: "negative",
      },
    ]);
  });

  it("preserves bounded KREA reference and memory controls across persistence", () => {
    expect(
      normalizeImageRecipeSettings({
        editStrength: 2,
        referenceBoost: 0,
        requireChromaBackground: true,
        referenceFit: "crop",
        groundingPixels: 9_999,
        memoryProfile: "memory-saver",
      }),
    ).toMatchObject({
      editStrength: 1,
      referenceBoost: 0.25,
      requireChromaBackground: true,
      referenceFit: "crop",
      groundingPixels: 1_024,
      memoryProfile: "memory-saver",
    });

    expect(
      normalizeImageRecipeSettings({
        editStrength: Number.NaN,
        referenceBoost: Number.POSITIVE_INFINITY,
        referenceFit: "stretch",
        groundingPixels: 64,
        memoryProfile: "unsafe",
      }),
    ).toMatchObject({
      editStrength: 0.65,
      referenceBoost: 2,
      requireChromaBackground: false,
      referenceFit: "fit",
      groundingPixels: 384,
      memoryProfile: "auto",
    });
  });

});
