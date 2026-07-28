import type {
  MediaAssetRecord,
  MediaLocalModelArchitecture,
} from "./contracts.js";

export type MediaVideoAspectRatio = "1:1" | "16:9" | "9:16" | "21:9";
export type MediaVideoResolution =
  | "preview-512"
  | "quality-640"
  | "quality-768";
export type MediaVideoLoopMode = "none" | "ping-pong" | "seamless";
export type MediaVideoQualityPresetId = "draft" | "quality" | "maximum";

export interface MediaVideoFrameContract {
  minimum: number;
  maximum: number;
  stride: number;
}

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
      "Temporally dense 640-class render with 33 source frames, model-native quality sampling, production alpha, and lossless delivery.",
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
      "Slow 768-class, 33-frame model-native refinement for capable systems; use only after motion and framing are approved.",
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

const LTX_VIDEO_768_DIMENSIONS: Readonly<
  Record<MediaVideoAspectRatio, readonly [number, number]>
> = {
  "1:1": [640, 640],
  "16:9": [768, 448],
  "9:16": [448, 768],
  "21:9": [768, 320],
};

const HUNYUAN_VIDEO_15_DIMENSIONS: Readonly<
  Record<MediaVideoResolution, Record<MediaVideoAspectRatio, readonly [number, number]>>
> = {
  "preview-512": {
    "1:1": [512, 512],
    "16:9": [672, 384],
    "9:16": [384, 672],
    "21:9": [768, 336],
  },
  "quality-640": {
    "1:1": [640, 640],
    "16:9": [848, 480],
    "9:16": [480, 848],
    "21:9": [960, 416],
  },
  "quality-768": {
    "1:1": [768, 768],
    "16:9": [1_024, 576],
    "9:16": [576, 1_024],
    "21:9": [1_152, 496],
  },
};

export const resolveMediaVideoDimensions = (
  aspectRatio: MediaVideoAspectRatio,
  resolution: MediaVideoResolution,
  architecture?: MediaLocalModelArchitecture | null,
): readonly [number, number] =>
  architecture === "hunyuan-video-1.5-i2v"
    ? HUNYUAN_VIDEO_15_DIMENSIONS[resolution][aspectRatio]
    : architecture === "ltx-video" && resolution === "quality-768"
      ? LTX_VIDEO_768_DIMENSIONS[aspectRatio]
      : VIDEO_DIMENSIONS[resolution][aspectRatio];

export const resolveMediaVideoFrameContract = (
  architecture?: MediaLocalModelArchitecture | null,
): MediaVideoFrameContract =>
  architecture === "ltx-video"
    ? { minimum: 9, maximum: 257, stride: 8 }
    : {
        minimum: 17,
        maximum:
          architecture === "framepack-i2v"
            ? 129
            : architecture === "hunyuan-video-1.5-i2v"
              ? 121
              : 33,
        stride: 4,
      };

export const isMediaVideoFrameCountValid = (
  numFrames: unknown,
  architecture?: MediaLocalModelArchitecture | null,
): boolean => {
  if (typeof numFrames !== "number" || !Number.isInteger(numFrames)) {
    return false;
  }
  const contract = resolveMediaVideoFrameContract(architecture);
  return (
    numFrames >= contract.minimum &&
    numFrames <= contract.maximum &&
    (numFrames - 1) % contract.stride === 0
  );
};

export interface MediaVideoExecutionSettings {
  numInferenceSteps: number;
  guidanceScale: number;
  modelManaged: boolean;
}

export const resolveMediaVideoExecutionSettings = (
  config: Record<string, unknown>,
  architecture?: MediaLocalModelArchitecture | null,
): MediaVideoExecutionSettings => {
  if (architecture === "ltx-video") {
    return {
      numInferenceSteps: 8,
      guidanceScale: 1,
      modelManaged: true,
    };
  }
  if (architecture === "hunyuan-video-1.5-i2v") {
    return {
      numInferenceSteps:
        typeof config.numInferenceSteps === "number" &&
        config.numInferenceSteps <= 8
          ? 8
          : 12,
      guidanceScale: 1,
      modelManaged: true,
    };
  }
  return {
    numInferenceSteps:
      typeof config.numInferenceSteps === "number"
        ? config.numInferenceSteps
        : 30,
    guidanceScale:
      typeof config.guidanceScale === "number"
        ? config.guidanceScale
        : architecture === "framepack-i2v"
          ? 9
          : 5,
    modelManaged: false,
  };
};

