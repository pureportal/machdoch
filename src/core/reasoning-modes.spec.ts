import { PROVIDER_MODEL_METADATA } from "./provider-model-registry.js";
import {
  getReasoningModesForProviderModel,
  normalizeReasoningModeForProviderModel,
} from "./reasoning-modes.js";

describe("provider model reasoning modes", () => {
  it("defines a non-empty default-first mode list for every curated model", () => {
    for (const model of PROVIDER_MODEL_METADATA) {
      const modes = getReasoningModesForProviderModel(
        model.provider,
        model.id,
      );

      expect(modes[0]).toBe("default");
      expect(new Set(modes).size).toBe(modes.length);
    }
  });

  it("matches OpenAI reasoning effort support by model family", () => {
    expect(getReasoningModesForProviderModel("openai", "gpt-5.5")).toEqual([
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getReasoningModesForProviderModel("openai", "gpt-5")).toEqual([
      "default",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(
      getReasoningModesForProviderModel("openai", "gpt-5.4-mini"),
    ).not.toContain("max");
  });

  it("matches Anthropic effort levels by Claude model", () => {
    expect(
      getReasoningModesForProviderModel("anthropic", "claude-opus-4-8"),
    ).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(
      getReasoningModesForProviderModel("anthropic", "claude-sonnet-5"),
    ).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(
      getReasoningModesForProviderModel("anthropic", "claude-sonnet-4-6"),
    ).toEqual(["default", "low", "medium", "high", "max"]);
    expect(
      getReasoningModesForProviderModel("anthropic", "claude-haiku-4-5"),
    ).toEqual(["default"]);
  });

  it("matches Gemini thinking controls by model generation", () => {
    expect(
      getReasoningModesForProviderModel("google", "gemini-3.5-flash"),
    ).toEqual(["default", "minimal", "low", "medium", "high"]);
    expect(
      getReasoningModesForProviderModel("google", "gemini-3.1-pro-preview"),
    ).toEqual(["default", "low", "medium", "high"]);
    expect(
      getReasoningModesForProviderModel("google", "gemini-2.5-pro"),
    ).toEqual(["default", "minimal", "low", "medium", "high"]);
    expect(
      getReasoningModesForProviderModel("google", "gemini-2.5-flash"),
    ).toEqual(["default", "none", "minimal", "low", "medium", "high"]);
  });

  it("matches CLI provider effort switches", () => {
    expect(getReasoningModesForProviderModel("codex-cli", "gpt-5.5")).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(
      getReasoningModesForProviderModel("claude-cli", "sonnet"),
    ).toEqual(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(getReasoningModesForProviderModel("copilot-cli", "auto")).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("normalizes stale or unsupported modes to provider-safe values", () => {
    expect(
      normalizeReasoningModeForProviderModel("max", "openai", "gpt-5.5"),
    ).toBe("xhigh");
    expect(
      normalizeReasoningModeForProviderModel("none", "openai", "gpt-5"),
    ).toBe("minimal");
    expect(
      normalizeReasoningModeForProviderModel(
        "xhigh",
        "anthropic",
        "claude-sonnet-4-6",
      ),
    ).toBe("high");
    expect(
      normalizeReasoningModeForProviderModel(
        "high",
        "anthropic",
        "claude-haiku-4-5",
      ),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel(
        "minimal",
        "google",
        "gemini-3.1-pro-preview",
      ),
    ).toBe("low");
    expect(
      normalizeReasoningModeForProviderModel(
        "none",
        "google",
        "gemini-2.5-pro",
      ),
    ).toBe("minimal");
    expect(
      normalizeReasoningModeForProviderModel("none", "codex-cli", "gpt-5.5"),
    ).toBe("low");
  });
});
