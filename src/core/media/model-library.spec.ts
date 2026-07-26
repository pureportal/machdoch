import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import { matchesMediaModelQuery } from "./model-library.js";

describe("matchesMediaModelQuery", () => {
  const catalog = createMediaModelCatalogSnapshot({
    isOpenAiConfigured: true,
    isLocalFluxInstalled: true,
    isLocalBiRefNetInstalled: true,
  });

  it("matches terms across family, architecture, capability, and acquisition", () => {
    const flux = catalog.models.find((model) => model.architecture === "flux-2");
    expect(flux).toBeDefined();
    expect(
      matchesMediaModelQuery(
        flux!,
        "flux text image managed install",
      ),
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
});
