import { describe, expect, it } from "vitest";
import { createMediaModelCatalogSnapshot } from "./catalog.js";
import {
  inspectMediaModelReadiness,
  isMediaModelReady,
} from "./model-readiness.js";

const models = () =>
  createMediaModelCatalogSnapshot({
    isOpenAiConfigured: false,
    isLocalFluxInstalled: true,
  }).models;

describe("media model readiness", () => {
  it("uses advertised runtime readiness without provider-name conditionals", () => {
    const flux = models().find(
      (model) => model.id === "local:flux-2-klein-4b",
    );
    expect(flux).toBeDefined();
    expect(isMediaModelReady(flux!)).toBe(true);

    const futureProviderModel = {
      ...flux!,
      id: "future:flux-3",
      providerId: "future-runtime",
      runtimeReadiness: "runtime-unavailable" as const,
    };
    expect(inspectMediaModelReadiness(futureProviderModel)).toMatchObject({
      ready: false,
      issue: "runtime-unavailable",
    });
  });

  it("distinguishes acquisition, verification, and provider configuration", () => {
    const flux = models().find(
      (model) => model.id === "local:flux-2-klein-4b",
    )!;
    expect(
      inspectMediaModelReadiness({
        ...flux,
        installed: false,
        installationStatus: "not-installed",
      }).issue,
    ).toBe("not-installed");
    expect(
      inspectMediaModelReadiness({
        ...flux,
        runtimeReadiness: "unverified",
      }).issue,
    ).toBe("verification-required");

    const remote = models().find(
      (model) => model.id === "openai:gpt-image-2",
    )!;
    expect(inspectMediaModelReadiness(remote).issue).toBe(
      "provider-unconfigured",
    );
  });
});
