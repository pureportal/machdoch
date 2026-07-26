import type {
  MediaCapability,
  MediaDiscoveredModelArtifact,
  MediaLocalDiffusersRuntimeStatus,
  MediaModelCatalogSnapshot,
  MediaModelDescriptor,
  MediaProviderCatalogEntry,
  MediaWorkspaceModelDiscovery,
} from "./contracts.js";

export interface MediaDiscoveredRuntimeProfile {
  id: string;
  architecture: string;
  artifactKind: MediaDiscoveredModelArtifact["kind"];
  preferredRelativePath?: string;
  capabilities: readonly MediaCapability[];
  requiredRuntimeCapabilities: readonly string[];
  provider: Omit<
    MediaProviderCatalogEntry,
    "configured" | "checkedAt" | "capabilities"
  >;
  model: Omit<
    MediaModelDescriptor,
    | "configured"
    | "installed"
    | "installationStatus"
    | "installedRevision"
    | "runtimeReadiness"
    | "runtimeReadinessDiagnostic"
    | "runtimeReadinessCheckedAt"
    | "lifecycleCheckedAt"
    | "capabilities"
  > & {
    installedRevision: string;
  };
}

export const matchesMediaDiscoveredModelQuery = (
  artifact: MediaDiscoveredModelArtifact,
  query: string,
): boolean => {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) return true;

  const searchableText = [
    artifact.displayName,
    artifact.relativePath,
    artifact.path,
    artifact.kind,
    artifact.status,
    artifact.architecture ?? "",
    artifact.diagnostic,
    ...artifact.capabilities,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return terms.every((term) => searchableText.includes(term));
};

const WAN_SOURCE_URL =
  "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers";

/**
 * Executable packages discovered outside the managed catalog register here.
 * The UI and compiler consume only capabilities; adding another family does
 * not require model-name conditionals in those layers.
 */
export const MEDIA_DISCOVERED_RUNTIME_PROFILES: readonly MediaDiscoveredRuntimeProfile[] =
  [
    {
      id: "wan2.2-ti2v-5b",
      architecture: "wan-2.2-ti2v",
      artifactKind: "diffusers-model",
      preferredRelativePath: "wan-2.2-ti2v-5b",
      capabilities: [
        "text-to-video",
        "image-to-video",
        "start-end-to-video",
        "transparent-output",
        "alpha-video",
        "video-composite",
      ],
      requiredRuntimeCapabilities: [
        "image-to-video",
        "start-end-to-video",
        "vp9-alpha",
        "alpha-video",
        "video-composite",
      ],
      provider: {
        id: "local-wan",
        displayName: "Local WAN Diffusers",
        target: "local",
        lifecycle: "active",
        privacySummary: "Prompt text and source frames remain on this device.",
        staleAfterSeconds: 2_592_000,
        sourceUrl: WAN_SOURCE_URL,
        catalogRevision: "wan2.2-ti2v-5b-b8fff731",
      },
      model: {
        id: "local:wan2.2-ti2v-5b",
        providerId: "local-wan",
        displayName: "Wan2.2 TI2V 5B",
        family: "Wan2.2",
        target: "local",
        lifecycle: "active",
        lifecycleStaleAfterSeconds: 2_592_000,
        lifecycleSourceUrl: WAN_SOURCE_URL,
        catalogRevision: "wan2.2-ti2v-5b-b8fff731",
        bundled: false,
        installedRevision:
          "b8fff7315c768468a5333511427288870b2e9635",
        packageType: "diffusers",
        architecture: "wan-2.2-ti2v",
        addonCapabilities: [],
        management: {
          acquisition: "workspace-discovery",
          verification: "runtime-probe",
        },
        license: {
          name: "Apache License 2.0",
          spdxId: "Apache-2.0",
          sourceUrl: WAN_SOURCE_URL,
          commercialUse: "allowed",
          requiresAcceptance: false,
        },
        recommended: true,
        speedScore: 45,
        qualityScore: 88,
        minVramGb: 24,
        expectedDownloadGb: 33.9,
        costHint: "No provider charge; high local GPU, RAM, and disk use.",
        privacySummary:
          "Prompt text and the first and last frames remain on this device.",
        limitation:
          "The official native profile requires at least 24 GiB VRAM. Studio permits only a bounded experimental preview on validated 16+ GiB adapters.",
        userImported: false,
      },
    },
  ];

interface MediaDiscoveredArtifactSelection {
  artifact: MediaDiscoveredModelArtifact | null;
  ambiguousReadyPaths: readonly string[];
}

const selectArtifact = (
  discovery: MediaWorkspaceModelDiscovery,
  profile: MediaDiscoveredRuntimeProfile,
): MediaDiscoveredArtifactSelection => {
  const candidates = discovery.entries.filter(
    (entry) =>
      entry.kind === profile.artifactKind &&
      entry.architecture === profile.architecture,
  );
  const ready = candidates.filter((entry) => entry.status === "ready");
  const preferred = profile.preferredRelativePath
    ? ready.find(
        (entry) =>
          entry.relativePath.localeCompare(
            profile.preferredRelativePath ?? "",
            undefined,
            { sensitivity: "base" },
          ) === 0,
      )
    : null;
  return {
    artifact: preferred ?? ready[0] ?? candidates[0] ?? null,
    ambiguousReadyPaths:
      ready.length > 1 && !preferred
        ? ready.map((entry) => entry.relativePath)
        : [],
  };
};

