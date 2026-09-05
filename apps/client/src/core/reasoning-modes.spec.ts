import { PROVIDER_MODEL_METADATA } from "./provider-model-registry.js";
import {
  assertReasoningModeSupportedForProviderModel,
  getReasoningModesForProviderModel,
  normalizeReasoningModeForProviderModel,
} from "./reasoning-modes.js";

describe("provider model reasoning modes", () => {
  it("defines a non-empty default-first mode list for every curated model", () => {
    for (const model of PROVIDER_MODEL_METADATA) {
      const modes = getReasoningModesForProviderModel(model.provider, model.id);

      expect(modes[0]).toBe("default");
      expect(new Set(modes).size).toBe(modes.length);
    }
  });

  it("matches OpenAI reasoning effort support by model family", () => {
    expect(getReasoningModesForProviderModel("openai", "gpt-6-astra")).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getReasoningModesForProviderModel("openai", "gpt-5.6-sol")).toEqual([
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(getReasoningModesForProviderModel("openai", "gpt-5.5")).toEqual([
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getReasoningModesForProviderModel("openai", "gpt-5.6")).toContain(
      "ultra",
    );
    expect(
      getReasoningModesForProviderModel("openai", "gpt-5.6-terra"),
    ).toContain("ultra");
    expect(
      getReasoningModesForProviderModel("openai", "gpt-5.6-luna"),
    ).toContain("ultra");
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
    expect(getReasoningModesForProviderModel("openai", "gpt-5.5-pro")).toEqual([
      "default",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getReasoningModesForProviderModel("openai", "gpt-5.2")).toEqual([
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getReasoningModesForProviderModel("openai", "gpt-5.1")).toEqual([
      "default",
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(getReasoningModesForProviderModel("openai", "gpt-5-pro")).toEqual([
      "default",
      "high",
    ]);
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
    ).toEqual(["default", "low", "medium", "high"]);
    expect(
      getReasoningModesForProviderModel("google", "gemini-2.5-flash"),
    ).toEqual(["default", "none", "low", "medium", "high"]);
    expect(
      getReasoningModesForProviderModel("google", "gemini-3.7-flash"),
    ).toEqual(["default", "low", "medium", "high"]);
    expect(
      getReasoningModesForProviderModel("google", "gemini-3-pro-preview"),
    ).toEqual(["default", "low", "high"]);
    expect(
      getReasoningModesForProviderModel(
        "google",
        "gemini-3.1-flash-lite-image",
      ),
    ).toEqual(["default", "minimal", "high"]);
    expect(
      getReasoningModesForProviderModel("google", "gemini-3.1-flash-lite"),
    ).toEqual(["default", "minimal", "low", "medium", "high"]);
  });

  it("matches CLI provider effort switches", () => {
    expect(
      getReasoningModesForProviderModel("codex-cli", "gpt-6-astra"),
    ).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "aeon",
    ]);
    expect(
      getReasoningModesForProviderModel("codex-cli", "gpt-5.6-terra"),
    ).toEqual(["default", "none", "low", "medium", "high", "xhigh", "max"]);
    expect(getReasoningModesForProviderModel("codex-cli", "gpt-5.5")).toEqual([
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(
      getReasoningModesForProviderModel("codex-cli", "gpt-5.4-pro"),
    ).toEqual(["default", "medium", "high", "xhigh"]);
    expect(getReasoningModesForProviderModel("codex-cli", "gpt-5.2")).toEqual([
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getReasoningModesForProviderModel("claude-cli", "sonnet")).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "max",
    ]);
    expect(getReasoningModesForProviderModel("claude-cli", "default")).toEqual([
      "default",
    ]);
    expect(getReasoningModesForProviderModel("copilot-cli", "auto")).toEqual([
      "default",
    ]);
  });

  it("does not silently translate unsupported modes", () => {
    expect(
      normalizeReasoningModeForProviderModel(
        "aeon",
        "codex-cli",
        "gpt-6-astra",
      ),
    ).toBe("aeon");
    expect(
      normalizeReasoningModeForProviderModel("aeon", "openai", "gpt-6-astra"),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel("ultra", "openai", "gpt-5.6-sol"),
    ).toBe("ultra");
    expect(
      normalizeReasoningModeForProviderModel("ultra", "openai", "gpt-5.5"),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel(
        "ultra",
        "anthropic",
        "claude-sonnet-5",
      ),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel(
        "ultra",
        "google",
        "gemini-3.5-flash",
      ),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel(
        "ultra",
        "langdock",
        "gpt-5.6-sol",
      ),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel("max", "openai", "gpt-5.5"),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel("none", "openai", "gpt-5"),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel(
        "xhigh",
        "anthropic",
        "claude-sonnet-4-6",
      ),
    ).toBe("default");
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
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel(
        "none",
        "google",
        "gemini-2.5-pro",
      ),
    ).toBe("default");
    expect(
      normalizeReasoningModeForProviderModel("none", "codex-cli", "gpt-5.5"),
    ).toBe("none");
    expect(
      normalizeReasoningModeForProviderModel("low", "copilot-cli", "auto"),
    ).toBe("default");
  });

  it("rejects unsupported execution settings and honors discovered effort lists", () => {
    expect(() =>
      assertReasoningModeSupportedForProviderModel(
        "ultra",
        "openai",
        "gpt-5.6-terra",
      ),
    ).not.toThrow();
    expect(
      getReasoningModesForProviderModel("codex-cli", "gpt-6-astra", [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
        "persistent",
      ]),
    ).toEqual([
      "default",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "aeon",
    ]);
    expect(
      getReasoningModesForProviderModel("copilot-cli", "dynamic-model", [
        "low",
        "high",
        "ultra",
        "provider-only-value",
      ]),
    ).toEqual(["default", "low", "high"]);
    expect(
      getReasoningModesForProviderModel("codex-cli", "gpt-5.6-sol", [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]),
    ).toEqual([
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });
});
