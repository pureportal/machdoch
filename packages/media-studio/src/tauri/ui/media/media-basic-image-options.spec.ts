import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "../../../core/media/catalog.js";
import type {
  MediaLocalModelArchitecture,
  MediaModelDescriptor,
} from "../../../core/media/contracts.js";
import { DEFAULT_IMAGE_RECIPE_SETTINGS } from "./media-studio-store";
import {
  basicImageModelError,
  basicImageReferenceLimit,
} from "./media-basic-image-options";

const catalog = createMediaModelCatalogSnapshot({
  isOpenAiConfigured: true,
  isLocalFluxInstalled: true,
});
const flux = catalog.models.find(
  (model) => model.id === "local:flux-2-klein-4b",
)!;
const openai = catalog.models.find((model) => model.providerId === "openai")!;
const model = (
  architecture: MediaLocalModelArchitecture,
  capabilities: MediaModelDescriptor["capabilities"],
): MediaModelDescriptor => ({
  ...flux,
  id: architecture,
  architecture,
  capabilities,
});
const reference = {
  assetId: "reference",
  role: "composition" as const,
  influence: 1,
};

describe("Basic image model options", () => {
  it.each(["stable-diffusion-2", "flux-1"] as const)(
    "allows one %s composition or base image",
    (architecture) => {
      const selected = model(architecture, [
        "text-to-image",
        "image-to-image",
        "masked-image-edit",
      ]);
      const settings = {
        ...DEFAULT_IMAGE_RECIPE_SETTINGS,
        referenceImages: [reference],
      };
      expect(basicImageModelError(settings, selected)).toBeNull();
      expect(
        basicImageReferenceLimit(
          { ...settings, baseImageAssetId: "base" },
          selected,
        ),
      ).toBe(0);
      expect(
        basicImageModelError(
          { ...settings, baseImageAssetId: "base" },
          selected,
        ),
      ).toMatch(/Remove a reference/);
      expect(
        basicImageModelError(
          { ...settings, referenceImages: [{ ...reference, role: "subject" }] },
          selected,
        ),
      ).not.toBeNull();
    },
  );

  it.each(["stable-diffusion-1", "stable-diffusion-xl", "krea-2"] as const)(
    "combines a %s base and mask with three references",
    (architecture) => {
      const selected = model(architecture, [
        "text-to-image",
        "image-to-image",
        "masked-image-edit",
        "multi-reference-edit",
      ]);
      const settings = {
        ...DEFAULT_IMAGE_RECIPE_SETTINGS,
        baseImageAssetId: "base",
        referenceImages: ["a", "b", "c"].map((assetId) => ({
          assetId,
          role: "subject" as const,
          influence: 1,
        })),
      };
      expect(basicImageReferenceLimit(settings, selected)).toBe(3);
      expect(basicImageModelError(settings, selected)).toBeNull();
      expect(
        basicImageModelError(
          {
            ...settings,
            referenceImages: [
              ...settings.referenceImages,
              { ...reference, role: "subject" },
            ],
          },
          selected,
        ),
      ).toMatch(/Remove a reference/);
      expect(
        basicImageModelError(
          { ...settings, baseImageAssetId: null, editStrength: 0 },
          selected,
        ),
      ).toBeNull();
    },
  );

  it("rejects KREA conditioning and respects the FLUX combined limit", () => {
    const settings = {
      ...DEFAULT_IMAGE_RECIPE_SETTINGS,
      baseImageAssetId: "base",
      referenceImages: [{ ...reference, role: "subject" as const }],
    };
    expect(
      basicImageModelError(settings, model("krea-2", ["text-to-image"])),
    ).toMatch(/base image/);
    expect(basicImageModelError(settings, flux)).toBeNull();
    expect(basicImageReferenceLimit(settings, flux)).toBe(7);
  });

  it("keeps unsupported model options from being silently ignored", () => {
    expect(
      basicImageModelError(
        { ...DEFAULT_IMAGE_RECIPE_SETTINGS, memoryProfile: "memory-saver" },
        flux,
      ),
    ).toMatch(/memory to Automatic/);
    expect(
      basicImageModelError(
        { ...DEFAULT_IMAGE_RECIPE_SETTINGS, memoryProfile: "memory-saver" },
        model("krea-2", ["text-to-image"]),
      ),
    ).toBeNull();
    expect(
      basicImageModelError(
        { ...DEFAULT_IMAGE_RECIPE_SETTINGS, seed: 12 },
        openai,
      ),
    ).toMatch(/seed/);
    expect(
      basicImageModelError(
        {
          ...DEFAULT_IMAGE_RECIPE_SETTINGS,
          sampling: { width: 512, height: 512 },
        },
        openai,
      ),
    ).toMatch(/sampling/);
    expect(
      basicImageModelError(
        {
          ...DEFAULT_IMAGE_RECIPE_SETTINGS,
          sampling: { numInferenceSteps: 12 },
        },
        flux,
      ),
    ).toMatch(/4 sampling/);
    expect(
      basicImageModelError(
        { ...DEFAULT_IMAGE_RECIPE_SETTINGS, sampling: { guidanceScale: 5 } },
        flux,
      ),
    ).toMatch(/guidance/);
  });
});
