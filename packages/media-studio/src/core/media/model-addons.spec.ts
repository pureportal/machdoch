import { matchesMediaResourceQuery } from "./resource-discovery.js";
import { describe, expect, it } from "vitest";
import type { MediaModelAddonDescriptor } from "./contracts.js";
import {
  createMediaModelAddonSelection,
  getMediaModelAddonCapabilities,
  getMissingMediaModelAddonTriggers,
  inspectMediaModelAddonCompatibility,
  mediaModelAddonSelectionsEqual,
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
    expect(
      matchesMediaResourceQuery(addon, undefined, [], "character flux-2"),
    ).toBe(true);
    expect(
      matchesMediaResourceQuery(addon, undefined, [], "idle denoiser"),
    ).toBe(true);
    expect(
      matchesMediaResourceQuery(
        addon,
        undefined,
        [],
        "creative review-required",
      ),
    ).toBe(true);
  });

  it("is case insensitive and rejects a query with any unmatched term", () => {
    expect(
      matchesMediaResourceQuery(addon, undefined, [], "KLEIN GAME GIRL"),
    ).toBe(true);
    expect(matchesMediaResourceQuery(addon, undefined, [], "flux audio")).toBe(
      false,
    );
  });

  it("treats blank queries as an unfiltered library", () => {
    expect(matchesMediaResourceQuery(addon, undefined, [], " \t ")).toBe(true);
  });
});

describe("media model add-on selection", () => {
  it("matches complete words, punctuation and escaped trigger phrases", () => {
    const dog = { ...addon, triggerWords: ["sks dog"] };
    expect(
      promptContainsMediaModelAddonTrigger("a sks dog, outside", dog),
    ).toBe(true);
    expect(
      promptContainsMediaModelAddonTrigger("a sks dogmatic speaker", dog),
    ).toBe(false);
    expect(
      promptContainsMediaModelAddonTrigger("pixelated", {
        ...addon,
        triggerWords: ["pixel"],
      }),
    ).toBe(false);
    expect(
      promptContainsMediaModelAddonTrigger("(style.v2), portrait", {
        ...addon,
        triggerWords: ["(style.v2)"],
      }),
    ).toBe(true);
  });

  it("warns only for active LoRAs that change a loaded component", () => {
    const selection = createMediaModelAddonSelection(addon);
    if (selection.kind !== "lora") throw new Error("Expected a LoRA");
    expect(
      getMissingMediaModelAddonTriggers("landscape", [addon], [selection]),
    ).toHaveLength(1);
    expect(
      getMissingMediaModelAddonTriggers(
        "landscape",
        [addon],
        [{ ...selection, enabled: false }],
      ),
    ).toEqual([]);
    expect(
      getMissingMediaModelAddonTriggers(
        "landscape",
        [addon],
        [{ ...selection, modelStrength: 0, textEncoderStrength: 1 }],
      ),
    ).toEqual([]);
    expect(
      getMissingMediaModelAddonTriggers(
        "landscape",
        [{ ...addon, targetComponents: ["text-encoder"] }],
        [{ ...selection, modelStrength: 0, textEncoderStrength: 1 }],
      ),
    ).toHaveLength(1);
    const embedding = {
      ...addon,
      kind: "textual-inversion" as const,
      defaultToken: "EasyNegative",
    };
    expect(
      getMissingMediaModelAddonTriggers(
        "landscape",
        [embedding],
        [createMediaModelAddonSelection(embedding)],
      ),
    ).toEqual([]);
  });

  it("defaults the verified EasyNegative asset to the negative prompt", () => {
    expect(
      createMediaModelAddonSelection({
        ...addon,
        kind: "textual-inversion",
        digest:
          "c74b4e810b030f6b75fde959e2db678c268d07115b85356d3c0138ba5eb42340",
      }),
    ).toMatchObject({ placement: "negative" });
    expect(
      createMediaModelAddonSelection({
        ...addon,
        kind: "textual-inversion",
        defaultToken: "<monet>",
      }),
    ).toMatchObject({ placement: "positive" });
  });

  it.each([
    ["local-wan", "wan-2.2-ti2v"],
    ["local-video", "ltx-video"],
    ["local-video", "framepack-i2v"],
    ["local-video", "hunyuan-video-1.5-i2v"],
  ] as const)(
    "exposes denoiser LoRAs for %s / %s",
    (providerId, architecture) => {
      expect(getMediaModelAddonCapabilities(providerId, architecture)).toEqual([
        {
          kind: "lora",
          targetComponents: ["denoiser"],
          maxActive: 8,
          supportsSeparateComponentStrengths: false,
          supportsDenoisingSchedules: false,
        },
      ]);
    },
  );
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

  it.each(["pony", "stable-diffusion-xl"] as const)(
    "keeps %s LoRAs separate when selecting and switching models",
    (architecture) => {
      const model = {
        ...fluxModel,
        architecture,
        addonCapabilities: getMediaModelAddonCapabilities(
          "local-diffusers",
          architecture,
        ),
      };
      const matching = { ...addon, architecture, baseModelHint: null };
      const other = {
        ...matching,
        id: "addon:other-family",
        architecture:
          architecture === "pony"
            ? ("stable-diffusion-xl" as const)
            : ("pony" as const),
      };
      expect(inspectMediaModelAddonCompatibility(model, matching).status).toBe(
        "compatible",
      );
      expect(inspectMediaModelAddonCompatibility(model, other).status).toBe(
        "incompatible",
      );
      expect(
        reconcileMediaModelAddonSelections(
          model,
          [matching, other],
          [
            createMediaModelAddonSelection(matching),
            createMediaModelAddonSelection(other),
          ],
        ),
      ).toEqual([createMediaModelAddonSelection(matching)]);
    },
  );

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
