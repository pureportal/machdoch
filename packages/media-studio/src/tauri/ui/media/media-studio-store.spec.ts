import { describe, expect, it } from "vitest";
import {
  normalizeImageRecipeSettings,
  normalizeMediaStudioState,
} from "./media-studio-store";

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

  it("normalizes reference images into bounded provider-neutral roles", () => {
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
      { assetId: "asset:base", role: "style", influence: 2 },
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

  it("preserves bounded image and memory controls across persistence", () => {
    expect(
      normalizeImageRecipeSettings({
        editStrength: 2,
        requireChromaBackground: true,
        memoryProfile: "memory-saver",
      }),
    ).toMatchObject({
      editStrength: 1,
      requireChromaBackground: true,
      memoryProfile: "memory-saver",
    });

    expect(
      normalizeImageRecipeSettings({
        editStrength: Number.NaN,
        memoryProfile: "unsafe",
      }),
    ).toMatchObject({
      editStrength: 0.65,
      requireChromaBackground: false,
      memoryProfile: "auto",
    });
  });
});

describe("media asset metadata normalization", () => {
  it("keeps safe links and rejects untrusted sample hosts", () => {
    const state = normalizeMediaStudioState({
      version: 5,
      categories: [
        { id: "portrait", name: "Portrait" },
        { id: "style", name: "Style" },
      ],
      assetMetadata: {
        "addon:test": {
          categoryIds: ["portrait", "missing", "portrait"],
          tags: ["style", "style"],
          triggerWords: " hero pose, cinematic  light\nHERO POSE ",
          sourceUrl: "https://civitai.red/models/123",
          sampleAssetIds: ["asset:sample"],
          sampleImages: [
            { url: "https://image.civitai.com/sample.webp", width: 512 },
            { url: "https://example.com/tracker.webp" },
          ],
        },
      },
    });

    expect(state.assetMetadata["addon:test"]).toEqual({
      categoryIds: ["portrait"],
      tags: ["style"],
      triggerWords: "hero pose, cinematic light",
      sourceUrl: "https://civitai.red/models/123",
      sampleAssetIds: ["asset:sample"],
      sampleImages: [
        {
          url: "https://image.civitai.com/sample.webp",
          width: 512,
          height: null,
        },
      ],
    });
  });
});

describe("stored flow normalization", () => {
  it("drops fields removed from the current node schema", () => {
    const state = normalizeMediaStudioState({
      version: 5,
      flow: {
        schemaVersion: 1,
        id: "flow:stale-conditioned-edit",
        name: "Conditioned edit",
        description: "",
        createdAt: "2026-08-21T00:00:00.000Z",
        updatedAt: "2026-08-21T00:00:00.000Z",
        variables: [],
        variableBindings: {},
        presets: [],
        activePresetId: null,
        nodes: [
          {
            id: "edit",
            type: "task.edit-image",
            version: 1,
            label: "Generate",
            layer: "task",
            config: {
              providerPolicy: "local",
              aspectRatio: "1:1",
              outputCount: 1,
              outputFormat: "png",
              groundingPixels: 768,
              referenceBoost: 2,
              referenceFit: "fit",
            },
          },
        ],
        edges: [],
      },
    });

    expect(state.flow?.nodes[0]?.config).toEqual({
      providerPolicy: "local",
      aspectRatio: "1:1",
      outputCount: 1,
      outputFormat: "png",
    });
  });
});
