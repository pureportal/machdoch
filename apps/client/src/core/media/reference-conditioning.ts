import type {
  MediaImageReferenceRole,
  MediaModelDescriptor,
} from "./contracts.js";

export interface MediaReferenceConditioningCapabilities {
  roles: readonly Exclude<MediaImageReferenceRole, "base" | "pose">[];
  maximumReferenceImages: number;
  adjustableInfluence: boolean;
  promptless: boolean;
}

const NONE: MediaReferenceConditioningCapabilities = {
  roles: [],
  maximumReferenceImages: 0,
  adjustableInfluence: false,
  promptless: false,
};

export const getMediaReferenceConditioningCapabilities = (
  model: MediaModelDescriptor | null,
): MediaReferenceConditioningCapabilities => {
  if (!model) return NONE;
  if (model.providerId !== "local-diffusers") {
    return model.capabilities.includes("image-to-image")
      ? {
          roles: ["subject", "style", "composition", "palette", "detail"],
          maximumReferenceImages: model.capabilities.includes(
            "multi-reference-edit",
          )
            ? 8
            : 1,
          adjustableInfluence: false,
          promptless: false,
        }
      : NONE;
  }
  switch (model.architecture) {
    case "flux-2":
      return {
        roles: ["subject", "style", "composition", "palette", "detail"],
        maximumReferenceImages: 7,
        adjustableInfluence: false,
        promptless: true,
      };
    case "stable-diffusion-1":
    case "stable-diffusion-2":
    case "stable-diffusion-xl":
    case "flux-1":
      return {
        roles: ["composition"],
        maximumReferenceImages: 1,
        adjustableInfluence: false,
        promptless: true,
      };
    default:
      return NONE;
  }
};

export const mediaModelSupportsReferenceRole = (
  model: MediaModelDescriptor | null,
  role: MediaImageReferenceRole,
): boolean => {
  if (!model) return false;
  if (role === "base") return model.capabilities.includes("image-to-image");
  if (role === "pose") return false;
  return getMediaReferenceConditioningCapabilities(model).roles.includes(role);
};

export const mediaModelSupportsPromptlessConditioning = (
  model: MediaModelDescriptor | null,
  hasConditioning: boolean,
): boolean =>
  hasConditioning &&
  getMediaReferenceConditioningCapabilities(model).promptless;
