import type {
  MediaLocalModelArchitecture,
  MediaModelAddonCapability,
  MediaModelAddonDescriptor,
  MediaModelAddonKind,
  MediaModelAddonSelection,
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
  Partial<
    Record<MediaLocalModelArchitecture, readonly MediaModelAddonCapability[]>
  >
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
    capability(
      "lora",
      ["denoiser", "text-encoder", "text-encoder-2"],
      8,
      true,
      true,
    ),
    capability(
      "textual-inversion",
      ["text-encoder", "text-encoder-2"],
      16,
      false,
      false,
    ),
  ],
  "stable-diffusion-3": [capability("lora", ["denoiser"], 8, false, true)],
  "flux-1": [
    capability("lora", ["denoiser", "text-encoder"], 8, true, true),
    capability(
      "textual-inversion",
      ["text-encoder", "text-encoder-2"],
      16,
      false,
      false,
    ),
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

export const createMediaModelAddonSelection = (
  addon: MediaModelAddonDescriptor,
): MediaModelAddonSelection =>
  addon.kind === "lora"
    ? {
        kind: "lora",
        addonId: addon.id,
        enabled: true,
        modelStrength: 1,
        textEncoderStrength: null,
        denoisingSchedule: null,
      }
    : {
        kind: "textual-inversion",
        addonId: addon.id,
        enabled: true,
        token: addon.defaultToken ?? addon.triggerWords[0] ?? addon.displayName,
        placement: "positive",
      };

export const getMediaModelAddonTriggerWords = (
  addon: MediaModelAddonDescriptor,
): readonly string[] =>
  addon.triggerWords.length > 0
    ? addon.triggerWords
    : addon.defaultToken
      ? [addon.defaultToken]
      : [];

const normalizePromptText = (value: string): string =>
  value.toLocaleLowerCase().replace(/\s+/gu, " ").trim();

export const promptContainsMediaModelAddonTrigger = (
  prompt: string,
  addon: MediaModelAddonDescriptor,
): boolean => {
  const triggers = getMediaModelAddonTriggerWords(addon);
  if (triggers.length === 0) return true;
  const normalizedPrompt = normalizePromptText(prompt);
  return triggers.some((trigger) =>
    normalizedPrompt.includes(normalizePromptText(trigger)),
  );
};

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
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
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
  if (addon.architectureConfidence !== "high") {
    return {
      status: "incompatible",
      reason: `${addon.displayName} does not have a tensor-verified model architecture.`,
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
  if (addon.kind === "lora" && addon.loraProfile === null) {
    return {
      status: "incompatible",
      reason: `${addon.displayName} does not have a loadable LoRA tensor profile.`,
    };
  }
  if (
    addon.kind === "lora" &&
    addon.loraProfile !== null &&
    ["stable-diffusion-3", "flux-2", "krea-2"].includes(
      model.architecture ?? "",
    ) &&
    addon.loraProfile.convolutionTargetCount > 0
  ) {
    return {
      status: "incompatible",
      reason: `${addon.displayName} contains convolutional LoCon weights that this transformer pipeline cannot load.`,
    };
  }
  if (
    addon.kind === "textual-inversion" &&
    addon.embeddingVectors.length === 0
  ) {
    return {
      status: "incompatible",
      reason: `${addon.displayName} does not have a loadable embedding tensor profile.`,
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
      status: "compatible",
      reason: `Tensor-inspected architecture and target components match despite publisher hint “${addon.baseModelHint}”.`,
    };
  }
  return {
    status: "compatible",
    reason: "Provider, architecture, and target components match.",
  };
};

export const isMediaModelAddonSelectable = (
  model: MediaModelDescriptor,
  addon: MediaModelAddonDescriptor,
): boolean =>
  inspectMediaModelAddonCompatibility(model, addon).status === "compatible";

export const reconcileMediaModelAddonSelections = (
  model: MediaModelDescriptor | null,
  addons: readonly MediaModelAddonDescriptor[],
  selections: readonly MediaModelAddonSelection[],
): MediaModelAddonSelection[] => {
  if (!model) return [...selections];

  const addonsById = new Map(addons.map((addon) => [addon.id, addon]));
  const selectedIds = new Set<string>();
  const activeByKind = new Map<MediaModelAddonKind, number>();
  const reconciled: MediaModelAddonSelection[] = [];

  for (const selection of selections) {
    if (selectedIds.has(selection.addonId)) continue;

    const addon = addonsById.get(selection.addonId);
    if (
      !addon ||
      addon.kind !== selection.kind ||
      !isMediaModelAddonSelectable(model, addon)
    ) {
      continue;
    }

    const capability = model.addonCapabilities.find(
      (candidate) => candidate.kind === selection.kind,
    );
    if (!capability) continue;

    const activeCount = activeByKind.get(selection.kind) ?? 0;
    if (selection.enabled && activeCount >= capability.maxActive) continue;

    selectedIds.add(selection.addonId);
    if (selection.enabled) {
      activeByKind.set(selection.kind, activeCount + 1);
    }
    reconciled.push(selection);
  }

  return reconciled;
};

export const mediaModelAddonSelectionsEqual = (
  left: readonly MediaModelAddonSelection[],
  right: readonly MediaModelAddonSelection[],
): boolean =>
  left.length === right.length &&
  left.every((selection, index) => {
    const candidate = right[index];
    if (!candidate || selection.kind !== candidate.kind) return false;
    if (
      selection.addonId !== candidate.addonId ||
      selection.enabled !== candidate.enabled
    ) {
      return false;
    }
    if (selection.kind === "textual-inversion") {
      return (
        candidate.kind === "textual-inversion" &&
        selection.token === candidate.token &&
        selection.placement === candidate.placement
      );
    }
    return (
      candidate.kind === "lora" &&
      selection.modelStrength === candidate.modelStrength &&
      selection.textEncoderStrength === candidate.textEncoderStrength &&
      selection.denoisingSchedule?.start ===
        candidate.denoisingSchedule?.start &&
      selection.denoisingSchedule?.end === candidate.denoisingSchedule?.end
    );
  });
