import type { MediaAssetRecord } from "./contracts.js";

export type MediaVideoAspectRatio = "1:1" | "16:9" | "9:16" | "21:9";
export type MediaVideoResolution =
  | "preview-512"
  | "quality-640"
  | "quality-768";
export type MediaVideoLoopMode = "none" | "ping-pong" | "seamless";
export type MediaVideoQualityPresetId = "draft" | "quality" | "maximum";

export interface MediaVideoQualityPreset {
  id: MediaVideoQualityPresetId;
  label: string;
  description: string;
  settings: Readonly<{
    resolution: MediaVideoResolution;
    numFrames: number;
    fps: number;
    numInferenceSteps: number;
    guidanceScale: number;
    matteQuality: "fast" | "balanced" | "production";
    encodingQuality: "draft" | "balanced" | "production" | "lossless";
    memoryProfile: "auto" | "memory-saver" | "balanced" | "maximum-speed";
  }>;
}

export const MEDIA_VIDEO_QUALITY_PRESETS: readonly MediaVideoQualityPreset[] = [
  {
    id: "draft",
    label: "Draft",
    description:
      "Validate framing and motion quickly at 512-class resolution before an expensive render.",
    settings: {
      resolution: "preview-512",
      numFrames: 17,
      fps: 8,
      numInferenceSteps: 8,
      guidanceScale: 5,
      matteQuality: "balanced",
      encodingQuality: "balanced",
      memoryProfile: "auto",
    },
  },
  {
    id: "quality",
    label: "Quality",
    description:
      "Temporally dense 640-class render with 33 source frames, 30-step sampling, production alpha, and lossless delivery.",
    settings: {
      resolution: "quality-640",
      numFrames: 33,
      fps: 16,
      numInferenceSteps: 30,
      guidanceScale: 5,
      matteQuality: "production",
      encodingQuality: "lossless",
      memoryProfile: "auto",
    },
  },
  {
    id: "maximum",
    label: "Maximum",
    description:
      "Slow 768-class, 33-frame refinement for capable systems; use only after motion and framing are approved.",
    settings: {
      resolution: "quality-768",
      numFrames: 33,
      fps: 16,
      numInferenceSteps: 30,
      guidanceScale: 5,
      matteQuality: "production",
      encodingQuality: "lossless",
      memoryProfile: "auto",
    },
  },
] as const;

const VIDEO_DIMENSIONS: Readonly<
  Record<MediaVideoResolution, Record<MediaVideoAspectRatio, readonly [number, number]>>
> = {
  "preview-512": {
    "1:1": [512, 512],
    "16:9": [512, 288],
    "9:16": [288, 512],
    "21:9": [512, 224],
  },
  "quality-640": {
    "1:1": [576, 576],
    "16:9": [640, 352],
    "9:16": [352, 640],
    "21:9": [640, 288],
  },
  "quality-768": {
    "1:1": [640, 640],
    "16:9": [768, 432],
    "9:16": [432, 768],
    "21:9": [768, 336],
  },
};

export const resolveMediaVideoDimensions = (
  aspectRatio: MediaVideoAspectRatio,
  resolution: MediaVideoResolution,
): readonly [number, number] => VIDEO_DIMENSIONS[resolution][aspectRatio];

export const inferMediaVideoAspectRatio = (
  width: number,
  height: number,
): MediaVideoAspectRatio => {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return "1:1";
  }
  const ratio = width / height;
  const candidates: ReadonlyArray<readonly [MediaVideoAspectRatio, number]> = [
    ["1:1", 1],
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["21:9", 21 / 9],
  ];
  return candidates.reduce((best, candidate) =>
    Math.abs(Math.log(ratio / candidate[1])) <
    Math.abs(Math.log(ratio / best[1]))
      ? candidate
      : best,
  )[0];
};

export const isMediaAssetKnownTransparent = (
  asset: MediaAssetRecord,
): boolean => {
  if (
    asset.tags.some((tag) =>
      ["transparent-cutout", "transparent-image"].includes(tag.value),
    )
  ) {
    return true;
  }
  const operation = asset.operation;
  if (!operation) return false;
  const hasExtractedTransparency = (
    subjectCutout:
      | {
          transparentPixels: number;
          softPixels?: number;
        }
      | null
      | undefined,
  ): boolean =>
    Boolean(
      subjectCutout &&
        (subjectCutout.transparentPixels > 0 ||
          (subjectCutout.softPixels ?? 0) > 0),
    );
  switch (operation.kind) {
    case "local-image-flow":
      return (
        operation.assetRole === "cutout" ||
        hasExtractedTransparency(operation.subjectCutout)
      );
    case "local-diffusion-generation":
    case "remote-image-generation":
    case "remote-image-edit":
      return hasExtractedTransparency(operation.subjectCutout);
    default:
      return false;
  }
};

export const identifyMediaVideoQualityPreset = (
  config: Record<string, unknown>,
): MediaVideoQualityPresetId | null =>
  MEDIA_VIDEO_QUALITY_PRESETS.find((preset) =>
    Object.entries(preset.settings).every(
      ([fieldId, value]) => config[fieldId] === value,
    ),
  )?.id ?? null;

export interface MediaVideoDeliverySummary {
  width: number;
  height: number;
  sourceFrameCount: number;
  outputFrameCount: number;
  fps: number;
  durationSeconds: number;
  transparent: boolean;
  loopMode: MediaVideoLoopMode;
  encodingQuality: "draft" | "balanced" | "production" | "lossless";
}

export const summarizeMediaVideoDelivery = (
  config: Record<string, unknown>,
): MediaVideoDeliverySummary | null => {
  const aspectRatio = config.aspectRatio;
  const resolution = config.resolution;
  const loopMode = config.loopMode;
  const sourceFrameCount = config.numFrames;
  const fps = config.fps;
  const encodingQuality = config.encodingQuality;
  if (
    !["1:1", "16:9", "9:16", "21:9"].includes(String(aspectRatio)) ||
    !["preview-512", "quality-640", "quality-768"].includes(
      String(resolution),
    ) ||
    !["none", "ping-pong", "seamless"].includes(String(loopMode)) ||
    typeof sourceFrameCount !== "number" ||
    !Number.isInteger(sourceFrameCount) ||
    typeof fps !== "number" ||
    !Number.isInteger(fps) ||
    fps <= 0 ||
    !["draft", "balanced", "production", "lossless"].includes(
      String(encodingQuality),
    )
  ) {
    return null;
  }
  const [width, height] = resolveMediaVideoDimensions(
    aspectRatio as MediaVideoAspectRatio,
    resolution as MediaVideoResolution,
  );
  const outputFrameCount =
    loopMode === "ping-pong"
      ? sourceFrameCount * 2 - 1
      : sourceFrameCount;
  return {
    width,
    height,
    sourceFrameCount,
    outputFrameCount,
    fps,
    durationSeconds: outputFrameCount / fps,
    transparent: config.transparentBackground === true,
    loopMode: loopMode as MediaVideoLoopMode,
    encodingQuality: encodingQuality as MediaVideoDeliverySummary["encodingQuality"],
  };
};
