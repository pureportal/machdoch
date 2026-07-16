import type {
  MediaCapability,
  MediaModelCatalogSnapshot,
  MediaModelDescriptor,
  MediaProviderCatalogEntry,
} from "./contracts.js";
import { getMediaModelAddonCapabilities } from "./model-addons.js";
import {
  LOCAL_BIREFNET_MODEL_ID,
  LOCAL_BORDER_MATTE_MODEL_ID,
} from "./subject-cutout-policy.js";

export interface MediaCatalogAvailability {
  isOpenAiConfigured: boolean;
  isLocalFluxInstalled?: boolean;
  isLocalBiRefNetInstalled?: boolean;
}

const IMAGE_GENERATION_CAPABILITIES = [
  "text-to-image",
  "image-to-image",
  "multi-reference-edit",
] as const satisfies readonly MediaCapability[];

export const BUILTIN_MEDIA_CATALOG_REVISION = "builtin-2026-07-15.6-cutout-policy";
export const BUILTIN_MEDIA_CATALOG_CHECKED_AT = "2026-07-14T00:00:00.000Z";

const createProviders = (
  isOpenAiConfigured: boolean,
): MediaProviderCatalogEntry[] => [
  {
    id: "local-onnx",
    displayName: "Managed local ONNX Runtime",
    target: "local",
    configured: true,
    lifecycle: "active",
    capabilities: ["background-remove", "transparent-output"],
    privacySummary: "Pixels remain on this device.",
    checkedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
    staleAfterSeconds: 30 * 24 * 60 * 60,
    sourceUrl: "https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1",
    catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
  },
  {
    id: "openai",
    displayName: "OpenAI",
    target: "remote",
    configured: isOpenAiConfigured,
    lifecycle: "active",
    capabilities: IMAGE_GENERATION_CAPABILITIES,
    privacySummary:
      "Prompts and explicitly attached reference assets are sent to OpenAI.",
    checkedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
    staleAfterSeconds: 7 * 24 * 60 * 60,
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-image-2",
    catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
  },
  {
    id: "local-diffusers",
    displayName: "Managed local Diffusers",
    target: "local",
    configured: true,
    lifecycle: "active",
    capabilities: IMAGE_GENERATION_CAPABILITIES,
    privacySummary: "Prompts and pixels remain on this device.",
    checkedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
    staleAfterSeconds: 30 * 24 * 60 * 60,
    sourceUrl: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
    catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
  },
  {
    id: "local-utility",
    displayName: "Built-in media utilities",
    target: "local",
    configured: true,
    lifecycle: "active",
    capabilities: [
      "background-remove",
      "transparent-output",
      "image-quality-analysis",
    ],
    privacySummary: "Pixels remain on this device.",
    checkedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
    staleAfterSeconds: 30 * 24 * 60 * 60,
    catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
  },
];

