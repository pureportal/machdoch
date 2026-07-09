import {
  DEFAULT_MODEL_BY_PROVIDER,
  findProviderModelMetadata,
  getDefaultModelForProvider,
  getProviderCatalogMetadata,
  getProviderModelMetadata,
  PROVIDER_MODEL_METADATA,
  type ConfiguredModelProvider,
} from "./provider-model-registry.js";

describe("provider model registry", () => {
  it("returns the contract default model for each configured provider", () => {
    for (const provider of Object.keys(
      DEFAULT_MODEL_BY_PROVIDER,
    ) as ConfiguredModelProvider[]) {
      expect(getDefaultModelForProvider(provider)).toBe(
        DEFAULT_MODEL_BY_PROVIDER[provider],
      );
    }
  });

  it("returns catalog metadata for known providers", () => {
    expect(getProviderCatalogMetadata("openai")).toMatchObject({
      provider: "openai",
      docsUrl: expect.stringContaining("openai"),
    });
    expect(getProviderCatalogMetadata("google")).toMatchObject({
      provider: "google",
      docsUrl: expect.stringContaining("gemini"),
    });
  });

  it("groups curated model metadata by provider", () => {
    const openAiModels = getProviderModelMetadata("openai");

    expect(openAiModels.length).toBeGreaterThan(0);
    expect(openAiModels.every((model) => model.provider === "openai")).toBe(
      true,
    );
    expect(openAiModels).toEqual(
      PROVIDER_MODEL_METADATA.filter((model) => model.provider === "openai"),
    );
  });

  it("includes the GPT-5.6 family in OpenAI and Codex CLI fallbacks", () => {
    for (const provider of ["openai", "codex-cli"] as const) {
      expect(
        getProviderModelMetadata(provider).find(
          (model) => model.id === "gpt-5.6",
        ),
      ).toMatchObject({
        label: "GPT-5.6 (Sol)",
        lifecycle: "stable",
      });
      const models = getProviderModelMetadata(provider).filter((model) =>
        model.id.startsWith("gpt-5.6-"),
      );

      expect(models.map((model) => model.id)).toEqual([
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
      ]);
      expect(
        models.every(
          (model) =>
            model.lifecycle === "stable" &&
            model.capabilities.imageInput &&
            model.capabilities.computerUse &&
            model.capabilities.contextWindowTokens === 1_050_000 &&
            model.capabilities.maxOutputTokens === 128_000,
        ),
      ).toBe(true);
    }
  });

  it("finds provider model metadata with normalized model ids", () => {
    expect(findProviderModelMetadata("openai", "  GPT-5.5  ")).toMatchObject({
      provider: "openai",
      id: "gpt-5.5",
    });
    expect(
      findProviderModelMetadata("anthropic", "\nCLAUDE-OPUS-4-8\t"),
    ).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-8",
    });
  });

  it("does not match models from a different provider", () => {
    expect(
      findProviderModelMetadata("google", "claude-opus-4-8"),
    ).toBeUndefined();
  });

  it.each(["", "   ", "unknown-model"])(
    "returns undefined for missing model id %s",
    (model) => {
      expect(findProviderModelMetadata("openai", model)).toBeUndefined();
    },
  );
});
