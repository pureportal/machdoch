import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import type { MediaAssetRecord } from "../../../core/media/contracts.js";
import {
  createBasicMediaRecipeFlow,
  createBasicVideoDraftFromImage,
} from "./media-basic-generation";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  normalizeMediaStudioState,
} from "./media-studio-store";

const portraitImage: MediaAssetRecord = {
  id: "asset-portrait",
  runId: "run-image",
  digest: "a".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 1024,
  width: 900,
  height: 1600,
  createdAt: "2026-08-20T10:00:00.000Z",
  outputIndex: 0,
  fixture: false,
  operation: null,
  sourceAssetIds: [],
  tags: [
    {
      value: "transparent-image",
      label: "Transparent image",
      source: "technical",
      confidence: 1,
      createdAt: "2026-08-20T10:00:00.000Z",
    },
  ],
};

describe("createBasicVideoDraftFromImage", () => {
  it("opens a ready-to-edit Basic video draft without changing Advanced state", () => {
    const original = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);
    const state = {
      ...original,
      activeSection: "flow" as const,
      target: "svg" as const,
      recipe: {
        ...original.recipe,
        prompt: "Previous SVG prompt",
        outputFormat: "svg" as const,
        referenceImages: [
          { assetId: "old-reference", role: "base" as const, influence: 1 },
        ],
        editMask: {
          schemaVersion: 2 as const,
          sourceAssetId: "old-reference",
          inverted: false,
          strokes: [],
        },
      },
    };

    const next = createBasicVideoDraftFromImage(state, portraitImage);

    expect(next.activeSection).toBe("generate");
    expect(next.target).toBe("video");
    expect(next.recipe.prompt).toBe("");
    expect(next.recipe.outputFormat).toBe("png");
    expect(next.recipe.referenceImages).toEqual([
      { assetId: portraitImage.id, role: "base", influence: 1 },
    ]);
    expect(next.recipe.editMask).toBeNull();
    expect(next.videoRecipe.aspectRatio).toBe("9:16");
    expect(next.videoRecipe.transparentBackground).toBe(true);
    expect(next.flow).toBe(state.flow);
    expect(next.flowLayout).toBe(state.flowLayout);
  });
});

describe("createBasicMediaRecipeFlow", () => {
  it("marks the primary remote reference as the required base image", () => {
    const remoteModel = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: true,
      isLocalFluxInstalled: false,
    }).models.find((model) => model.id === "openai:gpt-image-2")!;
    const state = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);

    const flow = createBasicMediaRecipeFlow({
      id: "media-basic-remote-reference",
      createdAt: "2026-08-21T15:00:00.000Z",
      target: "image",
      models: [remoteModel],
      settings: {
        ...state.recipe,
        prompt: "Refine the product photograph",
        providerPolicy: "remote",
        modelId: remoteModel.id,
        referenceImages: [
          { assetId: portraitImage.id, role: "subject", influence: 1 },
        ],
      },
    });

    expect(
      flow.nodes.find((node) => node.type === "source.image")?.config
        .referenceRole,
    ).toBe("base");
  });

  it("preserves semantic local reference roles", () => {
    const localModel = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    }).models.find((model) => model.id === "local:flux-2-klein-4b")!;
    const state = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);

    const flow = createBasicMediaRecipeFlow({
      id: "media-basic-local-reference",
      createdAt: "2026-08-21T15:00:00.000Z",
      target: "image",
      models: [localModel],
      settings: {
        ...state.recipe,
        prompt: "Preserve this subject",
        providerPolicy: "local",
        modelId: localModel.id,
        referenceImages: [
          { assetId: portraitImage.id, role: "subject", influence: 1 },
        ],
      },
    });

    expect(
      flow.nodes.find((node) => node.type === "source.image")?.config
        .referenceRole,
    ).toBe("subject");
  });
});
