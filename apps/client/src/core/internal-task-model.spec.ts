import { describe, expect, it } from "vitest";
import {
  requireInternalTaskRuntimeConfig,
  resolveInternalTaskRuntimeConfig,
} from "./internal-task-model.js";
import type { RuntimeConfig } from "./runtime-contract.generated.js";

const createConfig = (
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => ({
  workspaceRoot: "C:/workspace",
  mode: "machdoch",
  provider: "openai",
  model: "gpt-primary",
  reasoning: "default",
  offline: false,
  compatibility: { discoverGithubCustomizations: false },
  providerAvailability: [
    { provider: "openai", configured: true },
    { provider: "anthropic", configured: true },
  ],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider: "anthropic",
    model: "claude-internal",
  },
  ...overrides,
});

describe("internal task runtime model", () => {
  it("replaces only the provider and model used for an internal operation", () => {
    const config = createConfig();

    expect(resolveInternalTaskRuntimeConfig(config)).toEqual({
      ...config,
      provider: "anthropic",
      model: "claude-internal",
    });
  });

  it("does not fall back to the primary task model", () => {
    const config = createConfig({
      internalTaskModel: {
        provider: "unconfigured",
        model: "gpt-primary",
      },
    });

    expect(resolveInternalTaskRuntimeConfig(config)).toBeNull();
    expect(() => requireInternalTaskRuntimeConfig(config)).toThrow(
      "Choose an internal task model",
    );
  });
});
