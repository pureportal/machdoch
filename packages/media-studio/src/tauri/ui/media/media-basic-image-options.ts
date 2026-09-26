import type {
  ImageRecipeSettings,
  MediaGenerationTarget,
  MediaModelDescriptor,
} from "../../../core/media/contracts.js";

import {
  getMediaReferenceConditioningCapabilities,
  mediaModelSupportsReferenceRole,
} from "../../../core/media/reference-conditioning.js";
import { defaultMediaImageSteps } from "../../../core/media/image-sampling.js";

export const basicPosePresetSelectionStillCurrent = (
  selected: ImageRecipeSettings,
  current: ImageRecipeSettings,
  target: MediaGenerationTarget,
): boolean =>
  target === "image" &&
  current.modelId === selected.modelId &&
  current.aspectRatio === selected.aspectRatio &&
  current.poseImageAssetId === selected.poseImageAssetId;

export const reconcileBasicImageModelSettings = (
  settings: ImageRecipeSettings,
  model: MediaModelDescriptor,
): { settings: ImageRecipeSettings; changes: string[] } => {
  const next = { ...settings, modelId: model.id };
  const changes: string[] = [];
  if (model.target === "remote") {
    if (Object.values(settings.sampling ?? {}).some((value) => value != null)) {
      next.sampling = {};
      changes.push("Custom sampling reset to model defaults.");
    }
    if (settings.seed != null) {
      next.seed = null;
      changes.push("Seed reset to random.");
    }
  } else {
    const sampling = { ...settings.sampling };
    if (
      model.architecture === "flux-2" &&
      sampling.numInferenceSteps != null &&
      sampling.numInferenceSteps !== 4
    ) {
      sampling.numInferenceSteps = null;
      changes.push("Sampling steps set to 4.");
    }
    if (
      (model.architecture === "flux-2" ||
        model.architecture === "krea-2" ||
        model.architecture === "qwen-image-2.1") &&
      sampling.guidanceScale != null
    ) {
      sampling.guidanceScale = null;
      changes.push("Guidance reset to model default.");
    }
    if (changes.length > 0) next.sampling = sampling;
  }
  if (
    (model.target === "remote" || model.architecture !== "krea-2") &&
    (settings.memoryProfile ?? "auto") !== "auto"
  ) {
    next.memoryProfile = "auto";
    changes.push("Memory set to Automatic.");
  }
  return { settings: next, changes };
};

export const basicImageReferenceLimit = (
  settings: ImageRecipeSettings,
  model: MediaModelDescriptor | null,
): number => {
  const maximum =
    getMediaReferenceConditioningCapabilities(model).maximumReferenceImages;
  const sourceLimit = model?.capabilities.includes("multi-reference-edit")
    ? 8
    : 1;
  return Math.min(
    maximum,
    Math.max(
      0,
      sourceLimit -
        Number(Boolean(settings.baseImageAssetId)) -
        Number(Boolean(settings.poseImageAssetId)),
    ),
  );
};

export const basicImageModelError = (
  settings: ImageRecipeSettings,
  model: MediaModelDescriptor,
): string | null => {
  if (settings.editMask && (settings.maskStrength ?? 1) <= 0)
    return "Increase the mask strength.";
  if (settings.editMask && settings.transparentBackground)
    return "Choose Full image to remove the background.";
  if (model.target === "local" && basicImageUsesEditStrength(settings, model)) {
    const steps =
      settings.sampling?.numInferenceSteps ??
      defaultMediaImageSteps(model.architecture, settings.modelPolicy);
    if (Math.floor(steps * (settings.editStrength ?? 0.65)) < 1)
      return "Increase edit strength or sampling steps.";
  }
  if (
    settings.baseImageAssetId &&
    !model.capabilities.includes("image-to-image")
  )
    return "Remove the base image to use this model.";
  if (settings.editMask && !model.capabilities.includes("masked-image-edit"))
    return "Remove the mask to use this model.";
  if (settings.poseImageAssetId && !model.capabilities.includes("pose-control"))
    return ["stable-diffusion-1", "stable-diffusion-2", "stable-diffusion-xl", "pony"].includes(model.architecture ?? "")
      ? "Install the matching OpenPose ControlNet for this model."
      : "Choose a local Stable Diffusion model with OpenPose ControlNet.";
  if (
    settings.referenceImages.some(
      (reference) => !mediaModelSupportsReferenceRole(model, reference.role),
    )
  )
    return "Change or remove the reference images to use this model.";
  if (
    settings.referenceImages.length > basicImageReferenceLimit(settings, model)
  )
    return "Remove a reference image to use this model.";
  if (model.target === "remote") {
    if (settings.seed != null) return "Clear the seed to use this model.";
    if (Object.values(settings.sampling ?? {}).some((value) => value != null))
      return "Reset custom sampling to use this model.";
    if (settings.memoryProfile && settings.memoryProfile !== "auto")
      return "Set memory to Automatic to use this model.";
  }
  if (
    model.target === "local" &&
    model.architecture !== "krea-2" &&
    (settings.memoryProfile ?? "auto") !== "auto"
  )
    return "Set memory to Automatic to use this model.";
  if (
    model.architecture === "flux-2" &&
    settings.sampling?.numInferenceSteps != null &&
    settings.sampling.numInferenceSteps !== 4
  )
    return "This model uses 4 sampling steps.";
  if (
    (model.architecture === "flux-2" ||
      model.architecture === "krea-2" ||
      model.architecture === "qwen-image-2.1") &&
    settings.sampling?.guidanceScale != null
  )
    return "Clear manual guidance to use this model.";
  return null;
};

export const basicImageUsesEditStrength = (
  settings: ImageRecipeSettings,
  model: MediaModelDescriptor,
): boolean =>
  Boolean(settings.editMask) ||
  (model.architecture !== "flux-2" &&
    model.architecture !== "qwen-image-2.1" &&
    Boolean(settings.baseImageAssetId)) ||
  ((model.architecture === "stable-diffusion-2" ||
    model.architecture === "flux-1") &&
    settings.referenceImages.length > 0);
