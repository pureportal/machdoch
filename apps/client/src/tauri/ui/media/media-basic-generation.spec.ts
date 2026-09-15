import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import type {
  MediaAssetRecord,
  MediaModelDescriptor,
} from "../../../core/media/contracts.js";
import {
  createBasicMediaRecipeFlow,
  createBasicMediaVideoFlow,
  createBasicVideoDraftFromImage,
  createBasicImageDraftFromAsset,
} from "./media-basic-generation";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  normalizeMediaStudioState,
} from "./media-studio-store";
import {
  MEDIA_VIDEO_QUALITY_PRESETS,
  identifyMediaVideoQualityPreset,
} from "../../../core/media/video-quality.js";
import {
  readImageRecipeSettings,
  compileMediaFlow,
} from "../../../core/media/compiler.js";
import { readMediaVideoRecipeSettings } from "./media-generation-recipe";

describe("Basic video configuration", () => {
  it("preserves crossfade through saved settings and Basics/Advanced conversion", () => {
    const state = normalizeMediaStudioState({
      ...DEFAULT_MEDIA_STUDIO_STATE,
      videoRecipe: {
        ...DEFAULT_MEDIA_STUDIO_STATE.videoRecipe,
        loopMode: "crossfade",
        numFrames: 33,
      },
    });
    const flow = createBasicMediaVideoFlow({
      id: "crossfade-roundtrip",
      createdAt: "2026-09-15T00:00:00Z",
      imageSettings: state.recipe,
      videoSettings: state.videoRecipe,
    });
    expect(state.videoRecipe.loopMode).toBe("crossfade");
    expect(readMediaVideoRecipeSettings(flow)).toMatchObject({
      loopMode: "crossfade",
      numFrames: 33,
    });
  });
  it.each([false, true])(
    "keeps Draft sampling, encoding, and transparency through conversion (%s)",
    (transparentBackground) => {
      const video = {
        ...DEFAULT_MEDIA_STUDIO_STATE.videoRecipe,
        ...MEDIA_VIDEO_QUALITY_PRESETS[0]!.settings,
        modelId: "local:hunyuan-video-1.5-i2v-step-distilled" as const,
        transparentBackground,
      };
      const flow = createBasicMediaVideoFlow({
        id: "basic-video",
        createdAt: "2026-09-14T00:00:00Z",
        imageSettings: {
          ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
          prompt: "A cat turns its head",
        },
        videoSettings: video,
      });
      const generation = flow.nodes.find(
        (node) => node.type === "task.generate-video",
      )!;
      expect(
        identifyMediaVideoQualityPreset(
          generation.config,
          "hunyuan-video-1.5-i2v",
        ),
      ).toBe("draft");
      expect(readMediaVideoRecipeSettings(flow)).toMatchObject(video);
      expect(
        flow.nodes.some((node) => node.type === "operation.video-composite"),
      ).toBe(false);
      expect(
        flow.nodes.find((node) => node.type === "output.video")?.config.role,
      ).toBe(transparentBackground ? "transparent" : "opaque");
      const models = createMediaModelCatalogSnapshot({
        isOpenAiConfigured: false,
        isLocalFluxInstalled: true,
        isLocalBiRefNetInstalled: true,
      }).models;
      const videoModel: MediaModelDescriptor = {
        ...models.find((model) => model.id === "local:flux-2-klein-4b")!,
        id: video.modelId,
        architecture: "hunyuan-video-1.5-i2v",
        capabilities: ["image-to-video", "transparent-output", "alpha-video"],
      };
      const plan = compileMediaFlow({
        flow,
        models: [...models, videoModel],
        compiledAt: "2026-09-14T00:00:00Z",
      });
      expect(
        plan.diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error",
        ),
      ).toEqual([]);
    },
  );
});

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
  it("clears unrelated image conditioning and hidden quality gates", () => {
    const state = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);
    state.recipe.baseImageAssetId = "old-base";
    state.recipe.poseImageAssetId = "old-pose";
    state.recipe.qualityGateEnabled = true;
    expect(
      createBasicVideoDraftFromImage(state, portraitImage).recipe,
    ).toMatchObject({
      baseImageAssetId: null,
      poseImageAssetId: null,
      qualityGateEnabled: false,
      referenceImages: [
        { assetId: portraitImage.id, role: "base", influence: 1 },
      ],
    });
  });
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

