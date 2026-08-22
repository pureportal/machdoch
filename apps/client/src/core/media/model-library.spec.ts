import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import {
  getMediaModelPrimaryGenerationTarget,
  isMediaGenerationModel,
  listManageableMediaGenerationModels,
  listSelectableMediaModels,
  matchesMediaModelQuery,
  mediaModelSupportsGenerationTarget,
} from "./model-library.js";

describe("matchesMediaModelQuery", () => {
  const catalog = createMediaModelCatalogSnapshot({
    isOpenAiConfigured: true,
    isLocalFluxInstalled: true,
    isLocalBiRefNetInstalled: true,
  });

  it("matches terms across family, architecture, capability, and acquisition", () => {
    const flux = catalog.models.find(
      (model) => model.architecture === "flux-2",
    );
    expect(flux).toBeDefined();
    expect(
      matchesMediaModelQuery(flux!, "flux text image managed install"),
    ).toBe(true);
  });

  it("distinguishes bundled utilities from imported or managed models", () => {
    const borderMatte = catalog.models.find(
      (model) => model.id === "local:border-matte-v1",
    );
    expect(borderMatte).toBeDefined();
    expect(matchesMediaModelQuery(borderMatte!, "bundled transparency")).toBe(
      true,
    );
    expect(matchesMediaModelQuery(borderMatte!, "user imported")).toBe(false);
  });

  it("classifies generation models by their supported target", () => {
    const image = catalog.models.find(
      (model) => model.id === "local:flux-2-klein-4b",
    );
    const utility = catalog.models.find(
      (model) => model.id === "local:border-matte-v1",
    );
    expect(image).toBeDefined();
    expect(utility).toBeDefined();

    const video = { ...image!, capabilities: ["text-to-video"] as const };
    const svg = { ...image!, capabilities: ["text-to-svg"] as const };

    expect(mediaModelSupportsGenerationTarget(image!, "image")).toBe(true);
    expect(getMediaModelPrimaryGenerationTarget(video)).toBe("video");
    expect(getMediaModelPrimaryGenerationTarget(svg)).toBe("svg");
    expect(isMediaGenerationModel(utility!)).toBe(false);
    expect(getMediaModelPrimaryGenerationTarget(utility!)).toBeNull();
  });

  it("returns only ready models for generation selection", () => {
    const unconfiguredCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isLocalFluxInstalled: true,
    });
    const selectable = listSelectableMediaModels(unconfiguredCatalog.models, {
      target: "image",
    });

    expect(
      selectable.some((model) => model.id === "local:flux-2-klein-4b"),
    ).toBe(true);
    expect(selectable.some((model) => model.id === "openai:gpt-image-2")).toBe(
      false,
    );
    expect(selectable.every((model) => model.configured)).toBe(true);
  });

  it("keeps installed generation models manageable while excluding unused entries", () => {
    const configuredCatalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: true,
      isLocalFluxInstalled: true,
    });
    const flux = configuredCatalog.models.find(
      (model) => model.id === "local:flux-2-klein-4b",
    )!;
    const brokenInstalled = {
      ...flux,
      id: "local:broken",
      runtimeReadiness: "failed" as const,
    };
    const unusedCatalogEntry = {
      ...flux,
      id: "local:not-installed",
      installed: false,
      configured: false,
      installationStatus: "not-installed" as const,
    };
    const manageable = listManageableMediaGenerationModels([
      brokenInstalled,
      unusedCatalogEntry,
      ...configuredCatalog.models,
    ]);

    expect(manageable.some((model) => model.id === brokenInstalled.id)).toBe(
      true,
    );
    expect(manageable.some((model) => model.id === unusedCatalogEntry.id)).toBe(
      false,
    );
  });
});
