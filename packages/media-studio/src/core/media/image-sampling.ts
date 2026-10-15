import type {
  MediaLocalModelArchitecture,
  MediaModelPolicy,
} from "./contracts.js";
import { openMediaModelProfile } from "./open-model-profiles.js";
import profiles from "../../../../../apps/client/src-tauri/python/image_sampling_profiles.json" with { type: "json" };

export const MEDIA_IMAGE_SAMPLERS = [
  { value: "euler", label: "Euler" },
  { value: "euler-ancestral", label: "Euler ancestral" },
  { value: "heun", label: "Heun" },
  { value: "dpmpp-2m", label: "DPM++ 2M" },
  { value: "dpmpp-2m-karras", label: "DPM++ 2M Karras" },
  { value: "dpmpp-2m-sde-karras", label: "DPM++ 2M SDE Karras" },
  { value: "ddim", label: "DDIM" },
  { value: "deis", label: "DEIS" },
  { value: "unipc", label: "UniPC" },
  { value: "flow-euler", label: "Flow Euler" },
  { value: "flow-heun", label: "Flow Heun" },
  { value: "lcm", label: "LCM" },
  { value: "scm", label: "SCM" },
  { value: "hunyuan-euler", label: "Hunyuan Euler" },
] as const;

export type MediaImageSampler = (typeof MEDIA_IMAGE_SAMPLERS)[number]["value"];

export interface MediaImageSamplingProfile {
  architecture: string;
  steps: readonly [number, number];
  guidance: readonly [number, number];
  defaultGuidance: number;
  samplers: readonly MediaImageSampler[];
  recommendedSamplers: readonly MediaImageSampler[];
  sources: readonly string[];
}

export const MEDIA_IMAGE_SAMPLING_PROFILES: readonly MediaImageSamplingProfile[] =
  profiles as unknown as readonly MediaImageSamplingProfile[];

export const mediaImageSamplingProfile = (
  architecture: MediaLocalModelArchitecture | null | undefined,
): MediaImageSamplingProfile | undefined =>
  MEDIA_IMAGE_SAMPLING_PROFILES.find(
    (profile) => profile.architecture === architecture,
  );

export const compatibleMediaImageSamplers = (
  architecture: MediaLocalModelArchitecture | null | undefined,
) =>
  MEDIA_IMAGE_SAMPLERS.filter((sampler) =>
    mediaImageSamplingProfile(architecture)?.samplers.includes(sampler.value),
  ).map((sampler) => ({
    ...sampler,
    recommended: mediaImageSamplingProfile(
      architecture,
    )!.recommendedSamplers.includes(sampler.value),
  }));

export interface MediaImageSamplingSettings {
  sampler?: MediaImageSampler | null;
  width?: number | null;
  height?: number | null;
  numInferenceSteps?: number | null;
  guidanceScale?: number | null;
}

export const mediaImageSamplingConstraints = (
  architecture: MediaLocalModelArchitecture | null | undefined,
): { fixedSteps: number | null; manualGuidance: boolean } => {
  const profile = openMediaModelProfile(architecture);
  return {
    fixedSteps: profile?.fixedSteps
      ? profile.steps
      : architecture === "flux-2"
        ? 4
        : null,
    manualGuidance: !profile?.fixedGuidance && architecture !== "flux-2",
  };
};

export const readMediaImageSampling = (
  config: Record<string, unknown>,
): MediaImageSamplingSettings => ({
  sampler:
    typeof config.sampler === "string"
      ? (config.sampler as MediaImageSampler)
      : null,
  width: typeof config.width === "number" ? config.width : null,
  height: typeof config.height === "number" ? config.height : null,
  numInferenceSteps:
    typeof config.numInferenceSteps === "number"
      ? config.numInferenceSteps
      : null,
  guidanceScale:
    typeof config.guidanceScale === "number" ? config.guidanceScale : null,
});

export const mediaImageSamplingError = (
  settings: MediaImageSamplingSettings,
  architecture?: MediaLocalModelArchitecture | null,
): string | null => {
  if (
    architecture != null &&
    settings.sampler != null &&
    !compatibleMediaImageSamplers(architecture).some(
      (sampler) => sampler.value === settings.sampler,
    )
  )
    return "Choose a compatible sampler for this model.";
  if ((settings.width != null) !== (settings.height != null))
    return "Enter both width and height.";
  if (
    [settings.width, settings.height].some(
      (value) =>
        value != null &&
        (!Number.isInteger(value) ||
          value < 256 ||
          value > 2048 ||
          value % 32 !== 0),
    )
  )
    return "Width and height must be multiples of 32 between 256 and 2048.";
  if (
    settings.numInferenceSteps != null &&
    (!Number.isInteger(settings.numInferenceSteps) ||
      settings.numInferenceSteps < 1 ||
      settings.numInferenceSteps > 100)
  )
    return "Sampling steps must be between 1 and 100.";
  if (
    settings.guidanceScale != null &&
    (!Number.isFinite(settings.guidanceScale) ||
      settings.guidanceScale < 0 ||
      settings.guidanceScale > 20)
  )
    return "Guidance must be between 0 and 20.";
  const profile = openMediaModelProfile(architecture);
  if (
    architecture === "qwen-image-2.1" &&
    settings.guidanceScale != null &&
    settings.guidanceScale < 1
  )
    return "Qwen-Image 2.1 guidance must be at least 1.";
  if (
    profile?.fixedSteps &&
    settings.numInferenceSteps != null &&
    settings.numInferenceSteps !== profile.steps
  )
    return `${profile.displayName} requires ${profile.steps} sampling steps.`;
  if (
    profile?.fixedGuidance &&
    settings.guidanceScale != null &&
    settings.guidanceScale !== profile.guidance
  )
    return `${profile.displayName} requires guidance ${profile.guidance}.`;
  return null;
};

export const defaultMediaImageSteps = (
  architecture: MediaLocalModelArchitecture | null | undefined,
  policy: MediaModelPolicy,
): number =>
  openMediaModelProfile(architecture)?.steps ??
  (architecture === "flux-2"
    ? 4
    : architecture === "krea-2"
      ? policy === "fast"
        ? 8
        : 12
      : architecture === "qwen-image-2.1"
        ? { fast: 20, balanced: 30, quality: 40 }[policy]
        : { fast: 16, balanced: 24, quality: 32 }[policy]);