export const createMediaModelCatalogSnapshot = ({
  isOpenAiConfigured,
  isLocalFluxInstalled = false,
  isLocalBiRefNetInstalled = false,
}: MediaCatalogAvailability): MediaModelCatalogSnapshot => {
  const providers = createProviders(isOpenAiConfigured);
  const configuredProviders = new Set(
    providers.filter((provider) => provider.configured).map((provider) => provider.id),
  );
  const models: MediaModelDescriptor[] = [
    {
      id: "openai:gpt-image-2",
      providerId: "openai",
      displayName: "GPT Image 2",
      family: "OpenAI GPT Image",
      target: "remote",
      lifecycle: "active",
      lifecycleCheckedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
      lifecycleStaleAfterSeconds: 7 * 24 * 60 * 60,
      lifecycleSourceUrl: "https://developers.openai.com/api/docs/models/gpt-image-2",
      catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
      capabilities: IMAGE_GENERATION_CAPABILITIES,
      configured: configuredProviders.has("openai"),
      installed: true,
      bundled: false,
      installationStatus: "remote",
      packageType: "remote-endpoint",
      architecture: null,
      addonCapabilities: [],
      license: {
        name: "OpenAI service terms",
        spdxId: null,
        sourceUrl: "https://openai.com/policies/service-terms/",
        commercialUse: "provider-terms",
        requiresAcceptance: false,
      },
      recommended: true,
      speedScore: 82,
      qualityScore: 96,
      costHint: "Provider usage is billed per generated image.",
      privacySummary: "Prompt text is sent to OpenAI; no source image is uploaded for text-to-image.",
      limitation:
        "Transparent output requires an explicit background-removal step.",
      userImported: false,
    },
    {
      id: "local:flux-2-klein-4b",
      providerId: "local-diffusers",
      displayName: "FLUX.2 klein 4B",
      family: "FLUX.2 klein",
      target: "local",
      lifecycle: "active",
      lifecycleCheckedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
      lifecycleStaleAfterSeconds: 30 * 24 * 60 * 60,
      lifecycleSourceUrl: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
      catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
      capabilities: IMAGE_GENERATION_CAPABILITIES,
      configured: true,
      installed: isLocalFluxInstalled,
      bundled: false,
      installationStatus: isLocalFluxInstalled ? "installed" : "not-installed",
      ...(isLocalFluxInstalled ? { installedRevision: "catalog-default" } : {}),
      packageType: "diffusers",
      architecture: "flux-2",
      addonCapabilities: getMediaModelAddonCapabilities("local-diffusers", "flux-2"),
      runtimeReadiness: isLocalFluxInstalled ? "ready" : "not-applicable",
      ...(isLocalFluxInstalled
        ? {
            runtimeReadinessDiagnostic:
              "The simulated browser catalog treats this fixture as verified.",
          }
        : {}),
      license: {
        name: "Apache License 2.0",
        spdxId: "Apache-2.0",
        sourceUrl: "https://www.apache.org/licenses/LICENSE-2.0",
        commercialUse: "allowed",
        requiresAcceptance: true,
      },
      recommended: true,
      speedScore: 74,
      qualityScore: 88,
      minVramGb: 13,
      expectedDownloadGb: 14.9,
      costHint: "No provider charge; uses local GPU time and power.",
      privacySummary: "Prompt and generated pixels remain on this device.",
      limitation:
        "Requires an installed, verified Diffusers runtime and compatible GPU.",
      userImported: false,
    },
    {
      id: LOCAL_BORDER_MATTE_MODEL_ID,
      providerId: "local-utility",
      displayName: "Local Border Matte",
      family: "Machdoch border matte",
      target: "local",
      lifecycle: "active",
      lifecycleCheckedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
      lifecycleStaleAfterSeconds: 30 * 24 * 60 * 60,
      catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
      capabilities: ["background-remove", "transparent-output"],
      configured: true,
      installed: true,
      bundled: true,
      installationStatus: "bundled",
      installedRevision: BUILTIN_MEDIA_CATALOG_REVISION,
      packageType: "native-utility",
      architecture: null,
      addonCapabilities: [],
      license: {
        name: "Machdoch bundled utility",
        spdxId: null,
        sourceUrl: "https://github.com/machdoch/machdoch",
        commercialUse: "allowed",
        requiresAcceptance: false,
      },
      recommended: true,
      speedScore: 98,
      qualityScore: 72,
      minVramGb: 0,
      expectedDownloadGb: 0,
      costHint: "No provider charge; uses local CPU time.",
      privacySummary: "Pixels remain on this device.",
      limitation:
        "Designed for subjects separated from a uniform background connected to the image border.",
      userImported: false,
    },
    {
      id: LOCAL_BIREFNET_MODEL_ID,
      providerId: "local-onnx",
      displayName: "BiRefNet Matting",
      family: "BiRefNet",
      target: "local",
      lifecycle: "active",
      lifecycleCheckedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
      lifecycleStaleAfterSeconds: 30 * 24 * 60 * 60,
      catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
      capabilities: ["background-remove", "transparent-output"],
      configured: true,
      installed: isLocalBiRefNetInstalled,
      bundled: false,
      installationStatus: isLocalBiRefNetInstalled ? "installed" : "not-installed",
      ...(isLocalBiRefNetInstalled
        ? { installedRevision: "a0cf9925880620000aa2d1948d61bf659ddfdfaa" }
        : {}),
      packageType: "onnx",
      architecture: null,
      addonCapabilities: [],
      license: {
        name: "MIT License",
        spdxId: "MIT",
        sourceUrl:
          "https://github.com/ZhengPeng7/BiRefNet/blob/a0cf9925880620000aa2d1948d61bf659ddfdfaa/LICENSE",
        commercialUse: "allowed",
        requiresAcceptance: true,
      },
      recommended: true,
      speedScore: 55,
      qualityScore: 94,
      expectedDownloadGb: 0.91,
      costHint: "No provider charge; uses local CPU time and memory.",
      privacySummary: "Pixels remain on this device.",
      limitation:
        "The official 1024×1024 ONNX matting graph prioritizes subject-edge quality and may be slower on CPU-only systems.",
      lifecycleSourceUrl:
        "https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1",
      userImported: false,
    },
    {
      id: "local:image-quality-baseline",
      providerId: "local-utility",
      displayName: "Technical Quality Baseline",
      family: "Machdoch media utility",
      target: "local",
      lifecycle: "active",
      lifecycleCheckedAt: BUILTIN_MEDIA_CATALOG_CHECKED_AT,
      lifecycleStaleAfterSeconds: 30 * 24 * 60 * 60,
      catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
      capabilities: ["image-quality-analysis"],
      configured: true,
      installed: true,
      bundled: true,
      installationStatus: "bundled",
      installedRevision: BUILTIN_MEDIA_CATALOG_REVISION,
      packageType: "native-utility",
      architecture: null,
      addonCapabilities: [],
      license: {
        name: "Machdoch bundled utility",
        spdxId: null,
        sourceUrl: "https://github.com/machdoch/machdoch",
        commercialUse: "allowed",
        requiresAcceptance: false,
      },
      recommended: true,
      speedScore: 98,
      qualityScore: 80,
      minVramGb: 0,
      expectedDownloadGb: 0,
      costHint: "Runs locally.",
      privacySummary: "Only deterministic local image checks are performed.",
      userImported: false,
    },
  ];
  return {
    schemaVersion: 1,
    catalogRevision: BUILTIN_MEDIA_CATALOG_REVISION,
    observedAt: new Date().toISOString(),
    providers,
    models,
    addons: [],
  };
};

export const createMediaModelCatalog = ({
  isOpenAiConfigured,
  isLocalFluxInstalled = false,
  isLocalBiRefNetInstalled = false,
}: MediaCatalogAvailability): MediaModelDescriptor[] => {
  return createMediaModelCatalogSnapshot({
    isOpenAiConfigured,
    isLocalFluxInstalled,
    isLocalBiRefNetInstalled,
  }).models;
};
