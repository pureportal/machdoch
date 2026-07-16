import type {
  MediaLocalModelArchitecture,
  MediaModelAddonCapability,
  MediaModelAddonDescriptor,
  MediaModelAddonKind,
  MediaModelDescriptor,
} from "./contracts.js";

const capability = (
  kind: MediaModelAddonKind,
  targetComponents: MediaModelAddonCapability["targetComponents"],
  maxActive: number,
  supportsSeparateComponentStrengths: boolean,
  supportsDenoisingSchedules: boolean,
): MediaModelAddonCapability => ({
  kind,
  targetComponents,
  maxActive,
  supportsSeparateComponentStrengths,
  supportsDenoisingSchedules,
});

const ARCHITECTURE_ADDON_CAPABILITIES: Readonly<
  Record<MediaLocalModelArchitecture, readonly MediaModelAddonCapability[]>
> = {
  "stable-diffusion-1": [
    capability("lora", ["denoiser", "text-encoder"], 8, true, true),
    capability("textual-inversion", ["text-encoder"], 16, false, false),
  ],
  "stable-diffusion-2": [
    capability("lora", ["denoiser", "text-encoder"], 8, true, true),
    capability("textual-inversion", ["text-encoder"], 16, false, false),
  ],
  "stable-diffusion-xl": [
    capability("lora", ["denoiser", "text-encoder", "text-encoder-2"], 8, true, true),
    capability("textual-inversion", ["text-encoder", "text-encoder-2"], 16, false, false),
  ],
  "stable-diffusion-3": [capability("lora", ["denoiser"], 8, false, true)],
  "flux-1": [
    capability("lora", ["denoiser", "text-encoder"], 8, true, true),
    capability("textual-inversion", ["text-encoder", "text-encoder-2"], 16, false, false),
  ],
  "flux-2": [capability("lora", ["denoiser"], 8, false, true)],
};

export const getMediaModelAddonCapabilities = (
  providerId: string,
  architecture: MediaLocalModelArchitecture | null,
): readonly MediaModelAddonCapability[] => {
  if (providerId !== "local-diffusers" || architecture === null) return [];
  return ARCHITECTURE_ADDON_CAPABILITIES[architecture];
};

export interface MediaModelAddonCompatibility {
  status: "compatible" | "unverified" | "incompatible";
  reason: string;
}

export const inspectMediaModelAddonCompatibility = (
  model: MediaModelDescriptor,
  addon: MediaModelAddonDescriptor,
): MediaModelAddonCompatibility => {
  const capabilityEntry = model.addonCapabilities.find(
    (candidate) => candidate.kind === addon.kind,
  );
  if (!capabilityEntry) {
    return {
      status: "incompatible",
      reason: `${model.displayName} does not expose ${addon.kind} loading.`,
    };
  }
  if (model.architecture !== addon.architecture) {
    return {
      status: "incompatible",
      reason: `${addon.displayName} targets ${addon.architecture}, but ${model.displayName} uses ${model.architecture ?? "an unknown architecture"}.`,
    };
  }
  if (
    addon.targetComponents.some(
      (component) => !capabilityEntry.targetComponents.includes(component),
    )
  ) {
    return {
      status: "incompatible",
      reason: `${addon.displayName} targets components that ${model.displayName} does not expose.`,
    };
  }
  if (addon.baseModelHint) {
    return {
      status: "unverified",
      reason: `Architecture matches; publisher base-model hint “${addon.baseModelHint}” still needs runtime validation.`,
    };
  }
  return {
    status: "compatible",
    reason: "Provider, architecture, and target components match.",
  };
};
