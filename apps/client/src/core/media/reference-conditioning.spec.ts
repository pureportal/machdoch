import { describe, expect, it } from "vitest";
import { createMediaModelCatalog } from "./catalog.js";
import type { MediaModelDescriptor } from "./contracts.js";
import {
  getMediaReferenceConditioningCapabilities,
  mediaModelSupportsReferenceRole,
} from "./reference-conditioning.js";

const localFlux = createMediaModelCatalog({
  isOpenAiConfigured: false,
  isLocalFluxInstalled: true,
}).find((model) => model.id === "local:flux-2-klein-4b")!;

describe("local reference conditioning capabilities", () => {
  it("offers KREA vision references with fixed influence", () => {
    const krea = {
      ...localFlux,
      architecture: "krea-2",
    } as const satisfies MediaModelDescriptor;

    expect(getMediaReferenceConditioningCapabilities(krea)).toEqual({
      roles: ["subject", "style", "composition", "palette", "detail"],
      maximumReferenceImages: 3,
      adjustableInfluence: false,
      promptless: true,
    });
    expect(mediaModelSupportsReferenceRole(krea, "subject")).toBe(true);
  });

  it("accepts generic FLUX.2 reference images without per-reference weights", () => {
    expect(getMediaReferenceConditioningCapabilities(localFlux)).toMatchObject({
      roles: ["subject", "style", "composition", "palette", "detail"],
      maximumReferenceImages: 7,
      adjustableInfluence: false,
      promptless: true,
    });
    expect(mediaModelSupportsReferenceRole(localFlux, "subject")).toBe(true);
    expect(mediaModelSupportsReferenceRole(localFlux, "style")).toBe(true);
    expect(mediaModelSupportsReferenceRole(localFlux, "detail")).toBe(true);
  });
});
