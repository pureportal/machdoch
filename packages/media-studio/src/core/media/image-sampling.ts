import type {
  MediaLocalModelArchitecture,
  MediaModelPolicy,
} from "./contracts.js";
import { openMediaModelProfile } from "./open-model-profiles.js";

export interface MediaImageSamplingSettings {
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
    manualGuidance:
      !profile?.fixedGuidance &&
      !["flux-2", "krea-2", "qwen-image-2.1"].includes(architecture ?? ""),
  };
};

export const readMediaImageSampling = (
  config: Record<string, unknown>,
): MediaImageSamplingSettings => ({
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
      ? 8
      : architecture === "qwen-image-2.1"
        ? { fast: 20, balanced: 30, quality: 40 }[policy]
        : { fast: 16, balanced: 24, quality: 32 }[policy]);
