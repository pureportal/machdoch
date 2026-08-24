import {
  assertContextWindowSupportedForProviderModel,
  parseContextWindow,
  resolveClaudeCliModelForContextWindow,
  supportsLongContextWindow,
} from "./context-windows.js";
import { replaceDiscoveredModelCapabilities } from "./model-capabilities.js";

describe("provider context windows", () => {
  it("parses canonical modes and bounded numeric token counts", () => {
    expect(parseContextWindow("default")).toBe("default");
    expect(parseContextWindow(" LONG ")).toBe("long");
    expect(parseContextWindow("1050000")).toBe(1_050_000);
    expect(parseContextWindow(400_000)).toBe(400_000);
    expect(parseContextWindow("0")).toBeUndefined();
    expect(parseContextWindow("10000001")).toBeUndefined();
    expect(parseContextWindow("automatic")).toBeUndefined();
  });

  it("limits provider-controlled context tiers to supported CLI providers", () => {
    expect(supportsLongContextWindow("copilot-cli", "auto")).toBe(true);
    expect(supportsLongContextWindow("claude-cli", "sonnet")).toBe(true);
    expect(supportsLongContextWindow("claude-cli", "haiku")).toBe(false);
    expect(() =>
      assertContextWindowSupportedForProviderModel(
        "long",
        "openai",
        "gpt-5.6-sol",
      ),
    ).toThrow("Long context is not supported");
  });

  it("uses Copilot SDK metadata to reject models without a long-context tier", () => {
    replaceDiscoveredModelCapabilities("copilot-cli", [
      {
        id: "with-long-context",
        capabilities: { longContextWindowTokens: 1_000_000 },
      },
      {
        id: "without-long-context",
        capabilities: { longContextWindowTokens: null },
      },
    ]);

    expect(supportsLongContextWindow("copilot-cli", "with-long-context")).toBe(
      true,
    );
    expect(
      supportsLongContextWindow("copilot-cli", "without-long-context"),
    ).toBe(false);
    expect(() =>
      assertContextWindowSupportedForProviderModel(
        "long",
        "copilot-cli",
        "without-long-context",
      ),
    ).toThrow("Long context is not supported");
  });

  it("uses numeric windows only for Codex and enforces discovered limits", () => {
    expect(() =>
      assertContextWindowSupportedForProviderModel(
        400_000,
        "codex-cli",
        "gpt-5.4-mini",
        400_000,
      ),
    ).not.toThrow();
    expect(() =>
      assertContextWindowSupportedForProviderModel(
        400_001,
        "codex-cli",
        "gpt-5.4-mini",
        400_000,
      ),
    ).toThrow("exceeds the discovered 400000-token limit");
    expect(() =>
      assertContextWindowSupportedForProviderModel(
        400_000,
        "copilot-cli",
        "gpt-5.4",
      ),
    ).toThrow("cannot be configured");
  });

  it("maps Claude long context to the documented model suffix", () => {
    expect(resolveClaudeCliModelForContextWindow("sonnet", "long")).toBe(
      "sonnet[1m]",
    );
    expect(resolveClaudeCliModelForContextWindow("sonnet[1m]", "long")).toBe(
      "sonnet[1m]",
    );
    expect(resolveClaudeCliModelForContextWindow("sonnet", "default")).toBe(
      "sonnet",
    );
  });
});
