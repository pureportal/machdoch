import type {
  MediaCapability,
  MediaGenerationTarget,
  MediaModelDescriptor,
} from "./contracts.js";
import { isMediaModelReady } from "./model-readiness.js";

export const mediaModelSupportsGenerationTarget = (
  model: MediaModelDescriptor,
  target: MediaGenerationTarget,
): boolean => {
  if (target === "video") {
    return model.capabilities.some((capability) =>
      ["text-to-video", "image-to-video", "start-end-to-video"].includes(
        capability,
      ),
    );
  }
  if (target === "svg") {
    return model.capabilities.some((capability) =>
      ["text-to-svg", "image-to-svg", "guided-svg-generation"].includes(
        capability,
      ),
    );
  }
  return model.capabilities.some((capability) =>
    [
      "text-to-image",
      "image-to-image",
      "masked-image-edit",
      "multi-reference-edit",
      "pose-control",
    ].includes(capability),
  );
};

export const isMediaGenerationModel = (model: MediaModelDescriptor): boolean =>
  (["image", "video", "svg"] as const).some((target) =>
    mediaModelSupportsGenerationTarget(model, target),
  );

export const getMediaModelPrimaryGenerationTarget = (
  model: MediaModelDescriptor,
): MediaGenerationTarget | null => {
  if (mediaModelSupportsGenerationTarget(model, "video")) return "video";
  if (mediaModelSupportsGenerationTarget(model, "svg")) return "svg";
  if (mediaModelSupportsGenerationTarget(model, "image")) return "image";
  return null;
};

export interface MediaModelSelectionRequirements {
  target?: MediaGenerationTarget;
  requiredCapabilities?: readonly MediaCapability[];
  allowedModelIds?: readonly string[] | null;
}

export const listSelectableMediaModels = (
  models: readonly MediaModelDescriptor[],
  requirements: MediaModelSelectionRequirements = {},
): MediaModelDescriptor[] =>
  models.filter(
    (model) =>
      isMediaModelReady(model) &&
      (!requirements.target ||
        mediaModelSupportsGenerationTarget(model, requirements.target)) &&
      (requirements.requiredCapabilities?.every((capability) =>
        model.capabilities.includes(capability),
      ) ??
        true) &&
      (requirements.allowedModelIds === null ||
        requirements.allowedModelIds === undefined ||
        requirements.allowedModelIds.includes(model.id)),
  );

export const listAvailableMediaGenerationModels = (
  models: readonly MediaModelDescriptor[],
): MediaModelDescriptor[] =>
  models.filter(
    (model) => isMediaGenerationModel(model) && isMediaModelReady(model),
  );

export const listMediaLibraryModels = (
  models: readonly MediaModelDescriptor[],
): MediaModelDescriptor[] =>
  models.filter(
    (model) =>
      isMediaGenerationModel(model) &&
      (model.userImported ||
        (model.target === "local" ? model.installed : model.configured)),
  );

const normalizeSearchValue = (value: string): string =>
  value.toLocaleLowerCase().replaceAll(/[-_:/.]+/g, " ");

export const matchesMediaModelQuery = (
  model: MediaModelDescriptor,
  query: string,
): boolean => {
  const terms = normalizeSearchValue(query).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const capabilityAliases = [
    model.capabilities.includes("transparent-output")
      ? "transparency alpha"
      : "",
    model.capabilities.includes("background-remove")
      ? "background removal cutout"
      : "",
    model.capabilities.some((capability) =>
      [
        "text-to-image",
        "image-to-image",
        "masked-image-edit",
        "multi-reference-edit",
        "pose-control",
      ].includes(capability),
    )
      ? "image generation"
      : "",
    model.capabilities.some((capability) =>
      ["text-to-video", "image-to-video", "start-end-to-video"].includes(
        capability,
      ),
    )
      ? "video generation animation"
      : "",
  ];
  const haystack = normalizeSearchValue(
    [
      model.id,
      model.providerId,
      model.displayName,
      model.family,
      model.target,
      model.lifecycle,
      model.catalogRevision,
      ...model.capabilities,
      ...capabilityAliases,
      model.configured ? "configured" : "unconfigured",
      model.installed ? "installed" : "not installed",
      model.bundled ? "bundled" : "",
      model.installationStatus,
      model.installedRevision ?? "",
      model.packageType,
      model.architecture ?? "",
      ...model.addonCapabilities.flatMap((capability) => [
        capability.kind,
        ...capability.targetComponents,
        `${capability.maxActive} active`,
      ]),
      model.management.acquisition,
      model.management.verification,
      model.runtimeReadiness,
      model.runtimeReadinessDiagnostic ?? "",
      model.license.name,
      model.license.spdxId ?? "",
      model.license.commercialUse,
      model.recommended ? "recommended" : "",
      model.minVramGb?.toString() ?? "",
      model.expectedDownloadGb?.toString() ?? "",
      model.costHint ?? "",
      model.privacySummary,
      model.limitation ?? "",
      model.userImported ? "user imported" : "",
    ].join(" "),
  );
  return terms.every((term) => haystack.includes(term));
};
