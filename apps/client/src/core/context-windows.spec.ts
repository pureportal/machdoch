import {
  parseContextWindow,
  resolveClaudeCliModelForContextWindow,
  resolveContextWindowForProviderModel,
} from "./context-windows.js";
import { replaceDiscoveredModelCapabilities } from "@machdoch/model-runtime/model-capabilities";

afterEach(() => {
  replaceDiscoveredModelCapabilities("codex-cli", []);
  replaceDiscoveredModelCapabilities("copilot-cli", []);
});

describe("provider context presets", () => {
  it("parses presets and rejects custom token counts", () => {
    expect(parseContextWindow("default")).toBe("default");
    expect(parseContextWindow(" HIGHEST ")).toBe("highest");
    expect(parseContextWindow("lowest")).toBe("lowest");
    for (const value of ["long", "1050000", 400_000, "automatic"])
      expect(parseContextWindow(value)).toBeUndefined();
  });

  it("uses discovered Codex limits without mutating the selected preset", () => {
    replaceDiscoveredModelCapabilities("codex-cli", [
      {
        id: "large",
        capabilities: {
          contextWindowTokens: 272_000,
          longContextWindowTokens: 872_000,
        },
      },
      {
        id: "small",
        capabilities: {
          contextWindowTokens: 64_000,
          longContextWindowTokens: 128_000,
        },
      },
      {
        id: "fixed",
        capabilities: {
          contextWindowTokens: 64_000,
          longContextWindowTokens: 64_000,
        },
      },
    ]);
    expect(
      resolveContextWindowForProviderModel("highest", "codex-cli", "large"),
    ).toBe(872_000);
    expect(
      resolveContextWindowForProviderModel("highest", "codex-cli", "small"),
    ).toBe(128_000);
    expect(
      resolveContextWindowForProviderModel("highest", "codex-cli", "fixed"),
    ).toBe("default");
    expect(
      resolveContextWindowForProviderModel("lowest", "codex-cli", "small"),
    ).toBe(64_000);
    expect(
      resolveContextWindowForProviderModel("default", "codex-cli", "large"),
    ).toBe("default");
  });

  it("uses only supported Copilot tiers and leaves API providers at their fixed size", () => {
    replaceDiscoveredModelCapabilities("copilot-cli", [
      {
        id: "tiered",
        capabilities: {
          contextWindowTokens: 200_000,
          longContextWindowTokens: 1_000_000,
        },
      },
      { id: "fixed", capabilities: { contextWindowTokens: 200_000 } },
    ]);
    expect(
      resolveContextWindowForProviderModel("highest", "copilot-cli", "tiered"),
    ).toBe("long");
    expect(
      resolveContextWindowForProviderModel("lowest", "copilot-cli", "tiered"),
    ).toBe("default");
    expect(
      resolveContextWindowForProviderModel("highest", "copilot-cli", "fixed"),
    ).toBe("default");
    expect(
      resolveContextWindowForProviderModel("highest", "openai", "gpt-6-astra"),
    ).toBe("default");
  });

  it("maps Claude highest to its long-context suffix and lowest to its base model", () => {
    expect(resolveClaudeCliModelForContextWindow("sonnet", "highest")).toBe(
      "sonnet[1m]",
    );
    expect(resolveClaudeCliModelForContextWindow("sonnet[1m]", "highest")).toBe(
      "sonnet[1m]",
    );
    expect(resolveClaudeCliModelForContextWindow("sonnet[1m]", "lowest")).toBe(
      "sonnet",
    );
    expect(resolveClaudeCliModelForContextWindow("sonnet", "default")).toBe(
      "sonnet",
    );
    expect(resolveClaudeCliModelForContextWindow("haiku", "highest")).toBe(
      "haiku",
    );
  });
});
