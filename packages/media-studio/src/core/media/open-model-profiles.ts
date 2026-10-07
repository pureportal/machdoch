import profiles from "../../../../../apps/client/src-tauri/python/open_media_models.json" with { type: "json" };
import manifests from "../../../../../apps/client/src-tauri/src/media/open_model_manifests.json" with { type: "json" };
import studentManifests from "../../../../../apps/client/src-tauri/src/media/student_model_manifests.json" with { type: "json" };
import type { MediaCapability, MediaModelDescriptor } from "./contracts.js";
import { getMediaModelAddonCapabilities } from "./model-addons.js";

export interface OpenMediaModelProfile {
  id: string;
  architecture: string;
  displayName: string;
  family: string;
  repository: string;
  revision: string;
  pipeline: string;
  capabilities: readonly MediaCapability[];
  steps: number;
  guidance: number;
  fixedSteps: boolean;
  fixedGuidance: boolean;
  maxReferences?: number;
  audio?: boolean;
  negativePrompt?: boolean;
  prompt?: boolean;
  spatialMultiple?: number;
  video?: { minimum: number; maximum: number; stride: number; fps: number };
  license: {
    name: string;
    spdxId: string | null;
    commercialUse: "allowed" | "review-required";
    sourceUrl?: string;
  };
  distillation?: {
    method: "dmad" | "pdmd";
    baseRepository: string;
    checkpointSourceFile: string;
    checkpointFile: string;
    checkpointSha256: string;
    checkpointByteSize: number;
  } & (
    | { sampler: "renoise" | "euler"; videoShift: number; audioShift: number }
    | { sampler: "lcm"; timesteps: number[] }
  );
}

export const OPEN_MEDIA_MODEL_PROFILES: readonly OpenMediaModelProfile[] =
  profiles as OpenMediaModelProfile[];

export const openMediaModelProfile = (
  architecture: string | null | undefined,
) =>
  OPEN_MEDIA_MODEL_PROFILES.find(
    (profile) => profile.architecture === architecture,
  );

export const createOpenMediaModels = (
  catalogRevision: string,
): MediaModelDescriptor[] =>
  profiles.map((profile) => {
    const manifest = [...manifests, ...studentManifests].find(
      (item) => item.modelId === profile.id,
    );
    const source = `https://huggingface.co/${profile.repository}`;
    return {
      id: profile.id,
      architecture: profile.architecture,
      displayName: profile.displayName,
      family: profile.family,
      providerId: "local-diffusers",
      target: "local",
      lifecycle: "active",
      lifecycleCheckedAt: "2026-10-02T00:00:00.000Z",
      lifecycleStaleAfterSeconds: 31_536_000,
      lifecycleSourceUrl: source,
      catalogRevision,
      capabilities: profile.capabilities as MediaCapability[],
      configured: true,
      installed: false,
      bundled: false,
      installationStatus: "not-installed",
      packageType: "diffusers",
      management: {
        acquisition: manifest ? "managed-install" : "file-import",
      },
      addonCapabilities: getMediaModelAddonCapabilities(
        "local-diffusers",
        profile.architecture,
      ),
      runtimeReadiness: "unverified",
      license: {
        ...profile.license,
        commercialUse: profile.license.commercialUse as
          | "allowed"
          | "review-required",
        sourceUrl: profile.license.sourceUrl ?? source,
        requiresAcceptance: profile.license.commercialUse !== "allowed",
      },
      recommended: false,
      speedScore: 0,
      qualityScore: 0,
      ...(manifest
        ? {
            expectedDownloadGb:
              manifest.files.reduce((total, file) => total + file.byteSize, 0) /
              1_024 ** 3,
          }
        : {}),
      privacySummary: "Generation runs on this device.",
      userImported: false,
    };
  });