export const resolveMediaVideoQualityPresetSettings = (
  preset: MediaVideoQualityPreset,
  architecture?: MediaLocalModelArchitecture | null,
): MediaVideoQualityPreset["settings"] => {
  const execution = resolveMediaVideoExecutionSettings(
    preset.settings,
    architecture,
  );
  return {
    ...preset.settings,
    numInferenceSteps: execution.numInferenceSteps,
    guidanceScale:
      architecture === "framepack-i2v" ? 9 : execution.guidanceScale,
  };
};

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

const greatestCommonDivisor = (left: number, right: number): number => {
  let currentLeft = Math.abs(left);
  let currentRight = Math.abs(right);
  while (currentRight !== 0) {
    [currentLeft, currentRight] = [currentRight, currentLeft % currentRight];
  }
  return currentLeft;
};

const formatPixelAspectRatio = (width: number, height: number): string => {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return "Unknown";
  }
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
};

export const formatMediaAssetAspectRatio = (
  asset: Pick<MediaAssetRecord, "width" | "height" | "operation">,
): string => {
  const operation = asset.operation;
  if (
    operation?.kind === "local-video-generation" ||
    operation?.kind === "local-wan-video-generation"
  ) {
    const resolution = operation.resolution;
    if (
      resolution === "preview-512" ||
      resolution === "quality-640" ||
      resolution === "quality-768"
    ) {
      const architecture =
        operation.kind === "local-video-generation"
          ? operation.architecture
          : "wan-2.2-ti2v";
      const intended = (
        ["1:1", "16:9", "9:16", "21:9"] as const
      ).find((aspectRatio) => {
        const [width, height] = resolveMediaVideoDimensions(
          aspectRatio,
          resolution,
          architecture,
        );
        return width === asset.width && height === asset.height;
      });
      if (intended) {
        const pixelRatio = formatPixelAspectRatio(asset.width, asset.height);
        return pixelRatio === intended
          ? intended
          : `${intended} model-aligned`;
      }
    }
  }

  const pixelRatio = formatPixelAspectRatio(asset.width, asset.height);
  if (pixelRatio === "Unknown") return pixelRatio;
  const ratio = asset.width / asset.height;
  const commonRatios = [
    ["9:16", 9 / 16],
    ["2:3", 2 / 3],
    ["3:4", 3 / 4],
    ["4:5", 4 / 5],
    ["1:1", 1],
    ["5:4", 5 / 4],
    ["4:3", 4 / 3],
    ["3:2", 3 / 2],
    ["16:10", 16 / 10],
    ["16:9", 16 / 9],
    ["21:9", 21 / 9],
  ] as const;
  const closest = commonRatios.reduce((best, candidate) =>
    Math.abs(candidate[1] - ratio) < Math.abs(best[1] - ratio)
      ? candidate
      : best,
  );
  return Math.abs(closest[1] - ratio) / closest[1] <= 0.01
    ? closest[0]
    : pixelRatio;
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
    case "local-video-generation":
    case "local-wan-video-generation":
      return operation.output.hasAlpha;
    default:
      return false;
  }
};

export const resolveMediaAssetVideoFrameRate = (
  asset: MediaAssetRecord,
): number | null => {
  if (
    asset.kind !== "video" ||
    (asset.operation?.kind !== "local-video-generation" &&
      asset.operation?.kind !== "local-wan-video-generation")
  ) {
    return null;
  }
  return asset.operation.output.fps;
};

export const identifyMediaVideoQualityPreset = (
  config: Record<string, unknown>,
  architecture?: MediaLocalModelArchitecture | null,
): MediaVideoQualityPresetId | null => {
  const execution = resolveMediaVideoExecutionSettings(config, architecture);
  const effectiveConfig: Record<string, unknown> = {
    ...config,
    numInferenceSteps: execution.numInferenceSteps,
    guidanceScale: execution.guidanceScale,
  };
  return (
    MEDIA_VIDEO_QUALITY_PRESETS.find((preset) =>
      Object.entries(
        resolveMediaVideoQualityPresetSettings(preset, architecture),
      ).every(([fieldId, value]) => effectiveConfig[fieldId] === value),
    )?.id ?? null
  );
};

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
  architecture?: MediaLocalModelArchitecture | null,
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
    architecture,
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
