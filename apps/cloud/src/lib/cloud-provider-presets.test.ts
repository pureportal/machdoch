import { describe, expect, it } from "vitest";
import { providerInputSchema } from "@machdoch/fleet-protocol/cloud-providers";
import {
  defaultProviderLimits,
  defaultProviderModels,
  providerChoices,
  providerModelChoices,
  splitProviderModels,
} from "./cloud-provider-presets";

describe("provider presets", () => {
  it("offers valid recommended models and defaults for every provider", () => {
    for (const provider of providerChoices) {
      const models = defaultProviderModels(provider);
      expect(models.length).toBeGreaterThan(0);
      expect(
        providerInputSchema.safeParse({
          name: provider,
          provider,
          region: provider === "langdock" ? "eu" : null,
          models,
          apiKey: provider.endsWith("-cli") ? "" : "key",
          ...defaultProviderLimits,
        }).success,
      ).toBe(true);
      const choices = providerModelChoices(provider).map((model) => model.id);
      expect(models.every((model) => choices.includes(model))).toBe(true);
    }
    expect(defaultProviderModels("claude-code-cli")).toEqual([
      "sonnet",
      "opus",
      "haiku",
    ]);
  });

  it("separates custom model identifiers from known ones", () => {
    expect(
      splitProviderModels("claude-code-cli", ["opus", "claude-opus-4-8"]),
    ).toEqual({ known: ["opus"], custom: ["claude-opus-4-8"] });
  });
});
