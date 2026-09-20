import type { MediaModelDescriptor } from "./contracts.js";
import { getMediaModelAddonCapabilities } from "./model-addons.js";

export const createManagedGenerationModels = (
  catalogRevision: string,
): MediaModelDescriptor[] =>
  (
    [
      {
        id: "local:wan2.2-ti2v-5b",
        displayName: "Wan2.2 TI2V 5B",
        family: "Wan2.2",
        architecture: "wan-2.2-ti2v",
        packageType: "diffusers",
        capabilities: [
          "text-to-video",
          "image-to-video",
          "start-end-to-video",
          "transparent-output",
          "alpha-video",
          "video-composite",
        ],
        minVramGb: 24,
        expectedDownloadGb: 31.85,
        speedScore: 45,
        qualityScore: 88,
        source: "https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers",
      },
      {
        id: "local-svg:IntroSVG-Qwen2.5-VL-7B",
        displayName: "IntroSVG 7B",
        family: "IntroSVG",
        architecture: "intro-svg",
        packageType: "transformers",
        capabilities: [
          "text-to-svg",
          "image-to-svg",
          "guided-svg-generation",
          "svg-structure-evaluation",
        ],
        minVramGb: 18,
        expectedDownloadGb: 15.46,
        speedScore: 58,
        qualityScore: 94,
        source: "https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B",
      },
    ] satisfies Array<
      Pick<
        MediaModelDescriptor,
        | "id"
        | "displayName"
        | "family"
        | "architecture"
        | "packageType"
        | "capabilities"
        | "minVramGb"
        | "expectedDownloadGb"
        | "speedScore"
        | "qualityScore"
      > & { source: string }
    >
  ).map(
    ({ source, ...model }): MediaModelDescriptor => ({
      ...model,
      providerId: "local-diffusers",
      target: "local",
      lifecycle: "active",
      lifecycleCheckedAt: "2026-09-20T00:00:00.000Z",
      lifecycleStaleAfterSeconds: 10 * 365 * 24 * 60 * 60,
      lifecycleSourceUrl: source,
      catalogRevision,
      configured: true,
      installed: false,
      bundled: false,
      installationStatus: "not-installed",
      addonCapabilities: getMediaModelAddonCapabilities(
        "local-diffusers",
        model.architecture,
      ),
      management: {
        acquisition: "managed-install",
        verification: "model-probe",
      },
      runtimeReadiness: "unverified",
      license: {
        name: "Apache License 2.0",
        spdxId: "Apache-2.0",
        sourceUrl: source,
        commercialUse: "allowed",
        requiresAcceptance: false,
      },
      recommended: true,
      privacySummary: "Prompts and references remain on this device.",
      userImported: false,
    }),
  );
