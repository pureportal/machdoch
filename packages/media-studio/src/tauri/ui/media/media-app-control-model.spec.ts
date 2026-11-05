import { describe, expect, it } from "vitest";
import type {
  MediaModelAddonDescriptor,
  MediaModelCatalogSnapshot,
  MediaStudioState,
} from "../../../core/media/contracts.js";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import type { CivitaiOptions } from "../../../core/media/civitai.js";
import {
  addMediaAddonSelection,
  civitaiBaseModelsFor,
  describeInstalledMediaAddons,
  describeMediaAddonSelections,
  updateMediaAddonSelection,
} from "./media-app-control-model";
import {
  DEFAULT_MEDIA_STUDIO_STATE,
  normalizeMediaStudioState,
} from "./media-studio-store";

const baseCatalog = createMediaModelCatalogSnapshot({
  isLocalFluxInstalled: true,
  isOpenAiConfigured: false,
});
const model = baseCatalog.models.find(
  (candidate) => candidate.architecture === "illustrious-xl",
)!;

const lora = (
  id: string,
  overrides: Partial<MediaModelAddonDescriptor> = {},
): MediaModelAddonDescriptor => ({
  id,
  kind: "lora",
  displayName: `LoRA ${id}`,
  architecture: "stable-diffusion-xl",
  architectureConfidence: "high",
  format: "safetensors",
  targetComponents: ["denoiser"],
  embeddingVectors: [],
  loraProfile: {
    algorithm: "lora",
    dialect: "kohya",
    rankMinimum: 16,
    rankMaximum: 16,
    heterogeneousRanks: false,
    targetModuleCount: 10,
    convolutionTargetCount: 0,
    magnitudeVectorCount: 0,
    networkAlphaCount: 10,
  },
  baseModelHint: null,
  triggerWords: ["lara croft"],
  defaultToken: null,
  digest: id.padEnd(64, "0"),
  headerDigest: "b".repeat(64),
  byteSize: 1,
  relativePath: `${id}.safetensors`,
  sourceUrl: null,
  license: {
    name: "Unknown",
    spdxId: null,
    sourceUrl: null,
    commercialUse: "review-required",
    requiresAcceptance: false,
  },
  importedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

const catalog: MediaModelCatalogSnapshot = {
  ...baseCatalog,
  addons: [
    lora("tomb"),
    lora("flux", { architecture: "flux-1", displayName: "Flux only" }),
  ],
};

const state = (prompt: string): MediaStudioState => {
  const initial = normalizeMediaStudioState(DEFAULT_MEDIA_STUDIO_STATE);
  return {
    ...initial,
    target: "image",
    recipe: { ...initial.recipe, modelId: model.id, prompt, modelAddons: [] },
  };
};

describe("Media Studio app control", () => {
  it("adds a compatible LoRA with strength and appends its trigger word", () => {
    const result = addMediaAddonSelection(
      state("an explorer"),
      catalog,
      "tomb",
      {
        strength: 0.8,
      },
    );
    expect(result.insertedTrigger).toBe("lara croft");
    expect(result.state.recipe.prompt).toBe("an explorer, lara croft");
    expect(describeMediaAddonSelections(result.state, catalog.addons)).toEqual([
      expect.objectContaining({
        addonId: "tomb",
        enabled: true,
        strength: 0.8,
        triggerInPrompt: true,
      }),
    ]);
  });

  it("keeps the prompt when the trigger is present or insertion is off", () => {
    expect(
      addMediaAddonSelection(state("Lara Croft running"), catalog, "tomb", {})
        .insertedTrigger,
    ).toBeNull();
    const result = addMediaAddonSelection(state(""), catalog, "tomb", {
      insertTriggerWords: false,
    });
    expect(result.state.recipe.prompt).toBe("");
  });

  it("rejects LoRAs for another base model with the compatibility reason", () => {
    expect(() =>
      addMediaAddonSelection(state(""), catalog, "flux", {}),
    ).toThrow("targets flux-1");
    expect(() =>
      addMediaAddonSelection(state(""), catalog, "missing", {}),
    ).toThrow("No installed LoRA");
  });

  it("updates and removes listed LoRAs", () => {
    const added = addMediaAddonSelection(state(""), catalog, "tomb", {}).state;
    const disabled = updateMediaAddonSelection(added, "tomb", {
      enabled: false,
      strength: 0.4,
    });
    expect(disabled.recipe.modelAddons[0]).toMatchObject({
      enabled: false,
      modelStrength: 0.4,
    });
    expect(
      updateMediaAddonSelection(disabled, "tomb", { remove: true }).recipe
        .modelAddons,
    ).toEqual([]);
    expect(() => updateMediaAddonSelection(state(""), "tomb", {})).toThrow(
      "not in the current list",
    );
  });

  it("lists installed add-ons with compatibility first", () => {
    expect(
      describeInstalledMediaAddons(state(""), catalog, "").map(
        ({ addonId, compatible }) => [addonId, compatible],
      ),
    ).toEqual([
      ["tomb", true],
      ["flux", false],
    ]);
    expect(
      describeInstalledMediaAddons(state(""), catalog, "lara").map(
        ({ addonId }) => addonId,
      ),
    ).toEqual(["tomb", "flux"]);
  });

  it("maps the selected model to compatible Civitai base models, its own family first", () => {
    const options: CivitaiOptions = {
      modelTypes: ["LORA"],
      baseModels: ["SDXL 0.9", "SDXL 1.0", "Illustrious", "Flux.1 D", "SD 1.5"],
      baseModelsByType: {
        LORA: ["SDXL 0.9", "SDXL 1.0", "Illustrious", "Flux.1 D", "SD 1.5"],
      },
      baseModelArchitectures: {
        "SDXL 0.9": "stable-diffusion-xl",
        "SDXL 1.0": "stable-diffusion-xl",
        Illustrious: "stable-diffusion-xl",
        "Flux.1 D": "flux-1",
        "SD 1.5": "stable-diffusion-1",
      },
    };
    expect(civitaiBaseModelsFor(model, options, "LORA")).toEqual([
      "Illustrious",
      "SDXL 1.0",
      "SDXL 0.9",
    ]);
    expect(civitaiBaseModelsFor(undefined, options, "LORA")).toEqual([]);
  });
});
