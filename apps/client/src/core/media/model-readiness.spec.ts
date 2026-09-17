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
  it("enables Codex image generation independently of an OpenAI API key", () => {
    const catalog = createMediaModelCatalogSnapshot({
      isOpenAiConfigured: false,
      isCodexCliConfigured: true,
    });
    const codex = catalog.models.find(
      (model) => model.id === "codex-cli:image-generation",
    )!;
    expect(isMediaModelReady(codex)).toBe(true);
    expect(codex.packageType).toBe("agent-cli");
    expect(codex.capabilities).toEqual(["text-to-image"]);
    expect(
      isMediaModelReady(
        catalog.models.find((model) => model.providerId === "openai")!,
      ),
    ).toBe(false);
    expect(isMediaModelReady({ ...codex, configured: false })).toBe(false);
  });
  it("uses advertised runtime readiness without provider-name conditionals", () => {
    const flux = models().find((model) => model.id === "local:flux-2-klein-4b");
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
      (model) => model.id === "openai:gpt-image-2.5-sunburst",
    )!;
    expect(inspectMediaModelReadiness(remote).issue).toBe(
      "provider-unconfigured",
    );
  });
});
