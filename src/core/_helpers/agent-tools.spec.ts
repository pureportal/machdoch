/// <reference types="vitest/globals" />
import { resolveActionDecision } from "./agent-tools.ts";
import type { RuntimeConfig } from "../types.js";

const createRuntimeConfig = (
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => {
  return {
    workspaceRoot: "c:/Development/machdoch",
    availableProfiles: [],
    mode: "ask",
    enabledTools: ["filesystem", "shell"],
    provider: "unconfigured",
    model: "gpt-5.4-mini",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability: [],
    webSearch: {
      activeProvider: "none",
      providerAvailability: [],
    },
    ...overrides,
  };
};

describe("resolveActionDecision", () => {
  it("blocks disabled tools before checking mode", () => {
    const decision = resolveActionDecision(
      createRuntimeConfig({ enabledTools: ["filesystem"] }),
      "shell",
      "low",
    );

    expect(decision.decision).toBe("blocked");
    expect(decision.reason).toContain("not enabled");
  });

  it("always requires approval in safe mode", () => {
    const decision = resolveActionDecision(
      createRuntimeConfig({ mode: "safe" }),
      "filesystem",
      "low",
    );

    expect(decision.decision).toBe("ask");
    expect(decision.reason).toContain("Safe mode");
  });

  it("allows only low-risk enabled tools in ask mode", () => {
    expect(
      resolveActionDecision(createRuntimeConfig(), "filesystem", "low")
        .decision,
    ).toBe("allow");
    expect(
      resolveActionDecision(createRuntimeConfig(), "shell", "high").decision,
    ).toBe("ask");
  });

  it("allows enabled tools in auto mode", () => {
    const decision = resolveActionDecision(
      createRuntimeConfig({ mode: "auto", enabledTools: ["network"] }),
      "network",
      "medium",
    );

    expect(decision.decision).toBe("allow");
    expect(decision.reason).toContain("Auto mode");
  });
});
