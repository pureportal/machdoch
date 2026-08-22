import { describe, expect, it } from "vitest";
import type { MediaModelAddonDescriptor } from "./contracts.js";
import {
  createMediaModelAddonSelection,
  inspectMediaModelAddonCompatibility,
  mediaModelAddonSelectionsEqual,
  matchesMediaModelAddonQuery,
  promptContainsMediaModelAddonTrigger,
  reconcileMediaModelAddonSelections,
} from "./model-addons.js";
import { createMediaModelCatalogSnapshot } from "./catalog.js";

const addon: MediaModelAddonDescriptor = {
  id: "addon:flux-character-style",
  kind: "lora",
  displayName: "Character Style XL",
  architecture: "flux-2",
  architectureConfidence: "high",
  format: "safetensors",
  targetComponents: ["denoiser"],
  embeddingVectors: [],
  loraProfile: {
    algorithm: "lora",
    dialect: "diffusers-peft",
    rankMinimum: 16,
    rankMaximum: 32,
    heterogeneousRanks: true,
    targetModuleCount: 120,
    convolutionTargetCount: 0,
    magnitudeVectorCount: 0,
    networkAlphaCount: 120,
  },
  baseModelHint: "FLUX.2 Klein",
  triggerWords: ["game girl", "idle pose"],
  defaultToken: null,
  digest: "a".repeat(64),
  headerDigest: "b".repeat(64),
  byteSize: 42_000_000,
  relativePath: "packages/character-style-xl/model.safetensors",
  sourceUrl: "https://example.test/models/character-style",
  license: {
    name: "CreativeML Open RAIL-M",
    spdxId: null,
    sourceUrl: "https://example.test/license",
    commercialUse: "review-required",
    requiresAcceptance: true,
  },
  importedAt: "2026-07-25T00:00:00.000Z",
};

describe("media model add-on search", () => {
  it("matches multiple terms across names, architecture, targets, and triggers", () => {
    expect(matchesMediaModelAddonQuery(addon, "character flux-2")).toBe(true);
    expect(matchesMediaModelAddonQuery(addon, "idle denoiser")).toBe(true);
    expect(matchesMediaModelAddonQuery(addon, "creative review-required")).toBe(
      true,
    );
  });

  it("is case insensitive and rejects a query with any unmatched term", () => {
    expect(matchesMediaModelAddonQuery(addon, "KLEIN GAME GIRL")).toBe(true);
    expect(matchesMediaModelAddonQuery(addon, "flux audio")).toBe(false);
  });

  it("treats blank queries as an unfiltered library", () => {
    expect(matchesMediaModelAddonQuery(addon, " \t ")).toBe(true);
  });
});

describe("media model add-on selection", () => {
  it("creates an enabled LoRA selection with neutral strength", () => {
    expect(createMediaModelAddonSelection(addon)).toEqual({
      kind: "lora",
      addonId: addon.id,
      enabled: true,
      modelStrength: 1,
      textEncoderStrength: null,
      denoisingSchedule: null,
    });
  });

  it("matches configured trigger phrases without case sensitivity", () => {
    expect(
      promptContainsMediaModelAddonTrigger("A GAME   GIRL portrait", addon),
    ).toBe(true);
    expect(
      promptContainsMediaModelAddonTrigger("A landscape at sunset", addon),
    ).toBe(false);
  });
});

describe("media model add-on compatibility", () => {
  const fluxModel = createMediaModelCatalogSnapshot({
    isOpenAiConfigured: false,
    isLocalFluxInstalled: true,
  }).models.find((model) => model.id === "local:flux-2-klein-4b")!;

  it("accepts only a high-confidence tensor match for the selected architecture", () => {
    expect(inspectMediaModelAddonCompatibility(fluxModel, addon).status).toBe(
      "compatible",
    );
    expect(
      inspectMediaModelAddonCompatibility(fluxModel, {
        ...addon,
        architectureConfidence: "medium",
      }).status,
    ).toBe("incompatible");
    expect(
      inspectMediaModelAddonCompatibility(fluxModel, {
        ...addon,
        architecture: "krea-2",
        baseModelHint: "FLUX.2 Klein",
      }).status,
    ).toBe("incompatible");
  });

  it("uses tensor evidence instead of a stale publisher hint", () => {
    expect(
      inspectMediaModelAddonCompatibility(fluxModel, {
        ...addon,
        baseModelHint: "Stable Diffusion XL",
      }).status,
    ).toBe("compatible");
  });

  it("removes stale, duplicate, and over-capacity selections", () => {
    const singleLoraModel = {
      ...fluxModel,
      addonCapabilities: fluxModel.addonCapabilities.map((capability) =>
        capability.kind === "lora"
          ? { ...capability, maxActive: 1 }
          : capability,
      ),
    };
    const dualAddonModel = {
      ...singleLoraModel,
      addonCapabilities: [
        ...singleLoraModel.addonCapabilities.filter(
          (capability) => capability.kind !== "textual-inversion",
        ),
        {
          kind: "textual-inversion" as const,
          targetComponents: ["text-encoder"] as const,
          maxActive: 1,
          supportsSeparateComponentStrengths: false,
          supportsDenoisingSchedules: false,
        },
      ],
    };
    const secondAddon = {
      ...addon,
      id: "addon:flux-character-detail",
      displayName: "Character Detail",
      digest: "c".repeat(64),
    };
    const invalidAddon = {
      ...addon,
      id: "addon:unknown",
      architectureConfidence: "unknown" as const,
      digest: "d".repeat(64),
    };
    const firstSelection = createMediaModelAddonSelection(addon);

    const reconciled = reconcileMediaModelAddonSelections(
      dualAddonModel,
      [addon, secondAddon, invalidAddon],
      [
        {
          kind: "textual-inversion",
          addonId: addon.id,
          enabled: true,
          token: "<invalid>",
          placement: "positive",
        },
        firstSelection,
        firstSelection,
        createMediaModelAddonSelection(secondAddon),
        createMediaModelAddonSelection(invalidAddon),
      ],
    );

    expect(reconciled).toEqual([firstSelection]);
    expect(mediaModelAddonSelectionsEqual(reconciled, [firstSelection])).toBe(
      true,
    );
    expect(
      mediaModelAddonSelectionsEqual(
        reconciled,
        reconciled.map((selection) =>
          selection.kind === "lora"
            ? { ...selection, modelStrength: 0.5 }
            : selection,
        ),
      ),
    ).toBe(false);
  });
});
