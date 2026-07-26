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
  Partial<Record<MediaLocalModelArchitecture, readonly MediaModelAddonCapability[]>>
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
  "krea-2": [capability("lora", ["denoiser"], 8, false, true)],
  "wan-2.2-ti2v": [],
};

export const getMediaModelAddonCapabilities = (
  providerId: string,
  architecture: MediaLocalModelArchitecture | null,
): readonly MediaModelAddonCapability[] => {
  if (providerId !== "local-diffusers" || architecture === null) return [];
  return ARCHITECTURE_ADDON_CAPABILITIES[architecture] ?? [];
};

export interface MediaModelAddonCompatibility {
  status: "compatible" | "unverified" | "incompatible";
  reason: string;
}

const normalizeBaseModelIdentity = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/gu, "");

const abbreviateBaseModelIdentity = (value: string): string =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/gu)
    .filter(Boolean)
    .map((part) => (part.length <= 2 ? part : part[0]))
    .join("");

const modelBaseIdentities = (model: MediaModelDescriptor): Set<string> =>
  new Set(
    [model.architecture, model.family]
      .filter((value): value is string => Boolean(value))
      .flatMap((value) => [
        normalizeBaseModelIdentity(value),
        abbreviateBaseModelIdentity(value),
      ])
      .filter(Boolean),
  );

export const matchesMediaModelAddonQuery = (
  addon: MediaModelAddonDescriptor,
  query: string,
): boolean => {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return true;

  const searchableText = [
    addon.id,
    addon.displayName,
    addon.kind,
    addon.architecture,
    addon.architectureConfidence,
    ...addon.targetComponents,
    addon.baseModelHint ?? "",
    ...addon.triggerWords,
    addon.defaultToken ?? "",
    addon.digest,
    addon.relativePath,
    addon.sourceUrl ?? "",
    addon.license.name,
    addon.license.spdxId ?? "",
    addon.license.commercialUse,
  ]
    .join("\n")
    .toLowerCase();

  return terms.every((term) => searchableText.includes(term));
};

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
    const normalizedHint = normalizeBaseModelIdentity(addon.baseModelHint);
    if (modelBaseIdentities(model).has(normalizedHint)) {
      return {
        status: "compatible",
        reason: `Provider, architecture, target components, and publisher base-family hint “${addon.baseModelHint}” match.`,
      };
    }
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
