import { describe, expect, it } from "vitest";
import type { AgentModelToolSpec } from "../types.js";
import { resolveProviderPromptCacheDirectives } from "./provider-prompt-cache.js";

const tools: AgentModelToolSpec[] = [
  {
    name: "read_file",
    description: "Read a file",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

describe("provider prompt cache directives", () => {
  it("creates a stable bounded OpenAI cache key from the reusable prefix", () => {
    const first = resolveProviderPromptCacheDirectives(
      "openai",
      "gpt-5.4",
      "Stable system instructions",
      tools,
    );
    const second = resolveProviderPromptCacheDirectives(
      "openai",
      "gpt-5.4",
      "Stable system instructions",
      structuredClone(tools),
    );
    const changed = resolveProviderPromptCacheDirectives(
      "openai",
      "gpt-5.4",
      "Changed system instructions",
      tools,
    );

    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.cacheKey).not.toBe(changed.cacheKey);
    expect(first.cacheKey?.length).toBeLessThanOrEqual(64);
    expect(first.cacheSystemPrompt).toBe(false);
  });

  it("uses explicit cache breakpoints only for native Anthropic requests", () => {
    expect(
      resolveProviderPromptCacheDirectives(
        "anthropic",
        "claude-sonnet-4-6",
        "Stable system instructions",
        tools,
      ),
    ).toEqual({ cacheSystemPrompt: true });
    expect(
      resolveProviderPromptCacheDirectives(
        "langdock",
        "claude-sonnet-4-6",
        "Stable system instructions",
        tools,
      ),
    ).toEqual({ cacheSystemPrompt: false });
  });

  it("leaves providers with automatic or provider-managed caching untouched", () => {
    for (const provider of [
      "google",
      "codex-cli",
      "claude-cli",
      "copilot-cli",
    ] as const) {
      expect(
        resolveProviderPromptCacheDirectives(
          provider,
          "fixture-model",
          "Stable system instructions",
          tools,
        ),
      ).toEqual({ cacheSystemPrompt: false });
    }
  });
});