const runtimeDiagnostic = (
  runtime: MediaLocalDiffusersRuntimeStatus | null,
  missingArchitectures: readonly string[],
  missingCapabilities: readonly string[],
): string => {
  if (!runtime?.ready) {
    return (
      runtime?.diagnostic ??
      "The local Diffusers runtime has not been probed. Refresh runtime status after installation."
    );
  }
  const missing = [
    missingArchitectures.length > 0
      ? `architecture ${missingArchitectures.join(", ")}`
      : null,
    missingCapabilities.length > 0
      ? `capabilities ${missingCapabilities.join(", ")}`
      : null,
  ].filter((value): value is string => value !== null);
  return `The local runtime is available but does not advertise ${missing.join(" and ")}. Re-probe after installing the matching pinned dependencies.`;
};

export const extendMediaCatalogWithWorkspaceDiscovery = ({
  catalog,
  discovery,
  runtime,
  profiles = MEDIA_DISCOVERED_RUNTIME_PROFILES,
}: {
  catalog: MediaModelCatalogSnapshot;
  discovery: MediaWorkspaceModelDiscovery | null;
  runtime: MediaLocalDiffusersRuntimeStatus | null;
  profiles?: readonly MediaDiscoveredRuntimeProfile[];
}): MediaModelCatalogSnapshot => {
  if (!discovery) return catalog;

  const matches = profiles
    .map((profile) => ({ profile, ...selectArtifact(discovery, profile) }))
    .filter(
      (
        match,
      ): match is {
        profile: MediaDiscoveredRuntimeProfile;
        artifact: MediaDiscoveredModelArtifact;
        ambiguousReadyPaths: readonly string[];
      } => match.artifact !== null,
    );
  if (matches.length === 0) return catalog;

  const providerIds = new Set(matches.map(({ profile }) => profile.provider.id));
  const modelIds = new Set(matches.map(({ profile }) => profile.model.id));
  const providers = catalog.providers.filter(
    (provider) => !providerIds.has(provider.id),
  );
  const models = catalog.models.filter((model) => !modelIds.has(model.id));
  const discoveredProviders = new Map<string, MediaProviderCatalogEntry>();

  for (const { profile, artifact, ambiguousReadyPaths } of matches) {
    const installed =
      artifact.status === "ready" && ambiguousReadyPaths.length === 0;
    const missingArchitectures = runtime?.architectures.includes(
      profile.architecture,
    )
      ? []
      : [profile.architecture];
    const missingCapabilities = profile.requiredRuntimeCapabilities.filter(
      (capability) => !runtime?.capabilities.includes(capability),
    );
    const runtimeReady =
      installed &&
      runtime?.ready === true &&
      missingArchitectures.length === 0 &&
      missingCapabilities.length === 0;
    const configured = installed && runtimeReady;
    const diagnostic =
      ambiguousReadyPaths.length > 0
        ? `Multiple compatible packages were discovered (${ambiguousReadyPaths.join(", ")}). Keep the preferred package at ${profile.preferredRelativePath ?? "the configured relative path"} or leave only one compatible package.`
        : !installed
          ? artifact.diagnostic
          : runtimeReady
            ? `The ${artifact.displayName} package and local runtime are ready.`
            : runtimeDiagnostic(
                runtime,
                missingArchitectures,
                missingCapabilities,
              );

    const existingProvider = discoveredProviders.get(profile.provider.id);
    discoveredProviders.set(profile.provider.id, {
      ...(existingProvider ?? profile.provider),
      configured: configured || existingProvider?.configured === true,
      checkedAt: discovery.scannedAt,
      capabilities: [
        ...new Set([
          ...(existingProvider?.capabilities ?? []),
          ...profile.capabilities,
        ]),
      ],
    });
    const { installedRevision, ...modelProfile } = profile.model;
    models.push({
      ...modelProfile,
      configured,
      installed,
      installationStatus: installed ? "installed" : "not-installed",
      ...(installed ? { installedRevision } : {}),
      runtimeReadiness: !installed
        ? "unverified"
        : runtimeReady
          ? "ready"
          : "runtime-unavailable",
      runtimeReadinessDiagnostic: diagnostic,
      runtimeReadinessCheckedAt: discovery.scannedAt,
      lifecycleCheckedAt: discovery.scannedAt,
      capabilities: profile.capabilities,
    });
  }
  providers.push(...discoveredProviders.values());

  return {
    ...catalog,
    catalogRevision: `${catalog.catalogRevision}+workspace-profiles:${matches
      .map(
        ({ profile, artifact, ambiguousReadyPaths }) =>
          `${profile.id}-${artifact.status}-${artifact.fileCount}-${artifact.byteSize}-${ambiguousReadyPaths.length}`,
      )
      .join(",")}`,
    providers,
    models,
  };
};
