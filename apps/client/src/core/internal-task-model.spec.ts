import { describe, expect, it } from "vitest";
import {
  parseInternalTaskStructuredOutput,
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
  contextWindow: "default",
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
    reasoning: "low",
  },
  ...overrides,
});

describe("internal task runtime model", () => {
  it("uses the configured internal-task reasoning", () => {
    const config = createConfig({
      reasoning: "high",
      internalTaskModel: {
        provider: "anthropic",
        model: "claude-sonnet-5",
        reasoning: "low",
      },
    });

    expect(resolveInternalTaskRuntimeConfig(config)).toEqual({
      ...config,
      provider: "anthropic",
      model: "claude-sonnet-5",
      reasoning: "low",
    });
  });

  it("normalizes reasoning for the selected internal task model", () => {
    const config = createConfig({
      reasoning: "ultra",
      internalTaskModel: {
        provider: "codex-cli",
        model: "gpt-5.6-terra",
        reasoning: "ultra",
      },
    });

    expect(resolveInternalTaskRuntimeConfig(config)?.reasoning).toBe("default");
  });

  it("does not fall back to the primary task model", () => {
    const config = createConfig({
      internalTaskModel: {
        provider: "unconfigured",
        model: "gpt-primary",
        reasoning: "default",
      },
    });

    expect(resolveInternalTaskRuntimeConfig(config)).toBeNull();
    expect(() => requireInternalTaskRuntimeConfig(config)).toThrow(
      "Choose an internal task model",
    );
  });

  it("validates structured internal-task results before use", () => {
    const structuredOutput = {
      name: "memory_decisions",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          memories: { type: "array", items: { type: "string" } },
        },
        required: ["memories"],
      },
      strict: true,
    };

    expect(
      parseInternalTaskStructuredOutput<{ memories: string[] }>(
        '{"memories":["fact"]}',
        structuredOutput,
      ),
    ).toEqual({ memories: ["fact"] });
    expect(() =>
      parseInternalTaskStructuredOutput(
        '{"memories":"fact"}',
        structuredOutput,
      ),
    ).toThrow("does not match memory_decisions");
  });
});
