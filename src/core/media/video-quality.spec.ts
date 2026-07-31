import type { MediaAssetRecord } from "./contracts.js";
import {
  fitMediaVideoDuration,
  formatMediaAssetAspectRatio,
  identifyMediaVideoQualityPreset,
  inferMediaVideoAspectRatio,
  isMediaVideoFrameCountValid,
  isMediaAssetKnownTransparent,
  MEDIA_VIDEO_QUALITY_PRESETS,
  resolveMediaAssetVideoFrameRate,
  resolveMediaAssetVideoLoopMode,
  resolveMediaVideoDimensions,
  resolveMediaVideoExecutionSettings,
  resolveMediaVideoFrameContract,
  resolveMediaVideoQualityPresetSettings,
  summarizeMediaVideoDelivery,
} from "./video-quality.js";

const asset = (
  operation: MediaAssetRecord["operation"],
  tags: MediaAssetRecord["tags"] = [],
): MediaAssetRecord => ({
  id: "asset:test",
  runId: "run:test",
  digest: "a".repeat(64),
  kind: "image",
  mimeType: "image/png",
  byteSize: 1_024,
  width: 640,
  height: 352,
  createdAt: "2026-07-26T00:00:00.000Z",
  outputIndex: 0,
  fixture: false,
  operation,
  sourceAssetIds: [],
  tags,
});

const videoAsset = (
  hasAlpha: boolean,
  fps = 16,
  loopMode: "none" | "ping-pong" | "seamless" = "ping-pong",
): MediaAssetRecord => ({
  ...asset({
    kind: "local-wan-video-generation",
    output: { hasAlpha, fps, loopMode },
  } as MediaAssetRecord["operation"]),
  kind: "video",
  mimeType: "video/webm",
});

