import type { MediaAssetRecord } from "./contracts.js";
import {
  identifyMediaVideoQualityPreset,
  inferMediaVideoAspectRatio,
  isMediaAssetKnownTransparent,
  resolveMediaVideoDimensions,
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

describe("media video quality helpers", () => {
  it("maps every native quality canvas without stretching", () => {
    expect(resolveMediaVideoDimensions("16:9", "quality-640")).toEqual([
      640,
      352,
    ]);
    expect(resolveMediaVideoDimensions("9:16", "quality-768")).toEqual([
      432,
      768,
    ]);
    expect(resolveMediaVideoDimensions("21:9", "preview-512")).toEqual([
      512,
      224,
    ]);
  });

  it("selects the nearest native aspect for source-aware animation drafts", () => {
    expect(inferMediaVideoAspectRatio(1_024, 1_024)).toBe("1:1");
    expect(inferMediaVideoAspectRatio(1_920, 1_080)).toBe("16:9");
    expect(inferMediaVideoAspectRatio(900, 1_600)).toBe("9:16");
    expect(inferMediaVideoAspectRatio(2_560, 1_080)).toBe("21:9");
    expect(inferMediaVideoAspectRatio(0, 0)).toBe("1:1");
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
      outputFrameCount: 65,
      fps: 16,
      durationSeconds: 4.0625,
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
  });
});
