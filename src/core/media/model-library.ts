import type { MediaModelDescriptor } from "./contracts.js";

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
      ["text-to-image", "image-to-image", "multi-reference-edit"].includes(
        capability,
      ),
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
