import { describe, expect, it } from "vitest";
import type { MediaModelAddonDescriptor } from "./contracts.js";
import {
  createMediaModelAddonSelection,
  matchesMediaModelAddonQuery,
  promptContainsMediaModelAddonTrigger,
} from "./model-addons.js";

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