describe("media video quality helpers", () => {
  it("maps every native quality canvas without stretching", () => {
    expect(resolveMediaVideoDimensions("16:9", "quality-640")).toEqual([
      640, 352,
    ]);
    expect(resolveMediaVideoDimensions("9:16", "quality-768")).toEqual([
      432, 768,
    ]);
    expect(resolveMediaVideoDimensions("21:9", "preview-512")).toEqual([
      512, 224,
    ]);
    expect(
      resolveMediaVideoDimensions("16:9", "quality-768", "ltx-video"),
    ).toEqual([768, 448]);
    expect(
      resolveMediaVideoDimensions("21:9", "quality-768", "ltx-video"),
    ).toEqual([768, 320]);
    expect(
      resolveMediaVideoDimensions(
        "16:9",
        "quality-640",
        "hunyuan-video-1.5-i2v",
      ),
    ).toEqual([848, 480]);
    expect(
      resolveMediaVideoDimensions(
        "9:16",
        "quality-640",
        "hunyuan-video-1.5-i2v",
      ),
    ).toEqual([480, 832]);
    expect(
      resolveMediaVideoDimensions(
        "21:9",
        "quality-640",
        "hunyuan-video-1.5-i2v",
      ),
    ).toEqual([944, 416]);
    expect(
      resolveMediaVideoDimensions(
        "9:16",
        "quality-768",
        "hunyuan-video-1.5-i2v",
      ),
    ).toEqual([576, 1008]);
    expect(
      resolveMediaVideoDimensions(
        "21:9",
        "quality-768",
        "hunyuan-video-1.5-i2v",
      ),
    ).toEqual([1152, 496]);
  });

  it("resolves model-native sampling without hidden runtime overrides", () => {
    const qualityPreset = MEDIA_VIDEO_QUALITY_PRESETS.find(
      (preset) => preset.id === "quality",
    )!;
    expect(
      resolveMediaVideoQualityPresetSettings(qualityPreset, "framepack-i2v"),
    ).toMatchObject({ numInferenceSteps: 30, guidanceScale: 9 });
    expect(
      resolveMediaVideoQualityPresetSettings(
        qualityPreset,
        "framepack-i2v",
        "seamless",
      ),
    ).toMatchObject({ numFrames: 49, numInferenceSteps: 30, guidanceScale: 9 });
    expect(
      resolveMediaVideoQualityPresetSettings(qualityPreset, "ltx-video"),
    ).toMatchObject({ numInferenceSteps: 8, guidanceScale: 1 });
    expect(
      resolveMediaVideoExecutionSettings(
        { numInferenceSteps: 23, guidanceScale: 7 },
        "ltx-video",
      ),
    ).toEqual({
      numInferenceSteps: 8,
      guidanceScale: 1,
      modelManaged: true,
    });
    expect(
      resolveMediaVideoExecutionSettings(
        { numInferenceSteps: 8, guidanceScale: 9 },
        "hunyuan-video-1.5-i2v",
      ),
    ).toEqual({
      numInferenceSteps: 8,
      guidanceScale: 1,
      modelManaged: true,
    });
    expect(
      resolveMediaVideoExecutionSettings(
        { numInferenceSteps: 30, guidanceScale: 9 },
        "hunyuan-video-1.5-i2v",
      ),
    ).toEqual({
      numInferenceSteps: 12,
      guidanceScale: 1,
      modelManaged: true,
    });
  });

  it("selects the nearest native aspect for source-aware animation drafts", () => {
    expect(inferMediaVideoAspectRatio(1_024, 1_024)).toBe("1:1");
    expect(inferMediaVideoAspectRatio(1_920, 1_080)).toBe("16:9");
    expect(inferMediaVideoAspectRatio(900, 1_600)).toBe("9:16");
    expect(inferMediaVideoAspectRatio(2_560, 1_080)).toBe("21:9");
    expect(inferMediaVideoAspectRatio(0, 0)).toBe("1:1");
  });

  it("reports model-native frame contracts before an expensive render", () => {
    expect(resolveMediaVideoFrameContract("hunyuan-video-1.5-i2v")).toEqual({
      minimum: 17,
      maximum: 121,
      stride: 4,
    });
    expect(resolveMediaVideoFrameContract("framepack-i2v")).toEqual({
      minimum: 17,
      maximum: 129,
      stride: 4,
    });
    expect(resolveMediaVideoFrameContract("ltx-video")).toEqual({
      minimum: 9,
      maximum: 257,
      stride: 8,
    });
    expect(isMediaVideoFrameCountValid(33, "hunyuan-video-1.5-i2v")).toBe(true);
    expect(isMediaVideoFrameCountValid(129, "hunyuan-video-1.5-i2v")).toBe(
      false,
    );
    expect(isMediaVideoFrameCountValid(129, "framepack-i2v")).toBe(true);
    expect(isMediaVideoFrameCountValid(25, "ltx-video")).toBe(true);
  });

  it("fits requested playback duration to native frame contracts", () => {
    expect(
      fitMediaVideoDuration(3, 16, "ping-pong", "hunyuan-video-1.5-i2v"),
    ).toEqual({
      targetSeconds: 3,
      sourceFrameCount: 25,
      outputFrameCount: 48,
      durationSeconds: 3,
      exact: true,
    });
    expect(
      fitMediaVideoDuration(3, 24, "ping-pong", "hunyuan-video-1.5-i2v"),
    ).toMatchObject({
      sourceFrameCount: 37,
      outputFrameCount: 72,
      durationSeconds: 3,
      exact: true,
    });
    expect(
      fitMediaVideoDuration(3, 16, "seamless", "framepack-i2v"),
    ).toMatchObject({
      sourceFrameCount: 49,
      outputFrameCount: 48,
      durationSeconds: 3,
      exact: true,
    });
    expect(
      fitMediaVideoDuration(2, 16, "seamless", "framepack-i2v"),
    ).toEqual({
      targetSeconds: 2,
      sourceFrameCount: 37,
      outputFrameCount: 36,
      durationSeconds: 2.25,
      exact: false,
    });
    expect(
      fitMediaVideoDuration(3, 16, "none", "hunyuan-video-1.5-i2v"),
    ).toMatchObject({
      sourceFrameCount: 49,
      outputFrameCount: 49,
      durationSeconds: 49 / 16,
      exact: false,
    });
    expect(
      fitMediaVideoDuration(3, 16, "seamless", "hunyuan-video-1.5-i2v"),
    ).toBeNull();
    expect(fitMediaVideoDuration(3, 0, "ping-pong")).toBeNull();
  });

  it("labels latent-aligned video canvases by their requested aspect", () => {
    const hunyuanAsset: MediaAssetRecord = {
      ...videoAsset(false),
      width: 672,
      height: 384,
      operation: {
        ...videoAsset(false).operation,
        kind: "local-video-generation",
        modelId: "local:hunyuan-video-1.5-i2v-step-distilled",
        architecture: "hunyuan-video-1.5-i2v",
        conditioningMode: "hunyuan-video-1.5-native-first-frame",
        resolution: "preview-512",
      } as MediaAssetRecord["operation"],
    };
    expect(formatMediaAssetAspectRatio(hunyuanAsset)).toBe(
      "16:9 model-aligned",
    );
    expect(
      formatMediaAssetAspectRatio({
        ...asset(null),
        width: 1_920,
        height: 1_080,
      }),
    ).toBe("16:9");
    expect(
      formatMediaAssetAspectRatio({
        ...asset(null),
        width: 672,
        height: 384,
      }),
    ).toBe("7:4");
  });

  it("treats only provenance-backed cutouts as known transparent", () => {
    expect(isMediaAssetKnownTransparent(asset(null))).toBe(false);
    expect(
      isMediaAssetKnownTransparent(
        asset({
          kind: "local-image-flow",
          flowRevisionId: "revision:1",
          metadataStripped: true,
          assetRole: "cutout",
          subjectCutout: null,
          alphaExtraction: null,
          autoTagProfile: null,
          composite: null,
          contactSheet: null,
        }),
      ),
    ).toBe(true);
    expect(
      isMediaAssetKnownTransparent(
        asset(null, [
          {
            value: "transparent-cutout",
            label: "Transparent cutout",
            source: "technical",
            confidence: 1,
            createdAt: "2026-07-26T00:00:00.000Z",
          },
        ]),
      ),
    ).toBe(true);
    expect(isMediaAssetKnownTransparent(videoAsset(true))).toBe(true);
    expect(isMediaAssetKnownTransparent(videoAsset(false))).toBe(false);
  });

  it("reads exact frame rates from generated video provenance", () => {
    expect(resolveMediaAssetVideoFrameRate(videoAsset(true, 24))).toBe(24);
    expect(resolveMediaAssetVideoFrameRate(asset(null))).toBeNull();
    expect(resolveMediaAssetVideoFrameRate(videoAsset(false, 0))).toBeNull();
  });

  it("reads loop playback intent from generated video provenance", () => {
    expect(resolveMediaAssetVideoLoopMode(videoAsset(false))).toBe("ping-pong");
    expect(
      resolveMediaAssetVideoLoopMode(videoAsset(false, 16, "seamless")),
    ).toBe("seamless");
    expect(resolveMediaAssetVideoLoopMode(asset(null))).toBeNull();
  });

  it("does not enable alpha extraction for a fully opaque cutout summary", () => {
    expect(
      isMediaAssetKnownTransparent(
        asset({
          kind: "local-image-flow",
          flowRevisionId: "revision:opaque",
          metadataStripped: true,
          assetRole: "primary",
          subjectCutout: {
            engine: "border-matte-v1",
            modelId: "local:border-matte-v1",
            modelRevision: "1",
            attemptedModelIds: ["local:border-matte-v1"],
            fallbackUsed: false,
            transparentPixels: 0,
            softPixels: 0,
            opaquePixels: 225_280,
          },
          alphaExtraction: null,
          autoTagProfile: null,
          composite: null,
          contactSheet: null,
        }),
      ),
    ).toBe(false);
  });

  it("identifies presets and reports assembled delivery duration", () => {
    const qualityConfig = {
      aspectRatio: "16:9",
      resolution: "quality-640",
      numFrames: 33,
      fps: 16,
      loopMode: "ping-pong",
      transparentBackground: true,
      numInferenceSteps: 30,
      guidanceScale: 5,
      matteQuality: "production",
      encodingQuality: "lossless",
      memoryProfile: "auto",
    };
    expect(identifyMediaVideoQualityPreset(qualityConfig)).toBe("quality");
    expect(summarizeMediaVideoDelivery(qualityConfig)).toEqual({
      width: 640,
      height: 352,
      sourceFrameCount: 33,
      outputFrameCount: 64,
      fps: 16,
      durationSeconds: 4,
      transparent: true,
      loopMode: "ping-pong",
      encodingQuality: "lossless",
    });
    expect(
      identifyMediaVideoQualityPreset({
        ...qualityConfig,
        numInferenceSteps: 23,
      }),
    ).toBeNull();
    const framePackConfig = {
      ...qualityConfig,
      guidanceScale: 9,
    };
    expect(
      identifyMediaVideoQualityPreset(framePackConfig, "framepack-i2v"),
    ).toBe("quality");
    expect(
      identifyMediaVideoQualityPreset(
        {
          ...qualityConfig,
          numInferenceSteps: 30,
          guidanceScale: 9,
        },
        "hunyuan-video-1.5-i2v",
      ),
    ).toBe("quality");
    expect(
      summarizeMediaVideoDelivery(
        {
          ...qualityConfig,
          resolution: "quality-768",
          loopMode: "none",
        },
        "ltx-video",
      ),
    ).toMatchObject({ width: 768, height: 448 });
    expect(
      summarizeMediaVideoDelivery({
        ...qualityConfig,
        loopMode: "seamless",
      }),
    ).toMatchObject({
      sourceFrameCount: 33,
      outputFrameCount: 32,
      durationSeconds: 2,
    });
    expect(
      summarizeMediaVideoDelivery(
        {
          ...qualityConfig,
          loopMode: "seamless",
        },
        "hunyuan-video-1.5-i2v",
      ),
    ).toBeNull();
    expect(
      summarizeMediaVideoDelivery({
        ...qualityConfig,
        numFrames: 0,
      }),
    ).toBeNull();
    expect(
      summarizeMediaVideoDelivery({
        ...qualityConfig,
        numFrames: 18,
      }),
    ).toBeNull();
    expect(
      summarizeMediaVideoDelivery(
        {
          ...qualityConfig,
          numFrames: 18,
        },
        "hunyuan-video-1.5-i2v",
      ),
    ).toBeNull();
    expect(
      summarizeMediaVideoDelivery({
        ...qualityConfig,
        fps: 61,
      }),
    ).toBeNull();
    expect(
      summarizeMediaVideoDelivery({
        ...qualityConfig,
        transparentBackground: "yes",
      }),
    ).toBeNull();
  });
});
