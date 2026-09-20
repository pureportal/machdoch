import { describe, expect, it } from "vitest";
import {
  createLocalBiRefNetInstallPlan,
  createLocalBiRefNetManifestDigest,
  createLocalBiRefNetReviewToken,
  createLocalFluxInstallPlan,
  createLocalFluxManifestDigest,
  createLocalFluxReviewToken,
  LOCAL_FLUX_INSTALL_FILES,
  LOCAL_FLUX_REQUIRED_WORKING_BYTES,
  LOCAL_FLUX_TOTAL_BYTES,
  LOCAL_BIREFNET_INSTALL_FILES,
  LOCAL_BIREFNET_REQUIRED_WORKING_BYTES,
  LOCAL_BIREFNET_TOTAL_BYTES,
} from "./model-install.js";

describe("reviewed local model installation", () => {
  it("uses the exact pinned Diffusers allowlist", () => {
    expect(LOCAL_FLUX_INSTALL_FILES).toHaveLength(19);
    expect(LOCAL_FLUX_TOTAL_BYTES).toBe(15_980_141_329);
    expect(LOCAL_FLUX_REQUIRED_WORKING_BYTES).toBe(17_897_758_289);
    expect(createLocalFluxManifestDigest()).toBe(
      "8347f47cece38f870d09ab6cc5f0bec5340d70ee6549bc44e7d767f78e41175b",
    );
  });

  it("binds the review token to the manifest digest", () => {
    expect(createLocalFluxReviewToken()).not.toBe(
      createLocalFluxReviewToken("tampered"),
    );
  });

  it("pins the official BiRefNet matting ONNX release and license", () => {
    expect(LOCAL_BIREFNET_INSTALL_FILES).toHaveLength(2);
    expect(LOCAL_BIREFNET_TOTAL_BYTES).toBe(972_668_808);
    expect(LOCAL_BIREFNET_REQUIRED_WORKING_BYTES).toBe(1_089_389_065);
    expect(createLocalBiRefNetManifestDigest()).toBe(
      "dd8c3ef7eb3b12e12c899c6f5c480d487aa78cf186c203ba75f872c6edd7eda8",
    );
    expect(createLocalBiRefNetReviewToken()).not.toBe(
      createLocalBiRefNetReviewToken("tampered"),
    );
    expect(createLocalBiRefNetInstallPlan()).toMatchObject({
      modelId: "local:birefnet-matting",
      revision: "a0cf9925880620000aa2d1948d61bf659ddfdfaa",
      license: { spdxId: "MIT", requiresAcceptance: true },
    });
  });

  it("reports disk sufficiency without rounding bytes", () => {
    expect(
      createLocalFluxInstallPlan({
        availableBytes: LOCAL_FLUX_REQUIRED_WORKING_BYTES - 1,
      }).hasSufficientSpace,
    ).toBe(false);
    expect(
      createLocalFluxInstallPlan({
        availableBytes: LOCAL_FLUX_REQUIRED_WORKING_BYTES,
      }).hasSufficientSpace,
    ).toBe(true);
  });
});
