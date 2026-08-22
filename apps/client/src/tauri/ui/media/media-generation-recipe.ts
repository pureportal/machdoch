import { readImageRecipeSettings } from "../../../core/media/compiler.js";
import type {
  ImageRecipeSettings,
  MediaFlow,
  MediaFlowLayout,
  MediaGenerationTarget,
  MediaImageOutputBranch,
  MediaVideoRecipeSettings,
} from "../../../core/media/contracts.js";
import {
  DEFAULT_IMAGE_RECIPE_SETTINGS,
  DEFAULT_VIDEO_RECIPE_SETTINGS,
} from "./media-studio-store";

const MAX_PROMPT_LENGTH = 8_000;

export const normalizeMediaSubmissionText = (
  value: string,
  maximumLength = MAX_PROMPT_LENGTH,
): string => value.replaceAll(/\r\n?/gu, "\n").trim().slice(0, maximumLength);

export const normalizeMediaFlowForPersistence = (
  flow: MediaFlow,
): MediaFlow => ({
  ...flow,
  description: normalizeMediaSubmissionText(flow.description, 2_000),
  variables: flow.variables.map((variable) => ({
    ...variable,
    description: normalizeMediaSubmissionText(variable.description, 500),
  })),
  presets: flow.presets.map((preset) => ({
    ...preset,
    description: normalizeMediaSubmissionText(preset.description, 500),
  })),
  nodes: flow.nodes.map((node) => {
    const config = { ...node.config };
    for (const [key, maximumLength] of [
      ["prompt", 8_000],
      ["negativePrompt", 8_000],
      ["instructions", 1_000],
    ] as const) {
      if (typeof config[key] === "string") {
        config[key] = normalizeMediaSubmissionText(
          config[key] as string,
          maximumLength,
        );
      }
    }
    return { ...node, config };
  }),
});

export const normalizeMediaFlowLayoutForPersistence = (
  layout: MediaFlowLayout,
): MediaFlowLayout => ({
  ...layout,
  comments: layout.comments.map((comment) => ({
    ...comment,
    body: normalizeMediaSubmissionText(comment.body, 1_000),
  })),
});

export const countMediaImageRecipeOutputs = (
  settings: ImageRecipeSettings,
  outputBranches: readonly MediaImageOutputBranch[],
): number => settings.outputCount * Math.max(1, outputBranches.length);

export const formatMediaImageRecipeOutput = (
  settings: ImageRecipeSettings,
  outputBranches: readonly MediaImageOutputBranch[],
): string => {
  if (
    outputBranches.length <= 1 &&
    !outputBranches.some(
      (branch) =>
        branch.operations.length > 0 || branch.format !== settings.outputFormat,
    )
  ) {
    return `${settings.aspectRatio} · ${settings.outputCount} × ${settings.outputFormat.toUpperCase()}`;
  }

  const formats = outputBranches
    .map((branch) => branch.format.toUpperCase())
    .join(" + ");
  return `${settings.aspectRatio} · ${countMediaImageRecipeOutputs(settings, outputBranches)} outputs · ${formats}`;
};

export const readMediaGenerationTarget = (
  flow: MediaFlow,
): MediaGenerationTarget => {
  if (flow.nodes.some((node) => node.type === "task.generate-video")) {
    return "video";
  }
  const imageSettings = readImageRecipeSettings(flow);
  return imageSettings?.outputFormat === "svg" ? "svg" : "image";
};

export const readMediaVideoRecipeSettings = (
  flow: MediaFlow,
): MediaVideoRecipeSettings | null => {
  const node = flow.nodes.find(
    (candidate) => candidate.type === "task.generate-video",
  );
  if (!node) return null;
  const config = node.config;
  return {
    modelId:
      typeof config.modelId === "string"
        ? (config.modelId as MediaVideoRecipeSettings["modelId"])
        : null,
    aspectRatio:
      config.aspectRatio === "1:1" ||
      config.aspectRatio === "16:9" ||
      config.aspectRatio === "9:16" ||
      config.aspectRatio === "21:9"
        ? config.aspectRatio
        : DEFAULT_VIDEO_RECIPE_SETTINGS.aspectRatio,
    resolution:
      config.resolution === "preview-512" ||
      config.resolution === "quality-640" ||
      config.resolution === "quality-768"
        ? config.resolution
        : DEFAULT_VIDEO_RECIPE_SETTINGS.resolution,
    transparentBackground: config.transparentBackground === true,
    loopMode:
      config.loopMode === "ping-pong" || config.loopMode === "seamless"
        ? config.loopMode
        : "none",
    fps:
      typeof config.fps === "number"
        ? config.fps
        : DEFAULT_VIDEO_RECIPE_SETTINGS.fps,
    numFrames:
      typeof config.numFrames === "number"
        ? config.numFrames
        : DEFAULT_VIDEO_RECIPE_SETTINGS.numFrames,
    memoryProfile:
      config.memoryProfile === "memory-saver" ||
      config.memoryProfile === "balanced" ||
      config.memoryProfile === "maximum-speed"
        ? config.memoryProfile
        : "auto",
  };
};

export const readMediaFlowPrompt = (flow: MediaFlow): string => {
  const prompt = flow.nodes.find((node) => node.type === "source.prompt")
    ?.config.prompt;
  return typeof prompt === "string" ? prompt : "";
};

export const readMediaFlowImageSettings = (
  flow: MediaFlow,
): ImageRecipeSettings | null => {
  const imageSettings = readImageRecipeSettings(flow);
  if (imageSettings) return imageSettings;
  if (readMediaGenerationTarget(flow) !== "video") return null;
  const references = flow.nodes
    .filter((node) => node.type === "source.image")
    .flatMap((node, index) => {
      const assetId = node.config.assetId;
      if (typeof assetId !== "string") return [];
      return [
        {
          assetId,
          role: index === 0 ? ("base" as const) : ("subject" as const),
          influence: 1,
        },
      ];
    });
  return {
    ...DEFAULT_IMAGE_RECIPE_SETTINGS,
    prompt: readMediaFlowPrompt(flow),
    referenceImages: references,
  };
};