describe("image reuse journeys", () => {
  it.each(["edit", "reference"] as const)(
    "opens %s in Image after a video or SVG draft",
    (purpose) => {
      const state = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);
      state.target = "video";
      state.recipe.outputFormat = "svg";
      state.recipe.referenceImages = [
        { assetId: "unrelated", role: "subject", influence: 1 },
      ];
      state.recipe.baseImageAssetId = "old-base";
      state.recipe.poseImageAssetId = "old-pose";
      state.recipe.qualityGateEnabled = true;
      const next = createBasicImageDraftFromAsset(
        state,
        portraitImage,
        purpose,
      );
      expect(next.target).toBe("image");
      expect(next.activeSection).toBe("generate");
      expect(next.flow).toBe(state.flow);
      expect(next.recipe).toMatchObject({
        outputFormat: "png",
        prompt: "",
        poseImageAssetId: null,
        qualityGateEnabled: false,
        baseImageAssetId: purpose === "edit" ? portraitImage.id : null,
        referenceImages:
          purpose === "reference"
            ? [{ assetId: portraitImage.id, role: "subject", influence: 1 }]
            : [],
      });
      expect(state.recipe.baseImageAssetId).toBe("old-base");
    },
  );
});

describe("createBasicMediaRecipeFlow", () => {
  it.each([null, "base-asset"])(
    "preserves independent reference influences with base %s",
    (baseImageAssetId) => {
      const referenceImages = [
        { assetId: "subject-asset", role: "subject" as const, influence: 0.25 },
        { assetId: "style-asset", role: "style" as const, influence: 0.8 },
      ];
      const flow = createBasicMediaRecipeFlow({
        id: "reference-influence",
        createdAt: "2026-09-15T00:00:00Z",
        target: "image",
        settings: {
          ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
          baseImageAssetId,
          referenceImages,
        },
      });
      expect(readImageRecipeSettings(flow)).toMatchObject({
        baseImageAssetId,
        referenceImages,
      });
    },
  );

  it("preserves the primary remote reference role", () => {
    const remoteModel = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: true,
      isLocalFluxInstalled: false,
    }).models.find((model) => model.id === "openai:gpt-image-2")!;
    const state = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);

    const flow = createBasicMediaRecipeFlow({
      id: "media-basic-remote-reference",
      createdAt: "2026-08-21T15:00:00.000Z",
      target: "image",
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
    ).toBe("subject");
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

describe("Basic custom settings conversion", () => {
  it("preserves image sampling through persistence and conversion", () => {
    const sampling = {
      width: 640,
      height: 960,
      numInferenceSteps: 18,
      guidanceScale: 5.5,
    };
    const state = normalizeMediaStudioState({
      ...DEFAULT_MEDIA_STUDIO_STATE,
      recipe: {
        ...DEFAULT_MEDIA_STUDIO_STATE.recipe,
        prompt: "Bowl",
        sampling,
        seed: 42,
      },
    });
    const flow = createBasicMediaRecipeFlow({
      id: "custom-image",
      createdAt: "2026-09-14T00:00:00Z",
      target: "image",
      settings: state.recipe,
    });
    expect(readImageRecipeSettings(flow)).toMatchObject({ sampling, seed: 42 });
  });

  it("preserves manual video dimensions, timing, and seed", () => {
    const settings = {
      ...DEFAULT_MEDIA_STUDIO_STATE.videoRecipe,
      modelId: "local:wan2.2-ti2v-5b" as const,
      width: 640,
      height: 384,
      fps: 12,
      numFrames: 25,
      numInferenceSteps: 20,
      seed: 78,
    };
    const state = normalizeMediaStudioState({
      ...DEFAULT_MEDIA_STUDIO_STATE,
      videoRecipe: settings,
    });
    const flow = createBasicMediaVideoFlow({
      id: "custom-video",
      createdAt: "2026-09-14T00:00:00Z",
      imageSettings: {
        ...state.recipe,
        referenceImages: [{ assetId: "image", role: "base", influence: 1 }],
      },
      videoSettings: state.videoRecipe,
    });
    expect(readMediaVideoRecipeSettings(flow)).toMatchObject(settings);
  });
});
